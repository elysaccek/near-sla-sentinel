import { performance } from "node:perf_hooks";
import { isRecord } from "../../../shared/oracle-protocol.ts";
import { missingObservation } from "../monitoring/evidence.ts";
import type { ControlState, EvidenceConfig, ProbeContext, ProbeFailure } from "../monitoring/evidence.ts";
import { observeSlot } from "../monitoring/monitor.ts";

const connectionCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EPIPE", "UND_ERR_SOCKET"]);
const timeoutCodes = new Set(["ABORT_ERR", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

export class TransportDiagnostic extends Error {
  readonly diagnostic: ProbeFailure;
  constructor(diagnostic: ProbeFailure) {
    super(diagnostic);
    this.diagnostic = diagnostic;
  }
}

export function transportFailure(error: unknown): ProbeFailure {
  for (let depth = 0; depth < 4 && isRecord(error); depth += 1) {
    if (error instanceof TransportDiagnostic) return error.diagnostic;
    const code = typeof error.code === "string" ? error.code : "";
    if (["ENOTFOUND", "EAI_AGAIN", "ENODATA", "EAI_FAIL"].includes(code)) return "DNS_FAILURE";
    if (error.name === "TimeoutError" || error.name === "AbortError" || timeoutCodes.has(code)) return "TIMEOUT";
    if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED_|UNABLE_TO_)/.test(code)) return "TLS_FAILURE";
    if (connectionCodes.has(code)) return "TCP_FAILURE";
    if (error instanceof AggregateError) {
      const attempts = error.errors.slice(0, 8).map((value: unknown) =>
        isRecord(value) && typeof value.code === "string" ? value.code : "");
      if (attempts.some((code) => timeoutCodes.has(code))) return "TIMEOUT";
      if (attempts.some((code) => connectionCodes.has(code))) return "TCP_FAILURE";
    }
    error = error.cause;
  }
  return "TRANSPORT_FAILURE";
}

export function controlProbe(endpoints: readonly string[], fetch: typeof globalThis.fetch, monotonic = () => performance.now()) {
  let completed: { time: number; state: ControlState } | undefined;
  let pending: Promise<void> | undefined;
  function state(now: number): ControlState {
    if (!endpoints.length) return "not configured";
    if (!completed || now < completed.time || now - completed.time > 30_000) return "checking";
    return completed.state;
  }
  return {
    state,
    refresh(now: number, signal: AbortSignal) {
      if (pending || !endpoints.length || signal.aborted
          || (completed && now >= completed.time && now - completed.time < 10_000)) return;
      pending = (async () => {
        const outcomes = await Promise.all(endpoints.map(async (url) => {
          try {
            const response = await fetch(url, {
              method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
              signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
            });
            void response.body?.cancel().catch(() => {});
            // A response proves transport to the control host even when its application is unhealthy.
            return response.status >= 200 && response.status <= 599;
          } catch { return false; }
        }));
        completed = { time: monotonic(), state: outcomes.some(Boolean) ? "reachable" : "unavailable" };
      })().finally(() => { pending = undefined; });
    },
  };
}

export interface DiagnosticObservation {
  observation: ReturnType<typeof missingObservation>;
  context: ProbeContext;
}

export async function inspectSlot(
  config: EvidenceConfig, url: string, slot: number, now: () => number, monotonic: () => number,
  fetch: typeof globalThis.fetch, signal: AbortSignal, control: () => ControlState,
  flags: { localClock: boolean; controlledFault: boolean },
): Promise<DiagnosticObservation | undefined> {
  if (flags.controlledFault || flags.localClock) {
    return {
      observation: missingObservation(slot),
      context: { slot, observed_http_status: null, control_state: control(),
        diagnostic: flags.controlledFault ? "CONTROLLED_FAULT" : "LOCAL_FAULT/CLOCK" },
    };
  }
  const wallStart = now();
  const monoStart = monotonic();
  let failure: ProbeFailure | undefined;
  const observation = await observeSlot(config, url, slot, now, fetch, signal,
    (error) => { failure = transportFailure(error); });
  if (!observation) return;
  const controlState = control();
  if (Math.abs(now() - wallStart - (monotonic() - monoStart)) > 1000) {
    return { observation: missingObservation(slot),
      context: { slot, observed_http_status: null, control_state: controlState, diagnostic: "LOCAL_FAULT/CLOCK" } };
  }
  const context: ProbeContext = { slot, observed_http_status: observation.http_status, control_state: controlState, diagnostic: null };
  if (failure) {
    context.diagnostic = controlState === "unavailable" ? `LOCAL_FAULT/${failure}` : failure;
    return { observation, context };
  }
  // Require recent corroboration of local connectivity before a configured worker reports DOWN.
  if (observation.http_status !== null && observation.http_status >= 500 && controlState !== "not configured"
      && controlState !== "reachable") {
    context.diagnostic = controlState === "unavailable" ? "LOCAL_FAULT/CONTROL" : "CONTROL_PENDING";
    return { observation: { ...observation, http_status: null }, context };
  }
  return { observation, context };
}
