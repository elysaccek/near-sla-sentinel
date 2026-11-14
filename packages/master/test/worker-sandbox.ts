import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, SignedTransaction, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { Client, Pool } from "pg";
import { nearRpc } from "../../shared/near-rpc.ts";
import { loopbackHealth } from "../../shared/oracle-protocol.ts";
import { hashEndpoint } from "../../operator/src/monitoring/monitor.ts";
import { verifySettlement } from "../../operator/src/settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../../operator/src/settlement/settlement.ts";
import type { WorkerIdentity } from "../../operator/src/worker/identity.ts";
import { loadIdentity, privateDirectory } from "../../operator/src/worker/identity.ts";
import { masterClient, masterVerifiers } from "../../operator/src/worker/master-client.ts";
import { nearWorker } from "../../operator/src/worker/near.ts";
import { workerRunner } from "../../operator/src/worker/runner.ts";
import { assignmentId, openWorkerStore } from "../../operator/src/worker/store.ts";
import { migrate } from "../src/database.ts";
import { createMaster } from "../src/server.ts";
import { assignmentOptions } from "../src/assignments.ts";

async function waitFor(condition: () => boolean, message: string, milliseconds: number) {
  const until = Date.now() + milliseconds;
  while (!condition()) {
    assert.ok(Date.now() < until, message);
    await sleep(50);
  }
}

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({ options: {
    rpc: { type: "string" }, "sandbox-home": { type: "string" }, wasm: { type: "string" },
    oracles: { type: "string", default: "3" }, faults: { type: "boolean" },
    "drop-vote-response": { type: "boolean" },
  } });
  const { rpc, "sandbox-home": sandboxHome, wasm: wasmPath } = values;
  const database = process.env.SLA_MASTER_TEST_DATABASE_URL;
  const size = Number(values.oracles);
  const withFaults = values.faults === true;
  const dropVoteResponse = values["drop-vote-response"] === true;
  const payout = nearToYocto("0.1");
  if (!rpc || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(rpc) || !sandboxHome || !wasmPath || !database) {
    throw new Error("Provide --rpc, --sandbox-home, --wasm and SLA_MASTER_TEST_DATABASE_URL");
  }
  if (!Number.isInteger(size) || size < 3 || size > 16) throw new Error("Use --oracles with a roster size between 3 and 16");
  const provider = new JsonRpcProvider({ url: rpc }, { retries: 2 });
  const network = await provider.getNetworkId();
  assert.match(network, /^test-chain-/);
  const wasm = await readFile(wasmPath);
  assert.ok(WebAssembly.validate(wasm));
  const validator = JSON.parse(await readFile(join(sandboxHome, "validator_key.json"), "utf8")) as {
    account_id: string; secret_key: KeyPairString;
  };
  const root = new Account(validator.account_id, provider, KeyPairSigner.fromSecretKey(validator.secret_key));
  const prefix = randomBytes(4).toString("hex");
  async function account(role: string, funding = "5" as const) {
    const name = prefix + "-" + role;
    const key = KeyPair.fromRandom("ed25519");
    await root.createSubAccount({ accountOrPrefix: name, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(funding) });
    return new Account(name + "." + root.accountId, provider, new KeyPairSigner(key));
  }
  const escrow = await account("escrow");
  const supplier = await account("provider");
  const customer = await account("customer");
  const observers: { oracle: Account; voteKey: KeyPair }[] = [];
  for (let index = 0; index < size; index += 1) {
    observers.push({ oracle: await account("oracle-" + index), voteKey: KeyPair.fromRandom("ed25519") });
  }
  const contract = escrow.accountId;
  await escrow.signAndSendTransaction({
    receiverId: contract, actions: [actions.deployContract(wasm)], waitUntil: "FINAL",
  });
  const call = (sender: Account, methodName: string, args: Record<string, unknown>, deposit = 0n) =>
    sender.callFunctionRaw({ contractId: contract, methodName, args, deposit, gas: teraToGas("100"), waitUntil: "FINAL" });
  await call(escrow, "new", {});
  await Promise.all(observers.map(({ oracle, voteKey }) => oracle.signAndSendTransaction({
    receiverId: oracle.accountId, waitUntil: "FINAL",
    actions: [actions.addFunctionCallAccessKey(voteKey.getPublicKey(), contract, ["submit_vote"], nearToYocto("0.3"))],
  })));

  const temp = await mkdtemp(join(process.env.SLA_WORKER_TEST_TMPDIR ?? tmpdir(), "worker-sandbox-"));
  const schema = "master_test_" + randomBytes(8).toString("hex");
  const maintenance = new Pool({ connectionString: database });
  const dbOptions = {
    connectionString: database,
    onConnect: (client: Client) => client.query(`SET search_path TO "${schema}"`),
  };
  const db = new Pool(dbOptions);
  const cleanup: Array<() => void | Promise<void>> = [
    async () => { await maintenance.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await maintenance.end(); },
    () => db.end(),
    () => rm(temp, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM" || !process.env.SLA_WORKER_TEST_TMPDIR) throw error;
    }),
  ];
  try {
    await maintenance.query(`CREATE SCHEMA "${schema}"`);
    await migrate(db);
    assert.equal((await db.query("SELECT current_schema() AS name")).rows[0].name, schema);
    const rpcRead = nearRpc(rpc, network);
    let droppedVoteHash: string | undefined;
    let droppedVoteSender: string | undefined;
    let droppedSenderBroadcasts = 0;
    let workerRpc = rpc;
    if (dropVoteResponse) {
      const relay = createServer(async (req, res) => {
        try {
          const chunks: Uint8Array[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const request = JSON.parse(body.toString("utf8"));
          if (request.method === "send_tx") {
            const signed = SignedTransaction.decode(Buffer.from(request.params.signed_tx_base64, "base64"));
            droppedVoteSender ??= signed.transaction.signerId;
            if (signed.transaction.signerId === droppedVoteSender) droppedSenderBroadcasts += 1;
          }
          const drop = request.method === "send_tx" && droppedVoteHash === undefined;
          if (drop) {
            // Reserve the fault before awaiting so only one response is dropped.
            droppedVoteHash = "";
            request.params.wait_until = "FINAL";
          }
          const response = await fetch(rpc, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: drop ? JSON.stringify(request) : body, signal: AbortSignal.timeout(10_000),
          });
          const answer = await response.text();
          if (drop) {
            const trace = JSON.parse(answer).result;
            assert.equal(trace?.final_execution_status, "FINAL");
            assert.ok(trace.status && "SuccessValue" in trace.status);
            assert.ok(trace.transaction_outcome.id);
            droppedVoteHash = trace.transaction_outcome.id;
            res.destroy();
            return;
          }
          res.writeHead(response.status, { "Content-Type": "application/json" }).end(answer);
        } catch (error) {
          console.error("Local Sandbox RPC relay failed", error);
          if (!res.destroyed && !res.headersSent) res.writeHead(502).end();
        }
      });
      relay.listen(0, "127.0.0.1");
      await once(relay, "listening");
      cleanup.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));
      const relayAddress = relay.address();
      assert(relayAddress && typeof relayAddress === "object");
      workerRpc = "http://127.0.0.1:" + relayAddress.port;
    }
    const { privateKey: signingKey, publicKey } = generateKeyPairSync("ed25519");
    const adminToken = randomBytes(32).toString("base64url");
    const options = assignmentOptions(signingKey.export({ format: "der", type: "pkcs8" }), rpc, network);
    const master = createMaster(db, "sandbox-worker.test", { operator: adminToken }, options, network);
    master.listen(0, "127.0.0.1");
    await once(master, "listening");
    const stopMaster = async () => {
      if (master.listening) await new Promise<void>((resolve) => master.close(() => resolve()));
    };
    cleanup.push(stopMaster);
    const address = master.address();
    assert(address && typeof address === "object");
    const masterUrl = "http://127.0.0.1:" + address.port;
    const admin = async (path: string, body: unknown = {}) => {
      const response = await fetch(masterUrl + "/admin/oracles" + path, {
        method: "POST", signal: AbortSignal.timeout(5000), headers: {
          "Content-Type": "application/json", Authorization: "Bearer " + adminToken,
        }, body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    };
    const enrolled: { directory: string; identity: WorkerIdentity; signer: KeyPairSigner }[] = [];
    for (const { oracle, voteKey } of observers) {
      const directory = await privateDirectory(join(temp, oracle.accountId));
      const identity = await loadIdentity(directory, {
        master: masterUrl, audience: "sandbox-worker.test", network, near_account: oracle.accountId,
        near_public_key: voteKey.getPublicKey().toString(),
      });
      const client = masterClient(identity);
      const invite = await admin("/invitations");
      assert.equal(await client.join(invite.code, { version: "0.1.0", region: "Sandbox" }), "PENDING_APPROVAL");
      assert.equal((await admin("/" + identity.node_id + "/approve")).status, "ACTIVE");
      assert.equal(await client.join("", {}), "ACTIVE");
      enrolled.push({ directory, identity, signer: new KeyPairSigner(voteKey) });
    }

    let requests = 0;
    const health = createServer((_req, res) => { requests += 1; res.writeHead(503).end(); });
    health.listen(8787, "127.0.0.1");
    await once(health, "listening");
    cleanup.push(() => new Promise<void>((resolve) => health.close(() => resolve())));
    const finalizedBlock = await provider.viewBlock({ finality: "final" });
    const chainNow = Number(BigInt(finalizedBlock.header.timestamp_nanosec) / 1_000_000n);
    assert.ok(Math.abs(chainNow - Date.now()) < 5000, "Use a fresh Sandbox for the wall-clock worker scenarios");
    const start = Math.max(Date.now(), chainNow) + 18_000;
    const slotMs = 2500;
    const roster = observers.map(({ oracle }) => oracle.accountId);
    const quorum = Math.floor(size / 2) + 1;
    const storage = await provider.callFunction<string>({ contractId: contract, method: "storage_deposit", args: { oracle_count: roster.length } });
    const funded = await call(supplier, "create_sla", {
      customer: customer.accountId, oracles: roster, down_quorum: quorum, endpoint_hash: await hashEndpoint(loopbackHealth, { localDemo: true }),
      starts_at_ms: String(start), slot_ms: slotMs, slot_count: 3, min_down_slots: 3, reporting_grace_ms: 60_000,
      payout: String(payout),
    }, BigInt(storage!) + payout);
    assert.ok(typeof funded.status === "object" && "SuccessValue" in funded.status);
    const assignmentIdOnChain: string = JSON.parse(Buffer.from(funded.status.SuccessValue, "base64").toString("utf8"));
    await call(customer, "accept_sla", { sla_id: assignmentIdOnChain });
    const tasks = await Promise.all(enrolled.map(({ identity }) =>
      admin("/" + identity.node_id + "/assignments", { contract, sla_id: assignmentIdOnChain, endpoint: loopbackHealth })));
    const faultIndex = size - 1;
    const faultPath = "/" + enrolled[faultIndex].identity.node_id + "/fault-schedule";
    if (withFaults) {
      const cleared = await admin(faultPath, { schedule: null });
      assert.equal(cleared.revision, 1);
      const plan = await admin(faultPath, { schedule: {
        fault_type: "target_connectivity", starts_at_ms: start + slotMs - 300,
        interval_seconds: 60, duration_seconds: 2, expires_at_ms: start + 10_000, reason: "Sandbox local fault",
      } });
      assert.equal(plan.revision, 2);
    }
    const der = publicKey.export({ format: "der", type: "spki" });
    const snapshot = await rpcRead.readAgreement(contract, assignmentIdOnChain);
    const id = assignmentId(tasks[0].assignment);
    const workers = enrolled.map(({ directory, identity, signer }) => {
      let store = openWorkerStore(directory);
      let stop = new AbortController();
      const verifiers = masterVerifiers(identity, der);
      const run = () => workerRunner({
        store, identity, signal: stop.signal, verify: verifiers.assignment,
        verifyFault: withFaults ? verifiers.fault : undefined,
        chain: nearWorker(workerRpc, identity.near_account, signer, network, stop.signal),
        targets: { network, contract, codeHash: snapshot.codeHash, endpoints: new Set([loopbackHealth]) },
      }).run();
      let running = run();
      cleanup.push(async () => { stop.abort(); await running; store.close(); });
      return {
        get store() { return store; },
        async restart() {
          stop.abort();
          await running;
          store.close();
          store = openWorkerStore(directory);
          stop = new AbortController();
          running = run();
        },
      };
    });
    await waitFor(() => {
      try { return workers.every(({ store }) => store.getTask(id).authorized); }
      catch { return false; }
    }, "workers did not fetch and authorize their assignments", 8000);
    if (withFaults) {
      await waitFor(() => workers[faultIndex].store.faultSchedule() !== undefined, "worker did not cache signed demo plan", 8000);
      const received = await masterClient(enrolled[faultIndex].identity).faultSchedule();
      const verifiers = masterVerifiers(enrolled[faultIndex].identity, der);
      assert.equal(verifiers.fault(received).plan.revision, 2);
      assert.throws(() => masterVerifiers(enrolled[0].identity, der).fault(received), /signature/);
      assert.equal(await masterClient(enrolled[0].identity).faultSchedule(), null);
      const { rows: [audit] } = await db.query("SELECT count(*)::int AS count FROM oracle_audit_log WHERE subject=$1 AND action LIKE 'fault_schedule_%'",
        [enrolled[faultIndex].identity.node_id]);
      assert.equal(audit.count, 2);
    }
    const node = await db.query("SELECT count(*)::int AS active FROM oracle_nodes WHERE last_heartbeat_at IS NOT NULL");
    assert.equal(node.rows[0].active, size);
    await stopMaster();
    const restarted = workers[withFaults ? faultIndex : 0];
    await waitFor(() => restarted.store.observations(id).length >= 1, "worker did not save its first real probe", 30_000);
    assert.equal(restarted.store.observations(id)[0].slot, 0);
    await restarted.restart();
    await waitFor(() => workers.every(({ store }) => store.getTask(id).phase === "recorded"),
      "workers did not record their votes on Sandbox", 35_000);
    const final = await rpcRead.readAgreement(contract, assignmentIdOnChain);
    const recorded = final.agreement as { votes: { submitted: boolean; down_mask: string; evidence_hash: number[] }[] };
    const transactions = workers.map(({ store }, index) => {
      const task = store.getTask(id);
      assert.equal(recorded.votes[index].submitted, true);
      assert.equal(recorded.votes[index].down_mask, withFaults && index === faultIndex ? "5" : "7");
      assert.deepEqual(recorded.votes[index].evidence_hash, task.evidence?.contract_vote.evidence_hash);
      assert.ok(task.transactionHash);
      return task.transactionHash;
    });
    if (dropVoteResponse) {
      assert.ok(droppedVoteHash && transactions.includes(droppedVoteHash), "Worker must reconcile the finalized vote after response loss");
      const recovered = workers.find(({ store }) => store.getTask(id).transactionHash === droppedVoteHash);
      assert.equal(recovered?.store.getTask(id).attempts, 1);
      assert.equal(droppedSenderBroadcasts, 1);
    }
    assert.equal(requests, size * 3 - (withFaults ? 1 : 0));
    if (withFaults) {
      const recovered = workers[faultIndex].store;
      assert.equal(recovered.getTask(id).evidence?.evidence.observations[1].result, "unknown");
      assert.equal(recovered.getTask(id).evidence?.evidence.observations[2].result, "down");
      assert.equal(recovered.summary().recent_diagnostics[0].detail, "CONTROLLED_FAULT");
      assert.equal(recovered.summary().recent_faults.length, 1);
      assert.ok(recovered.summary().recent_faults[0].closed_at_ms);
    }
    const finalization = await call(supplier, "finalize", { sla_id: assignmentIdOnChain });
    assert.ok(typeof finalization.status === "object" && "SuccessValue" in finalization.status);
    assert.equal(JSON.parse(Buffer.from(finalization.status.SuccessValue, "base64").toString("utf8")), "breach");
    const claimArgs = { sla_id: assignmentIdOnChain };
    const escrowBalance = async () => (await provider.viewAccount({
      accountId: contract, blockQuery: { finality: "final" },
    })).amount;
    const claim = await call(customer, "claim", claimArgs);
    const transactionHash = claim.transaction_outcome.id;
    const trace = await provider.viewTransactionStatusWithReceipts({
      accountId: customer.accountId, txHash: transactionHash, waitUntil: "FINAL",
    });
    const paid = (await rpcRead.readAgreement(contract, assignmentIdOnChain)).agreement as SettlementState;
    const settlement = verifySettlement({
      contract, slaId: assignmentIdOnChain, transactionHash, policyVersion: 2,
    }, paid, trace as unknown as TransactionTrace);
    assert.equal(settlement.amount_yoctonear, String(payout));
    assert.equal(settlement.attempt, 1);
    const afterClaim = await escrowBalance();
    await assert.rejects(call(customer, "claim", claimArgs), /Payment not claimable/);
    // The escrow may receive gas rewards, but a second claim may never debit principal.
    assert.ok(await escrowBalance() >= afterClaim);
    console.log(JSON.stringify({
      network, contract, sla_id: assignmentIdOnChain, roster_size: roster.length, quorum,
      http_probes: requests, master_offline: true, worker_restarted: true, vote_transactions: transactions, outcome: "breach",
      simulated_unknown_slots: withFaults ? 1 : 0, settlement, duplicate_claim_rejected: true,
      ...(dropVoteResponse ? { reconciled_vote_transaction: droppedVoteHash } : {}),
    }));
  } finally {
    for (const close of cleanup.reverse()) await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
