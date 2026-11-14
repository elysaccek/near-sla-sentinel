import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { approvedEndpoint, isLoopbackOrigin, isSandboxNetwork, loopbackControl, loopbackHealth } from "../../../shared/oracle-protocol.ts";
import type { Assignment, SignedAssignment } from "../../../shared/oracle-protocol.ts";
import { createWorkerEvidenceBundle, verifyEvidenceBundle } from "../monitoring/evidence.ts";
import type { ContractVote, EvidenceConfig } from "../monitoring/evidence.ts";
import { hashEndpoint } from "../monitoring/monitor.ts";
import { controlProbe, inspectSlot } from "./diagnostics.ts";
import { exportEvidence } from "./evidence-export.ts";
import { faultManager } from "./faults.ts";
import type { FaultVerifier } from "./faults.ts";
import type { WorkerIdentity } from "./identity.ts";
import { masterClient, workerVersion } from "./master-client.ts";
import { checkSnapshot, WorkerPolicyError } from "./near.ts";
import type { CheckedVote, WorkerChain } from "./near.ts";
import { fetchPublicStatus } from "./probe.ts";
import { assignmentId } from "./store.ts";
import type { WorkerStore } from "./store.ts";

export interface TrustedTargets {
  network: string;
  contract: string;
  codeHash: string;
  endpoints: ReadonlySet<string>;
}

export function validateTarget(assignment: Assignment, oracle: string, targets: TrustedTargets) {
  if (assignment.network !== targets.network || assignment.contract !== targets.contract
      || assignment.code_hash !== targets.codeHash || !targets.endpoints.has(assignment.endpoint)
      || (assignment.network === "testnet" && assignment.endpoint === loopbackHealth)
      || !assignment.policy.oracles.includes(oracle)) {
    throw new WorkerPolicyError("Assignment is outside this worker's local contract, target or oracle policy");
  }
  try { approvedEndpoint(assignment.endpoint, assignment.endpoint === loopbackHealth); }
  catch { throw new WorkerPolicyError("Invalid target URL"); }
}

function config(assignment: Assignment, oracle: string): EvidenceConfig {
  const { policy, network, contract, sla_id } = assignment;
  return {
    network, contract, sla_id, oracle, endpoint_hash: policy.endpoint_hash,
    starts_at_ms: policy.starts_at_ms, slot_ms: policy.slot_ms, slot_count: policy.slot_count,
  };
}

function matches(recorded: CheckedVote, vote: ContractVote) {
  return recorded.up_mask === vote.up_mask && recorded.down_mask === vote.down_mask
    && recorded.evidence_hash.every((byte, index) => byte === vote.evidence_hash[index]);
}

interface RunnerOptions {
  store: WorkerStore;
  chain: WorkerChain;
  identity: WorkerIdentity;
  targets: TrustedTargets;
  verify: (value: unknown) => SignedAssignment;
  signal: AbortSignal;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  controls?: readonly string[];
  verifyFault?: FaultVerifier;
  evidenceDirectory?: string;
  event?: (message: string) => void;
}

