import assert from "node:assert/strict";
import test from "node:test";
import { reportVote } from "../src/oracles/oracle-flow.ts";
import type { Agreement, Snapshot, Vote } from "../src/oracles/oracle-flow.ts";

const oracle = "alice.testnet";
const vote: Vote = { sla_id: "7", up_mask: "17", down_mask: "14", evidence_hash: Array(32).fill(1) };
const bundle = { contract_vote: vote };

function fixture() {
  const idle = { submitted: false, up_mask: "0", down_mask: "0", evidence_hash: Array(32).fill(0) };
  const agreement: Agreement = {
    policy_version: 1,
    oracles: [oracle, "bob.testnet", "carol.testnet"],
    endpoint_hash: Array(32).fill(2),
    starts_at_ms: "50",
    ends_at_ms: "100",
    reporting_deadline_ms: "200",
    slot_ms: 1_000,
    slot_count: 5,
    accepted: true,
    outcome: "undecided",
    votes: [idle, idle, idle],
  };
  let now = 99n;
  let saved: typeof bundle | undefined;
  const counters = { measured: 0, sent: 0, waits: 0 };
  const recordVote = (recorded = vote) => {
    agreement.votes[0] = {
      submitted: true,
      up_mask: recorded.up_mask,
      down_mask: recorded.down_mask,
      evidence_hash: recorded.evidence_hash,
    };
  };
  const options = {
    oracle,
    submit: true,
    read: async (): Promise<Snapshot> => ({ agreement: structuredClone(agreement), blockTimeMs: now }),
    load: async () => saved,
    store: async (newBundle: typeof bundle) => {
      saved ??= newBundle;
      return saved;
    },
    measure: async () => {
      counters.measured += 1;
      return bundle;
    },
    verify: async (loaded: typeof bundle) => loaded === bundle,
    wait: async () => { counters.waits += 1; now = 100n; },
    send: async (submitted: Vote) => {
      assert.ok(saved, "evidence must be on disk before submission");
      assert.deepEqual(submitted, saved.contract_vote);
      counters.sent += 1;
      recordVote(submitted);
      return "test-transaction-hash";
    },
  };
  return { agreement, options, counters, recordVote, setTime: (time: bigint) => { now = time; } };
}

test("collect-only mode archives evidence without a transaction", async () => {
  const { options, counters } = fixture();
  assert.deepEqual(await reportVote({ ...options, submit: false }), { status: "evidence_ready" });
  assert.equal(await options.load(), bundle);
  assert.deepEqual(counters, { measured: 1, sent: 0, waits: 0 });
});

test("waits for a finalized eligible block, submits once and is safe to rerun", async () => {
  const { options, counters } = fixture();
  assert.deepEqual(await reportVote(options), {
    status: "recorded",
    transaction_hash: "test-transaction-hash",
  });
  assert.deepEqual(await reportVote(options), { status: "already_recorded" });
  assert.deepEqual(counters, { measured: 1, sent: 1, waits: 1 });
});

test("reconciles a lost response against the final vote", async () => {
  const { options, counters } = fixture();
  const realSend = options.send;
  options.send = async (submitted) => {
    await realSend(submitted);
    throw new Error("RPC response lost");
  };
  assert.deepEqual(await reportVote(options), { status: "recorded_after_rpc_error" });
  assert.equal(counters.sent, 1);
});

test("reports an unconfirmed submission without silently retrying", async () => {
  const { options, counters } = fixture();
  options.send = async () => {
    counters.sent += 1;
    throw new Error("RPC timeout");
  };
  await assert.rejects(reportVote(options), /Submission unconfirmed/);
  assert.equal(counters.sent, 1);
  assert.equal(await options.load(), bundle);
});

test("rejects an expired reporting period before signing", async () => {
  const { options, counters, setTime } = fixture();
  await options.store(bundle);
  setTime(200n);
  await assert.rejects(reportVote(options), /outside the reporting period/);
  assert.equal(counters.sent, 0);
});

test("rejects a conflicting vote or missing archive", async () => {
  const { options, counters, recordVote } = fixture();
  recordVote({ ...vote, down_mask: "4" });
  await assert.rejects(reportVote(options), /Restore the original evidence/);
  await options.store(bundle);
  await assert.rejects(reportVote(options), /Recorded vote differs/);
  assert.equal(counters.sent, 0);
});

test("rejects unauthorized identities and archives that fail verification", async () => {
  const { options, counters } = fixture();
  await assert.rejects(reportVote({ ...options, oracle: "unknown.testnet" }), /unauthorized/);
  await assert.rejects(reportVote({ ...options, verify: async () => false }), /does not match/);
  assert.equal(counters.sent, 0);
});
