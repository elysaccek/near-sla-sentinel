import {
  createEvidenceBundle,
  probeDeadline,
  sha256,
  slotStart,
  validateEvidenceConfig,
} from "./evidence.ts";
import type { EvidenceBundle, EvidenceConfig, ProbeObservation } from "./evidence.ts";

export const LOCAL_DEMO_ENDPOINT = "http://127.0.0.1:8787/health";

interface MonitorOptions {
  localDemo?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}

function approvedEndpoint(endpoint: string, localDemo: boolean): string {
  if (localDemo) {
    if (endpoint !== LOCAL_DEMO_ENDPOINT) {
      throw new Error("Local demo mode requires the fixed loopback health endpoint");
    }
    return endpoint;
  }

  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.href !== endpoint || url.username || url.password
      || url.search || url.hash || url.port || !url.hostname.includes(".")
      || /^(?:[\d.]+|\[.*\])$/.test(url.hostname) || /\.(?:localhost|local|internal)\.?$/.test(url.hostname)
      || url.hostname.endsWith(".")) {
    throw new Error("Use the exact preapproved HTTPS URL with a public hostname and explicit path");
  }
  return endpoint;
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
    const startedAt = now();
    const deadline = probeDeadline(config, slot, startedAt);
    if (startedAt >= deadline) {
      continue;
    }

    let status: number | null = null;
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(deadline - startedAt),
      });
      status = response.status >= 100 ? response.status : null;
      void response.body?.cancel().catch(() => {});
    } catch {
      // A failed request may be an observer or network fault. It contributes no vote.
    }
    const finishedAt = now();
    observations.push({
      slot,
      started_at_ms: startedAt,
      finished_at_ms: Math.max(startedAt, finishedAt),
      http_status: finishedAt >= startedAt ? status : null,
    });
  }

  await sleepUntil(slotStart(config, config.slot_count), now, sleep);
  return createEvidenceBundle(config, observations);
}
