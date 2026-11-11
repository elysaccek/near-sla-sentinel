import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assessWindow, createEvidenceBundle, EVIDENCE_DOMAIN, verifyEvidenceBundle } from "../src/monitoring/evidence.ts";
import type { EvidenceConfig, ProbeObservation } from "../src/monitoring/evidence.ts";
import { collectEvidence, hashEndpoint, LOCAL_DEMO_ENDPOINT } from "../src/monitoring/monitor.ts";

const START = 10_000;
const endpoint = "https://api.example.com/health";
const config: EvidenceConfig = {
  network: "testnet",
  contract: "sentinel.testnet",
  sla_id: "1",
  oracle: "oracle.testnet",
  endpoint_hash: await hashEndpoint(endpoint),
  starts_at_ms: String(START),
  slot_ms: 1_000,
  slot_count: 4,
};

function probe(slot: number, http_status: number | null, offset = 100): ProbeObservation {
  const started_at_ms = START + config.slot_ms * slot;
  return { slot, started_at_ms, finished_at_ms: started_at_ms + offset, http_status };
}

test("normalizes slots, preserves bit 63, and uses only timely 200 or 5xx responses", async () => {
  const bundle = await createEvidenceBundle({ ...config, slot_count: 64 }, [
    probe(63, 503), probe(2, 503, 1_000), probe(1, 429), probe(0, 200), probe(4, null),
  ]);
  assert.equal(bundle.evidence.domain, EVIDENCE_DOMAIN);
  assert.equal(bundle.contract_vote.up_mask, "1");
  assert.equal(bundle.contract_vote.down_mask, "9223372036854775808");
  assert.deepEqual(bundle.evidence.observations.slice(0, 5).map(({ reason }) => reason), [
    "ok", "other_status", "late", "missing", "transport",
  ]);
  assert.equal(bundle.evidence.observations.length, 64);
  assert.equal(await verifyEvidenceBundle(bundle), true);
});

test("evidence verification binds exact chain vote and identity and rejects altered fields", async () => {
  const bundle = await createEvidenceBundle(config, [probe(0, 200), probe(1, 500)]);
  const expected = { config, contract_vote: bundle.contract_vote };
  assert.equal(await verifyEvidenceBundle(JSON.parse(JSON.stringify(bundle)), expected), true);
  assert.equal(await verifyEvidenceBundle(bundle, { ...expected, config: { ...config, sla_id: "2" } }), false);
  assert.equal(await verifyEvidenceBundle(bundle, {
    ...expected,
    contract_vote: { ...bundle.contract_vote, down_mask: "4" },
  }), false);
  const changed = structuredClone(bundle);
  changed.evidence.observations[1].http_status = 502;
  assert.equal(await verifyEvidenceBundle(changed, expected), false);
  assert.equal(await verifyEvidenceBundle({ ...bundle, injected: "unknown field" } as typeof bundle), false);

  const payload = JSON.stringify({
    contract: "sentinel.testnet",
    domain: "sla-sentinel/evidence/v1",
    endpoint_hash: config.endpoint_hash,
    network: "testnet",
    observations: [
      { finished_at_ms: 10100, http_status: 200, reason: "ok", result: "up", slot: 0, started_at_ms: 10000 },
      { finished_at_ms: 11100, http_status: 500, reason: "server_error", result: "down", slot: 1, started_at_ms: 11000 },
      { finished_at_ms: null, http_status: null, reason: "missing", result: "unknown", slot: 2, started_at_ms: null },
      { finished_at_ms: null, http_status: null, reason: "missing", result: "unknown", slot: 3, started_at_ms: null },
    ],
    oracle: "oracle.testnet",
    sla_id: "1",
    slot_count: 4,
    slot_ms: 1_000,
    starts_at_ms: "10000",
  });
  assert.deepEqual(bundle.contract_vote.evidence_hash, Array.from(createHash("sha256").update(payload).digest()));
});

test("invalid agreement metadata and duplicate observations fail before producing a vote", async () => {
  await assert.rejects(createEvidenceBundle({ ...config, slot_count: 65 }, []), /Invalid measurement schedule/);
  await assert.rejects(createEvidenceBundle({ ...config, sla_id: "18446744073709551616" }, []), /Invalid evidence identity/);
  await assert.rejects(createEvidenceBundle(config, [probe(0, 200), probe(0, 503)]), /duplicate/);
});

test("collector waits for scheduled slots, rejects redirects, and leaves missing probes unknown", async () => {
  let time = START + 1_000;
  const statuses = [302, 503, null];
  const bundle = await collectEvidence(config, endpoint, {
    now: () => time,
    sleep: async (ms) => { time += ms; },
    fetch: async (url, options) => {
      assert.equal(url, endpoint);
      assert.equal(options?.redirect, "manual");
      const status = statuses.shift();
      if (status === null) {
        throw new Error("connection failed");
      }
      time += 100;
      return new Response(null, { status });
    },
  });
  assert.equal(bundle.contract_vote.up_mask, "0");
  assert.equal(bundle.contract_vote.down_mask, "4");
  assert.deepEqual(bundle.evidence.observations.map(({ reason }) => reason), [
    "missing", "other_status", "server_error", "transport",
  ]);
  assert.equal(time, START + config.slot_ms * config.slot_count);
});

test("collector rejects a different endpoint before fetching and gates loopback by demo mode", async () => {
  await assert.rejects(hashEndpoint(LOCAL_DEMO_ENDPOINT), /preapproved HTTPS/);
  await assert.rejects(hashEndpoint("http://127.0.0.1:8787/other", { localDemo: true }), /fixed loopback/);
  const local = await hashEndpoint(LOCAL_DEMO_ENDPOINT, { localDemo: true });
  assert.deepEqual(local, Array.from(createHash("sha256").update(LOCAL_DEMO_ENDPOINT).digest()));
  let fetched = false;
  await assert.rejects(collectEvidence(config, "https://other.example.com/health", {
    fetch: async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    },
  }), /differs from the agreement/);
  assert.equal(fetched, false);
});

test("recomputes the contract's same-pair bounds including missing and 64-bit votes", () => {
  const vote = (up_mask: number, down_mask: number) => ({ up_mask: String(up_mask), down_mask: String(down_mask) });
  assert.deepEqual(assessWindow(5, 3, [vote(17, 6), vote(17, 14), vote(17, 12)]), {
    outcome: "inconclusive", confirmed: 2, possible: 3,
  });
  assert.deepEqual(assessWindow(5, 3, [vote(17, 14), vote(17, 14), vote(17, 12)]), {
    outcome: "breach", confirmed: 3, possible: 3,
  });
  assert.deepEqual(assessWindow(5, 3, [vote(4, 0), vote(4, 0), null]), {
    outcome: "healthy", confirmed: 0, possible: 2,
  });
  const allDown = { up_mask: "0", down_mask: "18446744073709551615" };
  assert.deepEqual(assessWindow(64, 64, [allDown, allDown, null]), {
    outcome: "breach", confirmed: 64, possible: 64,
  });
  assert.throws(() => assessWindow(5, 3, [vote(1, 1), null, null]), /overlaps/);
});
