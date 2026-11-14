import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { KeyPair } from "near-api-js";
import { assignmentMessage, loopbackHealth, policyFromAgreement } from "../../shared/oracle-protocol.ts";
import type { Assignment } from "../../shared/oracle-protocol.ts";
import { hashEndpoint } from "../src/monitoring/monitor.ts";
import { loadIdentity, privateDirectory } from "../src/worker/identity.ts";
import type { WorkerIdentity } from "../src/worker/identity.ts";
import { assignmentVerifier, masterClient } from "../src/worker/master-client.ts";
import { checkSnapshot } from "../src/worker/near.ts";
import type { WorkerChain } from "../src/worker/near.ts";
import { workerRunner } from "../src/worker/runner.ts";
import { assignmentId, lockWorker, openWorkerStore } from "../src/worker/store.ts";

async function state(t: TestContext) {
  const directory = await mkdtemp(join(process.env.SLA_WORKER_TEST_TMPDIR ?? tmpdir(), "sla-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EPERM" || !process.env.SLA_WORKER_TEST_TMPDIR) throw error;
  }));
  return privateDirectory(directory);
}

async function agreement(start: number, oracle: string) {
  const policy = policyFromAgreement({
    policy_version: 2, oracles: [oracle, "b.testnet", "c.testnet", "d.testnet", "e.testnet"],
    endpoint_hash: await hashEndpoint(loopbackHealth, { localDemo: true }),
    starts_at_ms: String(start), ends_at_ms: String(start + 2000), reporting_deadline_ms: String(start + 30_000),
    slot_ms: 1000, slot_count: 2, min_down_slots: 2, down_quorum: 3,
  });
  const assignment: Assignment = {
    network: "test-chain-unit", contract: "escrow.testnet", sla_id: "0",
    endpoint: loopbackHealth, code_hash: "2".repeat(32), policy,
  };
  const idle = { submitted: false, up_mask: "0", down_mask: "0", evidence_hash: Array<number>(32).fill(0) };
  const snapshot = {
    time: Date.now(), blockHash: "3".repeat(32), codeHash: assignment.code_hash, clockSkewMs: 0,
    agreement: { ...policy, accepted: true, outcome: "undecided", votes: policy.oracles.map(() => ({ ...idle })) },
  };
  return { assignment, snapshot };
}

const profile = {
  master: "http://127.0.0.1:1", audience: "worker.test",
  network: "test-chain-unit", near_account: "a.testnet", near_public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
};

test("identity survives concurrent creation and is bound to the Master and vote key", async (t) => {
  const directory = await state(t);
  const [first, second] = await Promise.all([loadIdentity(directory, profile), loadIdentity(directory, profile)]);
  assert.equal(second.node_id, first.node_id);
  assert.equal(second.sign("check"), first.sign("check"));
  const file = join(directory, "identity.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(loadIdentity(directory, { ...profile, near_account: "another.testnet" }), /bound/);
  await chmod(file, 0o644);
  await assert.rejects(loadIdentity(directory), /owner-only/);
});

test("registration verifies the full challenge before using the local key", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/oracles/registration/status") { res.writeHead(404).end(); return; }
    assert.equal(req.url, "/oracles/registration/challenge");
    res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ id: randomUUID(), message: "different audience" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert(address && typeof address === "object");
  const identity = await loadIdentity(await state(t), { ...profile, master: "http://127.0.0.1:" + address.port });
  let signed = 0;
  const client = masterClient({ ...identity, sign: (text) => { signed += 1; return identity.sign(text); } });
  await assert.rejects(client.join("SLA-ORACLE-" + "x".repeat(43), {}), /different registration terms/);
  assert.equal(signed, 2, "only the two signed status checks were made");
});

function assignmentKey(identity: WorkerIdentity, assignment: Assignment) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bytes = publicKey.export({ format: "der", type: "spki" });
  return {
    bytes,
    verify: assignmentVerifier(identity, bytes),
    envelope: { assignment, signature: sign(null, Buffer.from(assignmentMessage(identity.audience, identity.node_id, assignment)), privateKey).toString("base64url") },
  };
}

