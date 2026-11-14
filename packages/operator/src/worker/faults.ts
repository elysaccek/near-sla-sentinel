import { faultWindowAt } from "../../../shared/fault-protocol.ts";
import type { SignedFaultSchedule } from "../../../shared/fault-protocol.ts";
import { isSandboxNetwork } from "../../../shared/oracle-protocol.ts";
import type { WorkerStore } from "./store.ts";

export type FaultVerifier = (value: unknown) => SignedFaultSchedule;
type FaultStore = Pick<WorkerStore, "faultSchedule" | "saveFaultSchedule" | "openFaultWindow" | "startFaultWindow" | "finishFaultWindow">;

export function faultManager(
  network: string, store: FaultStore, verify: FaultVerifier, event?: (message: string) => void,
) {
  if (!isSandboxNetwork(network)) throw new Error("Demo faults require an isolated Sandbox network");
  const cached = store.faultSchedule();
  let envelope = cached === undefined ? undefined : verify(cached);
  let entered = store.openFaultWindow();
  let watchdogDeadline = Infinity;
  let stopped: string | undefined;

  function update(value: unknown) {
    const next = verify(value);
    if (envelope && next.plan.revision < envelope.plan.revision) return;
    if (envelope && next.plan.revision === envelope.plan.revision) {
      if (JSON.stringify(next.plan) !== JSON.stringify(envelope.plan)) throw new Error("Conflicting demo fault revision");
      return;
    }
    store.saveFaultSchedule(next);
    envelope = next;
  }

  function tick(now: number, monotonic: number) {
    const schedule = envelope?.plan.schedule;
    const window = schedule && faultWindowAt(schedule, now);
    const key = window && envelope ? envelope.plan.revision + ":" + window.start : undefined;
    if (entered && entered !== key) {
      if (store.finishFaultWindow(entered, now)) event?.("Controlled target fault ended");
      entered = undefined;
      watchdogDeadline = Infinity;
    }
    if (!key || !window || !schedule || !envelope || stopped === key) return false;
    if (entered === key && monotonic >= watchdogDeadline) {
      if (store.finishFaultWindow(key, now)) event?.("Controlled target fault ended");
      entered = undefined;
      stopped = key;
      return false;
    }
    if (entered === key && watchdogDeadline === Infinity) watchdogDeadline = monotonic + window.end - now;
    if (entered !== key) {
      if (!store.startFaultWindow(key, envelope.plan.revision, window.start, window.end, now, schedule.reason)) {
        stopped = key;
        return false;
      }
      event?.("Controlled target fault started");
      entered = key;
      watchdogDeadline = monotonic + window.end - now;
    }
    return true;
  }

  return { update, tick };
}