export function workerRunner({
  store, chain, identity, targets, verify, signal: callerSignal, now = Date.now, fetch, controls = [], verifyFault, evidenceDirectory, event,
}: RunnerOptions) {
  if (controls.length > 2) throw new Error("Configure at most two independent control endpoints");
  const controlHosts = new Set<string>();
  for (const endpoint of controls) {
    const local = endpoint === loopbackControl && isSandboxNetwork(targets.network) && isLoopbackOrigin(identity.master);
    const hostname = local ? endpoint : new URL(approvedEndpoint(endpoint)).hostname;
    if (controlHosts.has(hostname) || [...targets.endpoints].some((target) => new URL(target).hostname === hostname)) {
      throw new Error("Control and SLA target hostnames must be distinct");
    }
    controlHosts.add(hostname);
  }
  const stop = new AbortController();
  const signal = AbortSignal.any([callerSignal, stop.signal]);
  const oracle = identity.near_account;
  const measuring = new Set<string>();
  const checking = new Set<string>();
  if (verifyFault && (identity.network !== targets.network || !isLoopbackOrigin(identity.master))) {
    throw new Error("Demo faults require a local Sandbox worker");
  }
  const client = masterClient(identity, signal);
  const control = controlProbe(controls, fetch ?? ((url, options) =>
    url === loopbackControl ? globalThis.fetch(url, options) : fetchPublicStatus(url, options)));
  const faults = verifyFault && faultManager(targets.network, store, verifyFault, event);
  const openFault = !faults && store.openFaultWindow();
  if (openFault && store.finishFaultWindow(openFault, now())) event?.("Controlled target fault ended");
  let chainHealth = "not checked";
  let lastDiagnostic = "";
  let lastError = "";
  let assignmentCursor: string | undefined;
  let currentReport: Promise<void> | undefined;
  let probeClock = { wall: now(), monotonic: performance.now() };
  let probeBlockedUntil = 0;
  let currentFault = false;

  function load(id: string) {
    const task = store.getTask(id);
    let assignment: Assignment;
    try { ({ assignment } = verify(task.envelope)); }
    catch { throw new WorkerPolicyError("Cached assignment signature failed verification"); }
    validateTarget(assignment, oracle, targets);
    return { task, assignment };
  }

  function persistPolicyError(id: string, error: unknown) {
    if (error instanceof WorkerPolicyError) {
      store.finish(id, "blocked", error.message);
      event?.(id + " blocked: " + error.message);
      return true;
    }
    return false;
  }

  function retry(id: string, reason: string) {
    const { attempts, pending } = store.getTask(id);
    const wait = Math.min(30_000, 750 * 2 ** Math.min(attempts, 6));
    lastError = reason;
    store.retry(id, now() + (pending ? Math.min(wait, 6000) : wait), reason);
  }

  async function accept(input: unknown) {
    const envelope = verify(input);
    const { assignment } = envelope;
    validateTarget(assignment, oracle, targets);
    if (now() >= Number(assignment.policy.ends_at_ms)) return;
    const hash = await hashEndpoint(assignment.endpoint, { localDemo: assignment.endpoint === loopbackHealth });
    if (!hash.every((byte, index) => byte === assignment.policy.endpoint_hash[index])) {
      throw new WorkerPolicyError("Assignment endpoint hash differs from its signed policy");
    }
    if (store.saveAssignment(envelope)) event?.(assignmentId(assignment) + " cached");
  }

  async function syncControl() {
    const status = await client.status();
    store.setRegistration(status);
    if (status !== "ACTIVE") {
      assignmentCursor = undefined;
      return;
    }
    const lastMeasurement = store.lastMeasurement();
    try { await chain.health(); chainHealth = "ok"; }
    catch { chainHealth = "RPC_UNAVAILABLE"; }
    const heartbeat = client.heartbeat({
      version: workerVersion,
      uptime: Math.floor(process.uptime()) + " seconds",
      cpu: Math.round(process.cpuUsage().user / 1000) + " ms user",
      ram: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MiB RSS",
      active_slas: String(store.activeCount()),
      rpc: chainHealth,
      queue: String(store.pendingCount()),
      control: control.state(performance.now()),
      clock: performance.now() < probeBlockedUntil ? "unstable" : "stable",
      fault: currentFault ? "active" : faults ? "inactive" : "disabled",
      ...(lastMeasurement ? { last_measurement: lastMeasurement } : {}),
      ...(lastError ? { last_error: lastError } : {}),
      ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}),
    }).catch(() => { if (!signal.aborted) event?.("Master heartbeat unavailable"); });
    const faultSync = faults && client.faultSchedule().then((value) => {
      if (value !== null) faults.update(value);
    }).catch(() => { if (!signal.aborted) event?.("Keeping the cached demo fault schedule"); });
    try {
      for (let count = 0; count < 4 && !signal.aborted; count += 1) {
        const page = await client.assignments(assignmentCursor);
        for (const item of page.items) {
          try { await accept(item); }
          catch { event?.("Ignored an assignment outside local worker policy"); }
        }
        assignmentCursor = page.next ?? undefined;
        if (!assignmentCursor) break;
      }
    } finally { await Promise.all([heartbeat, faultSync]); }
  }

  async function authorize(id: string) {
    try {
      const { assignment } = load(id);
      if (now() >= Number(assignment.policy.reporting_deadline_ms)) {
        store.finish(id, "closed", "Window ended before worker authorization");
        return;
      }
      const snapshot = await chain.read(assignment);
      chainHealth = "ok";
      const current = checkSnapshot(assignment, snapshot, oracle);
      if (!current.open || current.vote.submitted || snapshot.time >= Number(assignment.policy.ends_at_ms)) {
        store.finish(id, "closed", "Agreement closed or vote already exists");
        return;
      }
      if (!current.accepted) {
        const starts = Number(assignment.policy.starts_at_ms);
        store.setNextCheck(id, now() + (starts - now() > 15_000 ? 5000 : 1000));
        return;
      }
      if (Math.abs(snapshot.clockSkewMs) > Math.min(30_000, Math.max(5000, assignment.policy.slot_ms * 2))) {
        lastDiagnostic = "LOCAL_FAULT/CLOCK";
        retry(id, "Worker clock differs from final chain time");
        return;
      }
      if (now() >= Number(assignment.policy.ends_at_ms)) {
        store.setNextCheck(id, now() + 1000);
        return;
      }
      await chain.authorize(assignment, snapshot);
      if (!signal.aborted) store.setAuthorized(id);
    } catch (error) {
      if (signal.aborted || persistPolicyError(id, error)) return;
      chainHealth = "RPC_UNAVAILABLE";
      retry(id, "Finalized authorization unavailable");
    }
  }

  async function measure(id: string, localClock: boolean, controlledFault: boolean) {
    try {
      const { assignment } = load(id);
      const fields = config(assignment, oracle);
      const slot = Math.floor((now() - Number(fields.starts_at_ms)) / fields.slot_ms);
      if (slot < 0 || slot >= fields.slot_count || !store.claimSlot(id, slot)) return;
      const source = fetch ?? (assignment.endpoint === loopbackHealth ? globalThis.fetch : fetchPublicStatus);
      const result = await inspectSlot(fields, assignment.endpoint, slot, now, () => performance.now(), source, signal,
        () => control.state(performance.now()), { localClock, controlledFault });
      if (result && !signal.aborted) {
        const { observation, context } = result;
        store.finishSlot(id, observation, context);
        lastDiagnostic = context.diagnostic ?? "";
        if (observation.finished_at_ms !== null) store.setLastMeasurement(observation.finished_at_ms);
      }
    } catch (error) {
      if (signal.aborted || persistPolicyError(id, error)) return;
      event?.(id + " could not persist observation");
    }
  }

  async function report(id: string) {
    let deadline = Infinity;
    try {
      const { assignment, task } = load(id);
      deadline = Number(assignment.policy.reporting_deadline_ms);
      const fields = config(assignment, oracle);
      const snapshot = await chain.read(assignment);
      chainHealth = "ok";
      const current = checkSnapshot(assignment, snapshot, oracle);
      const { policy } = assignment;
      if (snapshot.time < Number(policy.ends_at_ms) || now() < Number(policy.ends_at_ms)) {
        store.setNextCheck(id, now() + 1000);
        return;
      }
      const evidence = task.evidence ?? store.saveEvidence(id,
        await createWorkerEvidenceBundle(fields, store.observations(id), store.probeContext(id)));
      const vote = evidence.contract_vote;
      if (!await verifyEvidenceBundle(evidence, { config: fields, contract_vote: vote })) {
        throw new WorkerPolicyError("Saved evidence differs from the agreement");
      }
      if (current.vote.submitted) {
        if (!matches(current.vote, vote)) throw new WorkerPolicyError("Finalized vote differs from the saved evidence");
        store.finish(id, "recorded", null, task.pending?.hash ?? null);
        event?.(id + " vote confirmed at finality");
        return;
      }
      if (!current.accepted || !current.open || snapshot.time >= Number(policy.reporting_deadline_ms)) {
        store.finish(id, "closed", "Reporting window closed without a matching vote");
        return;
      }
      let pending = task.pending;
      if (pending) {
        const finalized = await chain.finalizedTransaction(assignment, vote, pending);
        if (finalized === "failed") {
          store.finish(id, "blocked", "Vote transaction failed at finality", pending.hash);
          return;
        }
        if (finalized === "success") {
          // The agreement view may precede this receipt. Recheck it before marking the task recorded.
          store.setNextCheck(id, now() + 1000);
          return;
        }
      }
      const nonce = await chain.authorize(assignment, snapshot);
      if (signal.aborted) return;
      pending ??= store.savePending(id, await chain.prepare(assignment, snapshot, nonce, vote));
      if (signal.aborted) return;
      const result = await chain.broadcast(assignment, vote, pending);
      if (result === "stale") store.clearPending(id, pending.hash);
      store.setNextCheck(id, now() + (result === "accepted" ? 2500 : 1000));
    } catch (error) {
      if (signal.aborted || persistPolicyError(id, error)) return;
      chainHealth = "RPC_UNAVAILABLE";
      if (now() >= deadline + 60_000) store.finish(id, "closed", "Reporting expired; final vote unavailable");
      else retry(id, "Vote or finalized RPC state unavailable");
    }
  }

  function tick() {
    if (signal.aborted) return;
    const time = now();
    const monotonic = performance.now();
    if (Math.abs(time - probeClock.wall - (monotonic - probeClock.monotonic)) > 1000) {
      probeBlockedUntil = monotonic + 5000;
      lastError = "Local wall clock changed";
    }
    probeClock = { wall: time, monotonic };
    currentFault = faults?.tick(time, monotonic) ?? false;
    control.refresh(monotonic, signal);
    for (const id of store.measuring(time)) {
      if (measuring.size >= 16) break;
      if (measuring.has(id)) continue;
      measuring.add(id);
      void measure(id, monotonic < probeBlockedUntil, currentFault)
        .finally(() => measuring.delete(id)).catch(() => event?.("Worker observation task failed"));
    }
    for (const id of store.awaitingAuthorization(time)) {
      if (checking.size >= 4) break;
      if (checking.has(id)) continue;
      checking.add(id);
      void authorize(id).finally(() => checking.delete(id)).catch(() => event?.("Worker authorization task failed"));
    }
    if (!currentReport) {
      const id = store.reportable(time, measuring);
      if (id) {
        currentReport = report(id).catch(() => event?.("Worker reporting task failed"))
          .finally(() => { currentReport = undefined; });
      }
    }
  }

  async function publishEvidence(directory: string) {
    let cursor = 0;
    let failed = false;
    while (!signal.aborted) {
      let wait = 2000;
      try {
        for (const { sequence, evidence } of store.recordedEvidence(cursor)) {
          if (signal.aborted) return;
          if (!await exportEvidence(directory, oracle, evidence)) event?.("Stored evidence failed export verification");
          cursor = sequence;
        }
        failed = false;
      } catch {
        if (!failed) event?.("Evidence export unavailable; retrying from the recorded vote");
        failed = true;
        wait = 5000;
      }
      await sleep(wait, undefined, { signal }).catch(() => {});
    }
  }

  return {
    async run() {
      const evidenceLoop = evidenceDirectory && publishEvidence(evidenceDirectory);
      const controlLoop = (async () => {
        while (!signal.aborted) {
          const started = performance.now();
          try { await syncControl(); }
          catch { if (!signal.aborted) event?.("Master unavailable; using cached assignments"); }
          await sleep(Math.max(1000, 30_000 - (performance.now() - started)), undefined, { signal }).catch(() => {});
        }
      })();
      try {
        while (!signal.aborted) {
          tick();
          await sleep(100, undefined, { signal }).catch(() => {});
        }
      } finally {
        // The caller's signal normally stops both loops. A local database error
        // also needs to stop the control loop before releasing the store.
        stop.abort();
        await controlLoop;
        await evidenceLoop;
        await currentReport;
        while (measuring.size || checking.size) await sleep(10);
      }
    },
  };
}
