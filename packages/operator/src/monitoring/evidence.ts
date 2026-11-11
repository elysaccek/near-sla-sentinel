export const EVIDENCE_DOMAIN = "sla-sentinel/evidence/v1";
export const MAX_PROBE_MS = 2_500;

export interface EvidenceConfig {
  network: string;
  contract: string;
  sla_id: string;
  oracle: string;
  endpoint_hash: number[];
  starts_at_ms: string;
  slot_ms: number;
  slot_count: number;
}

export interface ProbeObservation {
  slot: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  http_status: number | null;
}

export interface EvidenceObservation extends ProbeObservation {
  result: "up" | "down" | "unknown";
  reason: "ok" | "server_error" | "missing" | "late" | "transport" | "other_status";
}

export interface EvidenceDocument extends EvidenceConfig {
  domain: typeof EVIDENCE_DOMAIN;
  observations: EvidenceObservation[];
}

export interface ContractVote {
  sla_id: string;
  up_mask: string;
  down_mask: string;
  evidence_hash: number[];
}

export interface EvidenceBundle {
  evidence: EvidenceDocument;
  contract_vote: ContractVote;
}

const U64_MAX = (1n << 64n) - 1n;
const ACCOUNT_ID = /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*)(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

function decimalU64(value: string): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= U64_MAX;
}

function accountId(value: string): boolean {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}

function hashBytes(value: number[]): boolean {
  return Array.isArray(value) && value.length === 32
    && Array.from(value).every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    && value.some((byte) => byte !== 0);
}

export function validateEvidenceConfig(config: EvidenceConfig): void {
  if (typeof config.network !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(config.network)
      || !accountId(config.contract) || !accountId(config.oracle) || !decimalU64(config.sla_id)
      || !hashBytes(config.endpoint_hash)) {
    throw new Error("Invalid evidence identity or endpoint hash");
  }
  const start = Number(config.starts_at_ms);
  if (!decimalU64(config.starts_at_ms) || !Number.isSafeInteger(start)
      || !Number.isInteger(config.slot_ms) || config.slot_ms < 1_000 || config.slot_ms > 3_600_000
      || !Number.isInteger(config.slot_count) || config.slot_count < 2 || config.slot_count > 64
      || !Number.isSafeInteger(start + config.slot_ms * config.slot_count)) {
    throw new Error("Invalid measurement schedule");
  }
}

export function slotStart(config: EvidenceConfig, slot: number): number {
  return Number(config.starts_at_ms) + slot * config.slot_ms;
}

export function probeDeadline(config: EvidenceConfig, slot: number, startedAt: number): number {
  return Math.min(slotStart(config, slot + 1), startedAt + MAX_PROBE_MS);
}

export function missingObservation(slot: number): ProbeObservation {
  return { slot, started_at_ms: null, finished_at_ms: null, http_status: null };
}

function normalizeObservation(config: EvidenceConfig, probe: ProbeObservation): EvidenceObservation {
  const { slot, started_at_ms, finished_at_ms, http_status } = probe;
  const fields = { slot, started_at_ms, finished_at_ms, http_status };

  if (started_at_ms === null && finished_at_ms === null && http_status === null) {
    return { ...fields, result: "unknown", reason: "missing" };
  }
  if (started_at_ms === null || finished_at_ms === null || !Number.isSafeInteger(started_at_ms)
      || !Number.isSafeInteger(finished_at_ms) || started_at_ms < 0 || finished_at_ms < started_at_ms
      || (http_status !== null && (!Number.isInteger(http_status) || http_status < 100 || http_status > 599))) {
    throw new Error("Invalid probe observation");
  }
  if (started_at_ms < slotStart(config, slot) || finished_at_ms >= probeDeadline(config, slot, started_at_ms)) {
    return { ...fields, result: "unknown", reason: "late" };
  }
  if (http_status === 200) {
    return { ...fields, result: "up", reason: "ok" };
  }
  if (http_status !== null && http_status >= 500) {
    return { ...fields, result: "down", reason: "server_error" };
  }
  return { ...fields, result: "unknown", reason: http_status === null ? "transport" : "other_status" };
}

// Lexicographically sort object keys at every depth. Array order remains significant.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isSafeInteger(value))) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const fields = value as Record<string, unknown>;
    const entries = Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Evidence contains a value outside the canonical JSON schema");
}

