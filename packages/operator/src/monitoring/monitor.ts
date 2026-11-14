import {
  createEvidenceBundle,
  probeDeadline,
  sha256,
  slotStart,
  validateEvidenceConfig,
} from "./evidence.ts";
import type { EvidenceBundle, EvidenceConfig, ProbeObservation } from "./evidence.ts";
import { approvedEndpoint, loopbackHealth } from "../../../shared/oracle-protocol.ts";

export const LOCAL_DEMO_ENDPOINT = loopbackHealth;

interface MonitorOptions {
  localDemo?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export async function hashEndpoint(endpoint: string, options: { localDemo?: boolean } = {}): Promise<number[]> {
  return sha256(approvedEndpoint(endpoint, options.localDemo ?? false));
}

async function sleepUntil(time: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  let remaining = time - now();
  while (remaining > 0) {
    await sleep(remaining);
    remaining = time - now();
  }
}

export async function observeSlot(
  config: EvidenceConfig, url: string, slot: number, now = Date.now, fetch = globalThis.fetch, signal?: AbortSignal,
  onError?: (error: unknown) => void,
): Promise<ProbeObservation | undefined> {
  const startedAt = now();
  const deadline = probeDeadline(config, slot, startedAt);
  if (startedAt < slotStart(config, slot) || startedAt >= deadline) return;
  let status: number | null = null;
  try {
    const timeout = AbortSignal.timeout(deadline - startedAt);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    status = response.status >= 100 ? response.status : null;
    void response.body?.cancel().catch(() => {});
  } catch (error) {
    // A failed request may be an observer or network fault. It contributes no vote.
    onError?.(error);
  }
  const finishedAt = now();
  return {
    slot, started_at_ms: startedAt, finished_at_ms: Math.max(startedAt, finishedAt),
    http_status: finishedAt >= startedAt ? status : null,
  };
}

export async function collectEvidence(
  config: EvidenceConfig,
  endpoint: string,
  options: MonitorOptions = {},
): Promise<EvidenceBundle> {
  validateEvidenceConfig(config);
  const url = approvedEndpoint(endpoint, options.localDemo ?? false);
  const endpointHash = await sha256(url);
  if (!endpointHash.every((byte, index) => byte === config.endpoint_hash[index])) {
    throw new Error("Preapproved endpoint differs from the agreement");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetch = options.fetch ?? globalThis.fetch;
  const observations: ProbeObservation[] = [];

  for (let slot = 0; slot < config.slot_count; slot += 1) {
    await sleepUntil(slotStart(config, slot), now, sleep);
    const observation = await observeSlot(config, url, slot, now, fetch);
    if (observation) observations.push(observation);
  }

  await sleepUntil(slotStart(config, config.slot_count), now, sleep);
  return createEvidenceBundle(config, observations);
}