test("assignment binds the recipient and frozen N/K policy, and final state is checked separately", async (t) => {
  const identity = await loadIdentity(await state(t), profile);
  const { assignment, snapshot } = await agreement(Date.now() + 5000, identity.near_account);
  const { bytes, verify, envelope } = assignmentKey(identity, assignment);
  assert.deepEqual(verify(envelope).assignment, assignment);
  assert.throws(() => assignmentVerifier({ ...identity, node_id: randomUUID() }, bytes)(envelope), /signature/);
  assert.throws(() => verify({ ...envelope, assignment: { ...assignment, policy: { ...assignment.policy, down_quorum: 4 } } }), /signature/);
  assert.equal(checkSnapshot(assignment, snapshot, identity.near_account).accepted, true);
  assert.throws(() => checkSnapshot(assignment, { ...snapshot, codeHash: "4".repeat(32) }, identity.near_account), /contract code/);
  assert.throws(() => checkSnapshot(assignment, { ...snapshot,
    agreement: { ...snapshot.agreement, down_quorum: 4 },
  }, identity.near_account), /roster or policy/);
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 12_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "worker state did not advance");
    await sleep(50);
  }
}

test("worker resumes stored slots and resends only the same signed vote after an RPC timeout", async (t) => {
  const directory = await state(t);
  const release = lockWorker(directory);
  try { assert.throws(() => lockWorker(directory), /another running scheduler/); }
  finally { release(); }
  lockWorker(directory)();
  const identity = await loadIdentity(directory, profile);
  const starts = Date.now() - 200;
  const { assignment, snapshot } = await agreement(starts, identity.near_account);
  const { envelope, verify } = assignmentKey(identity, assignment);
  const id = assignmentId(assignment);
  let store = openWorkerStore(directory);
  store.setRegistration("ACTIVE");
  store.saveAssignment(envelope);
  assert.equal(store.summary().tasks[0]?.authorized, false);
  store.setAuthorized(id);
  assert.equal(store.claimSlot(id, 0), true);
  store.finishSlot(id, { slot: 0, started_at_ms: starts, finished_at_ms: starts + 20, http_status: 503 });
  store.close();
  store = openWorkerStore(directory);
  t.after(() => store.close());
  assert.equal(store.summary().tasks[0]?.authorized, true);

  let probes = 0;
  let signed = 0;
  let sent = 0;
  const candidate = { hash: "test-hash", signed: "test-signed-transaction" };
  const chain: WorkerChain = {
    health: async () => {},
    read: async () => ({ ...snapshot, time: Date.now() }),
    authorize: async () => 1n,
    finalizedTransaction: async () => "unknown",
    prepare: async (_task, _block, _nonce, vote) => {
      signed += 1;
      assert.equal(vote.down_mask, "1");
      assert.equal(vote.up_mask, "0");
      return candidate;
    },
    broadcast: async (_task, vote, pending) => {
      assert.deepEqual(store.getTask(id).pending, candidate);
      assert.deepEqual(pending, candidate);
      if (++sent === 1) throw new Error("simulated RPC timeout before inclusion");
      snapshot.agreement.votes[0] = { submitted: true, ...vote };
      return "accepted";
    },
  };
  const run = (signal: AbortSignal) => workerRunner({
    store, chain, identity, verify, signal,
    targets: { network: assignment.network, contract: assignment.contract, codeHash: assignment.code_hash, endpoints: new Set([loopbackHealth]) },
    fetch: async () => { probes += 1; throw new Error("simulated local transport failure"); },
  }).run();
  let stop = new AbortController();
  let running = run(stop.signal);
  try { await waitFor(() => sent === 1 && store.getTask(id).attempts === 1); }
  finally { stop.abort(); await running; }
  store.close();
  store = openWorkerStore(directory);
  stop = new AbortController();
  running = run(stop.signal);
  try { await waitFor(() => store.getTask(id).phase === "recorded"); }
  finally { stop.abort(); await running; }
  assert.deepEqual([probes, signed, sent], [1, 1, 2]);
  assert.equal(store.getTask(id).transactionHash, candidate.hash);
  assert.deepEqual(store.getTask(id).evidence?.evidence.observations.map(({ reason }) => reason), ["server_error", "transport"]);
});
