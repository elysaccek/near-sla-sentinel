import { isRecord } from "./oracle-protocol.ts";

export const faultSchedulePath = "/oracles/fault-schedule";
export const maximumFaultSeconds = 120;
const maximumPlanMs = 7 * 24 * 60 * 60 * 1000;

export interface FaultWindow {
  fault_type: "target_connectivity";
  starts_at_ms: number;
  interval_seconds: number;
  duration_seconds: number;
  expires_at_ms: number;
  reason: string;
}

export interface FaultSchedule {
  revision: number;
  schedule: FaultWindow | null;
}

export interface SignedFaultSchedule {
  plan: FaultSchedule;
  signature: string;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseFaultWindow(value: unknown): FaultWindow {
  if (!isRecord(value) || value.fault_type !== "target_connectivity") throw new Error("Unsupported demo fault type");
  const { starts_at_ms, interval_seconds, duration_seconds, expires_at_ms, reason } = value;
  if (!integer(starts_at_ms, 1) || !integer(expires_at_ms, starts_at_ms + 1)
      || !integer(duration_seconds, 1, maximumFaultSeconds) || !integer(interval_seconds, duration_seconds + 1, 604_800)
      || expires_at_ms - starts_at_ms < duration_seconds * 1000 || expires_at_ms - starts_at_ms > maximumPlanMs
      || typeof reason !== "string" || /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,119}$/.exec(reason)?.[0] !== reason) {
    throw new Error("Invalid demo schedule; check start, expiry, interval, duration and reason");
  }
  return { fault_type: "target_connectivity", starts_at_ms, interval_seconds, duration_seconds, expires_at_ms, reason };
}

export function parseFaultSchedule(value: unknown): FaultSchedule {
  if (!isRecord(value) || !integer(value.revision, 1, 2_147_483_647)) throw new Error("Invalid demo schedule revision");
  return { revision: value.revision, schedule: value.schedule === null ? null : parseFaultWindow(value.schedule) };
}

export function faultScheduleMessage(audience: string, network: string, nodeId: string, plan: FaultSchedule) {
  return JSON.stringify(["sla-sentinel/fault-schedule/v1", audience, network, nodeId, parseFaultSchedule(plan)]);
}

export function faultWindowAt(schedule: FaultWindow, now: number) {
  if (now < schedule.starts_at_ms || now >= schedule.expires_at_ms) return;
  const period = schedule.interval_seconds * 1000;
  const start = schedule.starts_at_ms + Math.floor((now - schedule.starts_at_ms) / period) * period;
  const end = Math.min(start + schedule.duration_seconds * 1000, schedule.expires_at_ms);
  if (now < end) return { start, end };
}
