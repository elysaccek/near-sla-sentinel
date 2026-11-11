import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas } from "near-api-js";
import { assessWindow, createEvidenceBundle, verifyEvidenceBundle } from "../monitoring/evidence.ts";
import type { EvidenceBundle } from "../monitoring/evidence.ts";
import { collectEvidence, hashEndpoint, LOCAL_DEMO_ENDPOINT } from "../monitoring/monitor.ts";
import { prepareVoteSender } from "../oracles/oracle-signer.ts";
import type { Agreement } from "../oracles/oracle-flow.ts";
import { verifySettlement } from "../settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../settlement/settlement.ts";

interface PaymentDemoOptions {
  provider: JsonRpcProvider;
  receiptProvider: JsonRpcProvider;
  root: Account;
  network: string;
  wasm: Uint8Array<ArrayBuffer>;
  measure: boolean;
  scenario?: "breach" | "inconclusive";
  escrowFunding: bigint;
  actorFunding: bigint;
  startDelayMs: number;
  slotMs: number;
  reportingGraceMs: number;
  onAccount?: (role: string, id: string) => void;
  onClaim?: (hash: string) => void;
}

export async function runPaymentDemo({
  provider, receiptProvider, root, network, wasm, measure, scenario = "breach", escrowFunding, actorFunding,
  startDelayMs, slotMs, reportingGraceMs, onAccount, onClaim,
}: PaymentDemoOptions) {
  assert.ok(WebAssembly.validate(wasm), "Expected a valid Wasm module");
  const inconclusive = scenario === "inconclusive";
  assert.ok(!inconclusive || (!measure && /^test-chain-/.test(network)), "Scripted inconclusive observations require Sandbox");
  const prefix = randomBytes(4).toString("hex");

  const create = async (role: string): Promise<Account> => {
    const accountOrPrefix = `${prefix}-${role}`;
    const key = KeyPair.fromRandom("ed25519");
    await root.createSubAccount({
      accountOrPrefix,
      publicKey: key.getPublicKey(),
      nearToTransfer: role === "escrow" ? escrowFunding : actorFunding,
    });
    const accountId = `${accountOrPrefix}.${root.accountId}`;
    onAccount?.(role, accountId);
    return new Account(accountId, provider, new KeyPairSigner(key));
  };
  const escrow = await create("escrow");
  const providerAccount = await create("provider");
  const customer = await create("customer");
  const oracles = [await create("a"), await create("b"), await create("c")];
  const contractId = escrow.accountId;
  await escrow.signAndSendTransaction({ receiverId: contractId, actions: [actions.deployContract(wasm)], waitUntil: "FINAL" });
  const sendVotes = [];
  for (const oracle of oracles) {
    const key = KeyPair.fromRandom("ed25519");
    await oracle.signAndSendTransaction({
      receiverId: oracle.accountId,
      actions: [actions.addFunctionCallAccessKey(key.getPublicKey(), contractId, ["submit_vote"], nearToYocto("0.25"))],
      waitUntil: "FINAL",
    });
    sendVotes.push(await prepareVoteSender(provider, contractId, oracle.accountId, key.toString()));
  }

  const view = async <T extends object | string>(method: string, args: Record<string, unknown>) => {
    const result = await provider.callFunction<T>({ contractId, method, args, blockQuery: { finality: "final" } });
    assert.ok(result != null, `Missing ${method} result`);
    return result;
  };
  const chainTime = async () => Number(BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec) / 1_000_000n);
  const payout = nearToYocto("0.1");
  const storage = BigInt(await view<string>("storage_deposit", {}));
  const slotCount = inconclusive ? 4 : measure ? 8 : 5;
  const minDownSlots = inconclusive ? 4 : measure ? 5 : 3;
  const endpointHash = measure
    ? await hashEndpoint(LOCAL_DEMO_ENDPOINT, { localDemo: true })
    : Array<number>(32).fill(17);
  const startsAt = Math.max(Date.now(), await chainTime()) + startDelayMs;
  const slaId = await providerAccount.callFunction<string>({
    contractId, methodName: "create_sla", waitUntil: "FINAL", deposit: payout + storage,
    gas: teraToGas("80"), args: {
      customer: customer.accountId, oracles: oracles.map(({ accountId }) => accountId),
      endpoint_hash: endpointHash, starts_at_ms: String(startsAt), slot_ms: slotMs,
      slot_count: slotCount, min_down_slots: minDownSlots, reporting_grace_ms: reportingGraceMs, payout: String(payout),
    },
  });
  const args = { sla_id: slaId };
  const call = (account: Account, methodName: string, input: Record<string, unknown> = args) =>
    account.callFunctionRaw({ contractId, methodName, args: input, gas: teraToGas("100"), waitUntil: "FINAL" });
  await call(customer, "accept_sla");
  let evidence: EvidenceBundle[] | undefined;
  const configs = oracles.map(({ accountId }) => ({
    network, contract: contractId, sla_id: slaId, oracle: accountId, endpoint_hash: endpointHash,
    starts_at_ms: String(startsAt), slot_ms: slotMs, slot_count: slotCount,
  }));
  if (inconclusive) {
    const failedSlots = [[0, 1], [0, 1, 2, 3], [2, 3]];
    evidence = await Promise.all(configs.map((config, index) => createEvidenceBundle(config,
      failedSlots[index].map((slot) => ({
        slot, started_at_ms: startsAt + slot * slotMs, finished_at_ms: startsAt + slot * slotMs + 1, http_status: 503,
      })))));
  }
  if (measure) {
    const health = spawn(process.execPath, [
      fileURLToPath(new URL("./demo-health.ts", import.meta.url)), "--start-ms", String(startsAt), "--slot-ms", String(slotMs),
    ], { stdio: ["ignore", "pipe", "inherit"] });
    const exit = once(health, "exit");
    try {
      await Promise.race([once(health.stdout, "data"), exit.then(() => { throw new Error("Health server exited"); })]);
      evidence = await Promise.all(configs.map((config) => collectEvidence(config, LOCAL_DEMO_ENDPOINT, { localDemo: true })));
      for (const [index, bundle] of evidence.entries()) {
        assert.ok(await verifyEvidenceBundle(bundle, { config: configs[index], contract_vote: bundle.contract_vote }));
      }
      const observed = assessWindow(slotCount, minDownSlots, evidence.map(({ contract_vote }) => contract_vote));
      assert.equal(observed.outcome, "breach", `Expected a measured breach; observed ${JSON.stringify(observed)}`);
    } finally {
      health.kill();
      await exit;
    }
  }
  const deadline = Math.max(Date.now(), startsAt + slotCount * slotMs) + 45_000;
  while (await chainTime() < startsAt + slotCount * slotMs) {
    assert.ok(Date.now() < deadline, "Final blocks did not reach the reporting period");
    await sleep(250);
  }

  const vote = (index: number, up_mask = "17", down_mask = "14") => ({
    ...args, up_mask, down_mask, evidence_hash: Array<number>(32).fill(index),
  });
  const votes = evidence?.map(({ contract_vote }) => contract_vote) ?? [vote(1), vote(2), vote(3, "31", "0")];
  await assert.rejects(call(providerAccount, "submit_vote", { ...votes[0] }), /Unauthorized oracle/);
  const firstVote = await sendVotes[0](votes[0]);
  await assert.rejects(call(customer, "claim"), /Payment not claimable/);
  await assert.rejects(sendVotes[0](votes[1]), /Oracle already voted/);
  const secondVote = await sendVotes[1](votes[1]);
  const thirdVote = await sendVotes[2](votes[2]);
  await call(providerAccount, "finalize");
  const beneficiary = inconclusive ? providerAccount : customer;
  const nonBeneficiary = inconclusive ? customer : providerAccount;
  const deniedClaim = await nonBeneficiary.signAndSendTransaction({
    receiverId: contractId, actions: [actions.functionCall("claim", args, teraToGas("100"), 0n)],
    waitUntil: "FINAL", throwOnFailure: false,
  });
  assert.equal(deniedClaim.final_execution_status, "FINAL");
  assert.ok(typeof deniedClaim.status === "object" && "Failure" in deniedClaim.status);
  assert.match(JSON.stringify(deniedClaim.status.Failure), /Only beneficiary can claim/);

  const payment = await call(beneficiary, "claim");
  const transactionHash = payment.transaction_outcome.id;
  onClaim?.(transactionHash);
  const trace = await receiptProvider.viewTransactionStatusWithReceipts({
    accountId: beneficiary.accountId, txHash: transactionHash, waitUntil: "FINAL",
  });
  const state = await view<Agreement & SettlementState & {
    confirmed_down_slots: number; possible_down_slots: number;
  }>("get_sla", args);
  assert.deepEqual(state.oracles, oracles.map(({ accountId }) => accountId));
  assert.deepEqual(state.votes, votes.map(({ up_mask, down_mask, evidence_hash }) => ({
    submitted: true, up_mask, down_mask, evidence_hash,
  })));
  const verdict = assessWindow(slotCount, minDownSlots, votes);
  assert.equal(verdict.outcome, scenario);
  if (inconclusive) assert.deepEqual(verdict, { outcome: "inconclusive", confirmed: 2, possible: 4 });
  assert.equal(state.outcome, verdict.outcome);
  assert.equal(state.confirmed_down_slots, verdict.confirmed);
  assert.equal(state.possible_down_slots, verdict.possible);
  const proof = verifySettlement({
    contract: contractId, slaId, transactionHash, kind: inconclusive ? "refund" : "compensation",
  }, state, trace as unknown as TransactionTrace);
  await assert.rejects(call(beneficiary, "claim"), /Payment not claimable/);
  assert.deepEqual(await view<SettlementState>("get_sla", args), state);
  return {
    network, contract: contractId, ...proof, verdict, vote_transaction_hashes: [firstVote, secondVote, thirdVote],
    duplicate_claim_rejected: true, evidence, agreement: state, receipt_trace: trace,
    ...(inconclusive ? { observation_source: "scripted", rejected_customer_claim: deniedClaim } : {}),
  };
}
