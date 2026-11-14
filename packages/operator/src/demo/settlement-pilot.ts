import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Account, actions, baseEncode, KeyPair, KeyPairSigner, nearToYocto, teraToGas } from "near-api-js";
import type { JsonRpcProvider } from "near-api-js";
import { UnknownTransactionError, UnknownTransactionOrReceiptError } from "near-api-js/rpc-errors";
import { isSandboxNetwork, isTestnetAccount } from "../../../shared/oracle-protocol.ts";
import { assessQuorumWindow, verifyEvidenceBundle } from "../monitoring/evidence.ts";
import { collectEvidence, hashEndpoint, LOCAL_DEMO_ENDPOINT } from "../monitoring/monitor.ts";
import type { Agreement } from "../oracles/oracle-flow.ts";
import { prepareVoteSender } from "../oracles/oracle-signer.ts";
import { verifySettlement } from "../settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../settlement/settlement.ts";

type PilotAgreement = Agreement & SettlementState & {
  provider: string;
  down_quorum: number;
  min_down_slots: number;
  confirmed_down_slots: number;
  possible_down_slots: number;
};

interface Scenario {
  oracles: number;
  quorum: number;
  slots: number;
  threshold: number;
  verdict: ReturnType<typeof assessQuorumWindow>;
  httpStatus: (observer: number, slot: number) => number;
}

const outage = (slot: number) => slot >= 2 && slot < 7;
const scenarios: readonly Scenario[] = [
  {
    oracles: 3, quorum: 2, slots: 8, threshold: 5,
    verdict: { outcome: "breach", confirmed: 5, possible: 5 },
    httpStatus: (_observer, slot) => outage(slot) ? 503 : 200,
  },
  {
    oracles: 5, quorum: 3, slots: 4, threshold: 4,
    verdict: { outcome: "inconclusive", confirmed: 2, possible: 4 },
    httpStatus: (observer, slot) => (slot < 2 ? observer < 3 : observer >= 2) ? 503 : 429,
  },
  {
    oracles: 7, quorum: 5, slots: 8, threshold: 5,
    verdict: { outcome: "breach", confirmed: 5, possible: 5 },
    httpStatus: (observer, slot) => !outage(slot) ? 200 : observer < 5 ? 503 : 429,
  },
];
const rosterSize = Math.max(...scenarios.map(({ oracles }) => oracles));
const escrowFunding = nearToYocto("2.5");
const providerFunding = nearToYocto("0.45");
const actorFunding = nearToYocto("0.2");
const payout = nearToYocto("0.1");
export const pilotAllocation = escrowFunding + providerFunding + BigInt(rosterSize + 1) * actorFunding;
export const pilotMinimumFunding = nearToYocto("5");

export function checkPilotWasm(wasm: Uint8Array<ArrayBuffer>, expectedSha256?: string) {
  assert.ok(wasm.byteLength <= 200_000 && WebAssembly.validate(wasm), "Expected a valid Wasm module of at most 200,000 bytes");
  const digest = createHash("sha256").update(wasm).digest();
  const sha256 = digest.toString("hex");
  if (expectedSha256 !== undefined) assert.equal(sha256, expectedSha256, "Wasm SHA-256 mismatch");
  const exports = new Set(WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map(({ name }) => name));
  assert.ok(exports.has("new") && exports.has("storage_deposit")
    && !exports.has("schedule_missing_recipient") && !exports.has("schedule_unresolved_payment"),
    "Expected the escrow V2 interface and a default-feature build");
  return { wasm, sha256, codeHash: baseEncode(digest) };
}

interface PilotOptions {
  artifact: ReturnType<typeof checkPilotWasm>;
  root: Account;
  provider: JsonRpcProvider;
  receiptProvider: JsonRpcProvider;
  network: string;
  startDelayMs: number;
  slotMs: number;
  progress: (message: string) => void;
}