export async function sha256(text: string): Promise<number[]> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest));
}

export async function createEvidenceBundle(
  config: EvidenceConfig,
  probes: readonly ProbeObservation[],
): Promise<EvidenceBundle> {
  validateEvidenceConfig(config);
  const bySlot = new Map<number, ProbeObservation>();
  for (const probe of probes) {
    if (!Number.isInteger(probe.slot) || probe.slot < 0 || probe.slot >= config.slot_count || bySlot.has(probe.slot)) {
      throw new Error("Unexpected or duplicate probe slot");
    }
    bySlot.set(probe.slot, probe);
  }

  let upMask = 0n;
  let downMask = 0n;
  const observations = Array.from({ length: config.slot_count }, (_, slot) => {
    const observation = normalizeObservation(config, bySlot.get(slot) ?? missingObservation(slot));
    if (observation.result === "up") {
      upMask |= 1n << BigInt(slot);
    }
    if (observation.result === "down") {
      downMask |= 1n << BigInt(slot);
    }
    return observation;
  });
  const evidence: EvidenceDocument = {
    domain: EVIDENCE_DOMAIN,
    network: config.network,
    contract: config.contract,
    sla_id: config.sla_id,
    oracle: config.oracle,
    endpoint_hash: [...config.endpoint_hash],
    starts_at_ms: config.starts_at_ms,
    slot_ms: config.slot_ms,
    slot_count: config.slot_count,
    observations,
  };
  return {
    evidence,
    contract_vote: {
      sla_id: config.sla_id,
      up_mask: upMask.toString(),
      down_mask: downMask.toString(),
      evidence_hash: await sha256(canonicalJson(evidence)),
    },
  };
}

export async function verifyEvidenceBundle(
  input: EvidenceBundle,
  expected?: { config: EvidenceConfig; contract_vote: ContractVote },
): Promise<boolean> {
  try {
    const { evidence, contract_vote } = input;
    const rebuilt = await createEvidenceBundle(evidence, evidence.observations);
    if (canonicalJson(input) !== canonicalJson(rebuilt)) {
      return false;
    }
    if (!expected) {
      return true;
    }
    const { domain: _domain, observations: _observations, ...config } = rebuilt.evidence;
    return canonicalJson(config) === canonicalJson(expected.config)
      && canonicalJson(contract_vote) === canonicalJson(expected.contract_vote);
  } catch {
    return false;
  }
}

function longestRun(mask: bigint): number {
  let length = 0;
  while (mask !== 0n) {
    mask &= mask << 1n;
    length += 1;
  }
  return length;
}

export function assessWindow(
  slotCount: number,
  minDownSlots: number,
  votes: readonly (Pick<ContractVote, "up_mask" | "down_mask"> | null)[],
): { outcome: "breach" | "healthy" | "inconclusive"; confirmed: number; possible: number } {
  if (!Number.isInteger(slotCount) || slotCount < 2 || slotCount > 64
      || !Number.isInteger(minDownSlots) || minDownSlots < 2 || minDownSlots > slotCount
      || votes.length !== 3) {
    throw new Error("Invalid observation window");
  }
  const valid = (1n << BigInt(slotCount)) - 1n;
  const masks = votes.map((vote) => {
    if (vote === null) {
      return { up: 0n, down: 0n };
    }
    if (!decimalU64(vote.up_mask) || !decimalU64(vote.down_mask)) {
      throw new Error("Invalid vote mask");
    }
    const up = BigInt(vote.up_mask);
    const down = BigInt(vote.down_mask);
    if ((up & down) !== 0n || ((up | down) & ~valid) !== 0n) {
      throw new Error("Vote mask overlaps or exceeds the window");
    }
    return { up, down };
  });

  let confirmed = 0;
  let possible = 0;
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    confirmed = Math.max(confirmed, longestRun(masks[a].down & masks[b].down));
    possible = Math.max(possible, longestRun(valid & ~(masks[a].up | masks[b].up)));
  }
  const outcome = confirmed >= minDownSlots ? "breach"
    : possible < minDownSlots ? "healthy" : "inconclusive";
  return { outcome, confirmed, possible };
}
