import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import { faultScheduleMessage, faultWindowAt, parseFaultSchedule, parseFaultWindow } from "../../shared/fault-protocol.ts";
import type { FaultSchedule } from "../../shared/fault-protocol.ts";
import { createEvidenceBundle, createWorkerEvidenceBundle, verifyEvidenceBundle } from "../src/monitoring/evidence.ts";
import type { EvidenceConfig, ProbeContext, ProbeObservation } from "../src/monitoring/evidence.ts";
import { controlProbe, inspectSlot } from "../src/worker/diagnostics.ts";
import { faultManager } from "../src/worker/faults.ts";
import { masterVerifiers } from "../src/worker/master-client.ts";
import type { WorkerIdentity } from "../src/worker/identity.ts";

const start = 1_790_000_000_000;
const target = "https://api.example.com/health";
const config: EvidenceConfig = {
  network: "testnet", contract: "escrow.testnet", sla_id: "0", oracle: "oracle.testnet",
  endpoint_hash: Array<number>(32).fill(1), starts_at_ms: String(start), slot_ms: 3000, slot_count: 8,
};

test("evidence binds target and control diagnostics without turning suspect failures into DOWN votes", async () => {
  const results = [
    { error: { cause: { code: "ENOTFOUND" } }, control: "reachable", diagnostic: "DNS_FAILURE" },
    { error: { code: "ECONNREFUSED" }, control: "reachable", diagnostic: "TCP_FAILURE" },
    { error: { code: "CERT_HAS_EXPIRED" }, control: "unavailable", diagnostic: "LOCAL_FAULT/TLS_FAILURE" },
    { error: { name: "AbortError" }, control: "reachable", diagnostic: "TIMEOUT" },
    { status: 503, control: "unavailable", diagnostic: "LOCAL_FAULT/CONTROL" },
    { status: 503, control: "checking", diagnostic: "CONTROL_PENDING" },
    { status: 503, control: "reachable" },
    { status: 200, control: "unavailable" },
  ] as const;
  const observations: ProbeObservation[] = [];
  const context: ProbeContext[] = [];
  for (const [slot, result] of results.entries()) {
    const now = () => start + slot * config.slot_ms;
    const fetch: typeof globalThis.fetch = async () => {
      if ("error" in result) throw result.error;
      return new Response(null, { status: result.status });
    };
    const observed = await inspectSlot(config, target, slot, now, () => 0, fetch, new AbortController().signal,
      () => result.control, { localClock: false, controlledFault: false });
    assert.ok(observed);
    assert.equal(observed.context.diagnostic, "diagnostic" in result ? result.diagnostic : null);
    assert.equal(observed.context.observed_http_status, "status" in result ? result.status : null);
    observations.push(observed.observation);
    context.push(observed.context);
  }
  const bundle = await createWorkerEvidenceBundle(config, observations, context);
  assert.deepEqual(bundle.evidence.observations.map(({ result }) => result),
    ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "down", "up"]);
  assert.equal(bundle.contract_vote.down_mask, "64");
  assert.equal(bundle.contract_vote.up_mask, "128");
  assert.equal(bundle.evidence.domain, "sla-sentinel/evidence/v2");
  assert.equal(bundle.evidence.observations[4].http_status, null);
  assert.equal(bundle.evidence.observations[4].observed_http_status, 503);
  assert.equal(bundle.evidence.observations[4].started_at_ms, start + 4 * config.slot_ms);
  const expected = { config, contract_vote: bundle.contract_vote };
  assert.equal(await verifyEvidenceBundle(bundle, expected), true);
  const changed = structuredClone(bundle);
  changed.evidence.observations[4].observed_http_status = 502;
  assert.equal(await verifyEvidenceBundle(changed, expected), false);
  await assert.rejects(createWorkerEvidenceBundle(config, observations,
    context.map((entry) => entry.slot === 6 ? { ...entry, control_state: "unavailable" } : entry)), /Invalid diagnostic/);
  const historical = await createEvidenceBundle(config, observations);
  assert.equal(await verifyEvidenceBundle(historical), true);
  assert.equal(historical.contract_vote.down_mask, bundle.contract_vote.down_mask);
  assert.equal(historical.contract_vote.up_mask, bundle.contract_vote.up_mask);
});