export async function runSettlementPilot({
  artifact, root, provider, receiptProvider, network, startDelayMs, slotMs, progress,
}: PilotOptions) {
  assert.ok((network === "testnet" && isTestnetAccount(root.accountId)) || isSandboxNetwork(network),
    "Use a dedicated Testnet sponsor or an isolated Sandbox");
  const target = new URL(LOCAL_DEMO_ENDPOINT);
  const prefix = "v2-" + randomBytes(5).toString("hex");
  let responseFor: ((observer: string, now: number) => number) | undefined;
  const health = createServer((request, response) => {
    const observer = request.headers["x-sla-pilot-observer"];
    const status = request.method === "GET" && request.url === target.pathname && typeof observer === "string"
      ? responseFor?.(observer, Date.now()) ?? 404 : 404;
    response.writeHead(status, { "Cache-Control": "no-store" }).end();
  });

  const chainTime = async () => Number(
    BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec) / 1_000_000n,
  );
  async function provision(role: string, funding: bigint) {
    const id = `${prefix}-${role}.${root.accountId}`;
    const key = KeyPair.fromRandom("ed25519");
    progress(`Creating ${role} ${id}`);
    await root.signAndSendTransaction({
      receiverId: id, waitUntil: "FINAL", retries: 0,
      actions: [actions.createAccount(), actions.transfer(funding), actions.addFullAccessKey(key.getPublicKey())],
    });
    return new Account(id, provider, new KeyPairSigner(key));
  }

  health.listen(Number(target.port), target.hostname);
  await once(health, "listening");
  try {
    const escrow = await provision("escrow", escrowFunding);
    const supplier = await provision("provider", providerFunding);
    const customer = await provision("customer", actorFunding);
    const contractId = escrow.accountId;
    const finality = { finality: "final" } as const;
    const deployment = await escrow.signAndSendTransaction({
      receiverId: contractId, waitUntil: "FINAL", retries: 0,
      actions: [actions.deployContract(artifact.wasm), actions.functionCall("new", {}, teraToGas("40"), 0n)],
    });
    progress(`Deployment transaction ${deployment.transaction_outcome.id}`);
    const account = await provider.viewAccount({ accountId: contractId, blockQuery: finality });
    assert.equal(account.code_hash, artifact.codeHash, "Deployed code differs from the checked artifact");
    async function view<T extends object | string>(method: string, args: Record<string, unknown>) {
      const result = await provider.callFunction<T>({ contractId, method, args, blockQuery: finality });
      assert.ok(result != null, `Missing ${method} result`);
      return result;
    }
    assert.equal(await view<string>("agreement_count", {}), "0");

    const voters: { id: string; send: Awaited<ReturnType<typeof prepareVoteSender>> }[] = [];
    for (let i = 0; i < rosterSize; i++) {
      const oracle = await provision(`o${i + 1}`, actorFunding);
      const key = KeyPair.fromRandom("ed25519");
      await oracle.signAndSendTransaction({
        receiverId: oracle.accountId, waitUntil: "FINAL", retries: 0,
        actions: [actions.addFunctionCallAccessKey(key.getPublicKey(), contractId, ["submit_vote"], nearToYocto("0.12"))],
      });
      voters.push({
        id: oracle.accountId,
        send: await prepareVoteSender(provider, contractId, oracle.accountId, key.toString()),
      });
    }
    const endpointHash = await hashEndpoint(LOCAL_DEMO_ENDPOINT, { localDemo: true });
    const results = [];
    for (const scenario of scenarios) {
      const roster = voters.slice(0, scenario.oracles);
      const oracles = roster.map(({ id }) => id);
      const storage = BigInt(await view<string>("storage_deposit", { oracle_count: oracles.length }));
      const blockTime = await chainTime();
      assert.ok(Math.abs(Date.now() - blockTime) < 30_000, "Local clock or finalized RPC time differs by 30 seconds");
      const start = Math.max(Date.now(), blockTime) + startDelayMs;
      const end = start + scenario.slots * slotMs;
      const graceMs = 180_000;
      const terms = {
        customer: customer.accountId, oracles, down_quorum: scenario.quorum, endpoint_hash: endpointHash,
        starts_at_ms: String(start), slot_ms: slotMs, slot_count: scenario.slots,
        min_down_slots: scenario.threshold, reporting_grace_ms: graceMs, payout: String(payout),
      };
      const offer = await supplier.callFunctionRaw({
        contractId, methodName: "create_sla", args: terms, waitUntil: "FINAL", gas: teraToGas("80"), deposit: payout + storage,
      });
      assert.ok(typeof offer.status === "object" && "SuccessValue" in offer.status);
      const slaId: unknown = JSON.parse(Buffer.from(offer.status.SuccessValue, "base64").toString("utf8"));
      assert.ok(typeof slaId === "string" && /^(0|[1-9][0-9]*)$/.test(slaId), "Invalid agreement ID");
      const args = { sla_id: slaId };
      const read = () => view<PilotAgreement>("get_sla", args);
      const call = (actor: Account, method: string, throwOnFailure = true) => actor.signAndSendTransaction({
        receiverId: contractId, waitUntil: "FINAL", retries: 0, throwOnFailure,
        actions: [actions.functionCall(method, args, teraToGas("100"), 0n)],
      });
      progress(`SLA ${slaId} ${oracles.length}/${scenario.quorum} offer ${offer.transaction_outcome.id}`);
      const acceptance = await call(customer, "accept_sla");
      const agreement = await read();
      assert.equal(agreement.policy_version, 2);
      assert.equal(agreement.accepted, true);
      assert.equal(agreement.provider, supplier.accountId);
      assert.equal(agreement.ends_at_ms, String(end));
      assert.equal(agreement.reporting_deadline_ms, String(end + graceMs));
      for (const [name, value] of Object.entries(terms)) {
        if (name === "reporting_grace_ms") continue;
        assert.deepEqual(agreement[name as keyof PilotAgreement], value, `Accepted terms differ for ${name}`);
      }
      assert.ok(Date.now() < start, "Acceptance did not finish before the observation window");

      responseFor = (id, now) => {
        const observer = oracles.indexOf(id);
        const slot = Math.floor((now - start) / slotMs);
        return observer >= 0 && slot >= 0 && slot < scenario.slots ? scenario.httpStatus(observer, slot) : 404;
      };
      const evidence = await Promise.all(oracles.map(async (oracle, observer) => {
        const config = {
          network, contract: contractId, ...args, oracle, endpoint_hash: endpointHash,
          starts_at_ms: terms.starts_at_ms, slot_ms: slotMs, slot_count: scenario.slots,
        };
        const bundle = await collectEvidence(config, LOCAL_DEMO_ENDPOINT, {
          localDemo: true,
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set("x-sla-pilot-observer", oracle);
            return fetch(url, { ...init, headers });
          },
        });
        assert.ok(await verifyEvidenceBundle(bundle, { config, contract_vote: bundle.contract_vote }));
        assert.deepEqual(bundle.evidence.observations.map(({ http_status }) => http_status),
          Array.from({ length: scenario.slots }, (_, slot) => scenario.httpStatus(observer, slot)),
          `Unexpected controlled observations from ${oracle}`);
        return bundle;
      }));
      const votes = evidence.map(({ contract_vote }) => contract_vote);
      const verdict = assessQuorumWindow(scenario.slots, scenario.threshold, scenario.quorum, votes);
      assert.deepEqual(verdict, scenario.verdict);
      const reportingWait = Date.now() + 45_000;
      while (await chainTime() < end) {
        assert.ok(Date.now() < reportingWait, "Finalized chain did not reach the reporting period");
        await sleep(500);
      }
      const voteTransactions = [];
      for (const [i, vote] of votes.entries()) {
        const hash = await roster[i].send(vote);
        voteTransactions.push(hash);
        progress(`SLA ${slaId} vote ${roster[i].id} ${hash}`);
      }
      const finalization = await call(supplier, "finalize");
      const kind = verdict.outcome === "breach" ? "compensation" : "refund";
      const [beneficiary, otherParty] = kind === "compensation" ? [customer, supplier] : [supplier, customer];
      async function rejectedClaim(actor: Account, message: RegExp) {
        const tx = await call(actor, "claim", false);
        assert.equal(tx.final_execution_status, "FINAL");
        assert.ok(typeof tx.status === "object" && "Failure" in tx.status, "Expected a rejected claim");
        assert.match(JSON.stringify(tx.status.Failure), message);
        return tx.transaction_outcome.id;
      }
      const rejectedOtherParty = await rejectedClaim(otherParty, /Only beneficiary can claim/);
      const payment = await call(beneficiary, "claim");
      const txHash = payment.transaction_outcome.id;
      progress(`SLA ${slaId} ${kind} ${txHash}`);
      const receiptArgs = { accountId: beneficiary.accountId, txHash, waitUntil: "FINAL" as const };
      const receiptDeadline = Date.now() + 30_000;
      const trace = await (async () => {
        while (true) {
          try {
            return await receiptProvider.viewTransactionStatusWithReceipts(receiptArgs);
          } catch (error) {
            if (Date.now() >= receiptDeadline
              || !(error instanceof UnknownTransactionError || error instanceof UnknownTransactionOrReceiptError)) throw error;
            await sleep(1_000);
          }
        }
      })();
      const state = await read();
      assert.deepEqual(state.votes, votes.map(({ sla_id: _id, ...vote }) => ({ submitted: true, ...vote })));
      assert.deepEqual(
        [state.outcome, state.confirmed_down_slots, state.possible_down_slots],
        [verdict.outcome, verdict.confirmed, verdict.possible],
      );
      const proof = verifySettlement({ contract: contractId, slaId: args.sla_id, transactionHash: txHash, kind, policyVersion: 2 },
        state, trace as unknown as TransactionTrace);
      assert.equal(state.attempt, 1);
      const rejectedDuplicate = await rejectedClaim(beneficiary, /Payment not claimable/);
      assert.deepEqual(await read(), state);
      results.push({
        ...proof, kind, verdict, evidence, agreement: state, receipt_trace: trace,
        offer_tx: offer.transaction_outcome.id, acceptance_tx: acceptance.transaction_outcome.id,
        vote_transaction_hashes: voteTransactions, finalization_tx: finalization.transaction_outcome.id,
        rejected_other_party_claim_tx: rejectedOtherParty, rejected_duplicate_claim_tx: rejectedDuplicate,
        duplicate_claim_rejected: true,
      });
    }
    return {
      network, sponsor: root.accountId, contract: contractId, wasm_sha256: artifact.sha256, code_hash: artifact.codeHash,
      deployment_tx: deployment.transaction_outcome.id, observation_source: "controlled_loopback_http_single_host", results,
    };
  } finally {
    await new Promise<void>((resolve, reject) => health.close((error) => error ? reject(error) : resolve()));
  }
}