test("clock jumps and a controlled local fault cannot contribute an HTTP status", async () => {
  let time = start;
  const signal = new AbortController().signal;
  const fetch: typeof globalThis.fetch = async () => { time += 1200; return new Response(null, { status: 503 }); };
  const observed = await inspectSlot(config, target, 0, () => time, () => 0, fetch, signal, () => "reachable",
    { localClock: false, controlledFault: false });
  assert.equal(observed?.context.diagnostic, "LOCAL_FAULT/CLOCK");
  assert.equal(observed?.observation.http_status, null);
  const skip = await inspectSlot(config, target, 0, () => time, () => 0, async () => assert.fail("fault must skip HTTP"),
    signal, () => "reachable", { localClock: false, controlledFault: true });
  assert.equal(skip?.context.diagnostic, "CONTROLLED_FAULT");
  assert.equal(skip?.observation.http_status, null);
});

test("control reachability is independent of its HTTP status and expires", async () => {
  let count = 0;
  const check = controlProbe(["https://control.example.net/health", "https://backup.example.org/health"], async (url) => {
    count += 1;
    if (String(url).includes("backup")) throw new Error("unavailable");
    return new Response(null, { status: 503 });
  }, () => start);
  const signal = new AbortController().signal;
  assert.equal(check.state(start), "checking");
  check.refresh(start, signal);
  check.refresh(start, signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(count, 2);
  assert.equal(check.state(start), "reachable");
  assert.equal(check.state(start + 31_000), "checking");
  assert.equal(check.state(start - 1), "checking");
});

const window = parseFaultWindow({
  fault_type: "target_connectivity", starts_at_ms: start, interval_seconds: 10, duration_seconds: 2,
  expires_at_ms: start + 25_000, reason: "Sandbox local connectivity",
});

test("fault windows are bounded and recover between occurrences", () => {
  assert.throws(() => parseFaultWindow({ ...window, duration_seconds: 121 }), /Invalid demo schedule/);
  assert.throws(() => parseFaultWindow({ ...window, interval_seconds: 2 }), /Invalid demo schedule/);
  assert.equal(faultWindowAt(window, start - 1), undefined);
  assert.deepEqual(faultWindowAt(window, start), { start, end: start + 2000 });
  assert.equal(faultWindowAt(window, start + 2000), undefined);
  assert.deepEqual(faultWindowAt(window, start + 10_000), { start: start + 10_000, end: start + 12_000 });
  assert.equal(faultWindowAt(window, start + 25_000), undefined);
});

test("signed node-specific schedules cannot roll back and stop at their monotonic deadline", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity: WorkerIdentity = {
    node_id: randomUUID(), network: "test-chain-diag", audience: "sandbox.demo", master: "http://127.0.0.1:8789",
    near_account: "oracle.test.near", near_public_key: "", identity_key: "", sign: () => "",
  };
  const der = publicKey.export({ format: "der", type: "spki" });
  const verify = masterVerifiers(identity, der).fault;
  const envelope = (plan: FaultSchedule) => ({
    plan, signature: sign(null, Buffer.from(faultScheduleMessage(identity.audience, identity.network, identity.node_id, plan)), privateKey).toString("base64url"),
  });
  let saved: unknown;
  let opened: string | undefined;
  const completed = new Set<string>();
  const db = {
    faultSchedule: () => saved, saveFaultSchedule: (value: unknown) => { saved = value; },
    openFaultWindow: () => opened,
    startFaultWindow(id: string) {
      if (completed.has(id)) return false;
      opened = id;
      return true;
    },
    finishFaultWindow(id: string) {
      completed.add(id);
      opened = undefined;
      return true;
    },
  };
  assert.throws(() => faultManager("testnet", db, verify), /Sandbox/);
  const events: string[] = [];
  const demo = faultManager(identity.network, db, verify, (value) => events.push(value));
  const active = envelope(parseFaultSchedule({ revision: 1, schedule: window }));
  assert.throws(() => masterVerifiers({ ...identity, node_id: randomUUID() }, der).fault(active), /signature/);
  assert.throws(() => verify({ ...active, plan: { ...active.plan, schedule: { ...window, reason: "different" } } }), /signature/);
  demo.update(active);
  assert.ok(demo.tick(start, 0));
  assert.equal(demo.tick(start + 100, 2000), false, "the wall clock stalled");
  assert.equal(demo.tick(start + 100, 2100), false);
  const restarted = faultManager(identity.network, db, verify, (value) => events.push(value));
  assert.equal(restarted.tick(start + 100, 0), false, "a completed occurrence is not reopened on restart");
  assert.ok(restarted.tick(start + 10_000, 10_000));
  restarted.update(envelope({ revision: 2, schedule: null }));
  restarted.update(active);
  assert.equal(restarted.tick(start + 10_100, 10_100), false);
  assert.deepEqual(events, ["Controlled target fault started", "Controlled target fault ended",
    "Controlled target fault started", "Controlled target fault ended"]);
});
