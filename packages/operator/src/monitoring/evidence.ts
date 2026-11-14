export const EVIDENCE_DOMAIN = "sla-sentinel/evidence/v1";
export const WORKER_EVIDENCE_DOMAIN = "sla-sentinel/evidence/v2";
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

const controlStates = ["not configured", "checking", "reachable", "unavailable"] as const;
const probeFailures = ["DNS_FAILURE", "TCP_FAILURE", "TLS_FAILURE", "TIMEOUT", "TRANSPORT_FAILURE"] as const;
export type ControlState = typeof controlStates[number];
export type ProbeFailure = typeof probeFailures[number];
export type ProbeDiagnostic = ProbeFailure | `LOCAL_FAULT/${ProbeFailure}`
  | "LOCAL_FAULT/CLOCK" | "LOCAL_FAULT/CONTROL" | "CONTROL_PENDING" | "CONTROLLED_FAULT";

const diagnostics = new Set<string>([
  ...probeFailures, ...probeFailures.map((failure) => "LOCAL_FAULT/" + failure),
  "LOCAL_FAULT/CLOCK", "LOCAL_FAULT/CONTROL", "CONTROL_PENDING", "CONTROLLED_FAULT",
]);

export interface ProbeContext {
  slot: number;
  observed_http_status: number | null;
  control_state: ControlState | null;
  diagnostic: ProbeDiagnostic | null;
}

export interface WorkerEvidenceDocument extends EvidenceConfig {
  domain: typeof WORKER_EVIDENCE_DOMAIN;
  observations: (EvidenceObservation & ProbeContext)[];
}

export interface ContractVote {
  sla_id: string;
  up_mask: string;
  down_mask: string;
  evidence_hash: number[];
}

export interface EvidenceBundle {
  evidence: EvidenceDocument | WorkerEvidenceDocument;
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

function probeDocument(
  config: EvidenceConfig,
  probes: readonly ProbeObservation[],
): EvidenceDocument {
  validateEvidenceConfig(config);
  const bySlot = new Map<number, ProbeObservation>();
  for (const probe of probes) {
    if (!Number.isInteger(probe.slot) || probe.slot < 0 || probe.slot >= config.slot_count || bySlot.has(probe.slot)) {
      throw new Error("Unexpected or duplicate probe slot");
    }
    bySlot.set(probe.slot, probe);
  }

  return {
    domain: EVIDENCE_DOMAIN,
    network: config.network,
    contract: config.contract,
    sla_id: config.sla_id,
    oracle: config.oracle,
    endpoint_hash: [...config.endpoint_hash],
    starts_at_ms: config.starts_at_ms,
    slot_ms: config.slot_ms,
    slot_count: config.slot_count,
    observations: Array.from({ length: config.slot_count }, (_, slot) =>
      normalizeObservation(config, bySlot.get(slot) ?? missingObservation(slot))),
  };
}

async function bindVote<T extends EvidenceBundle["evidence"]>(evidence: T) {
  let upMask = 0n;
  let downMask = 0n;
  for (const { slot, result } of evidence.observations) {
    if (result === "up") upMask |= 1n << BigInt(slot);
    if (result === "down") downMask |= 1n << BigInt(slot);
  }
  return {
    evidence,
    contract_vote: {
      sla_id: evidence.sla_id,
      up_mask: upMask.toString(),
      down_mask: downMask.toString(),
      evidence_hash: await sha256(canonicalJson(evidence)),
    },
  };
}

export async function createEvidenceBundle(config: EvidenceConfig, probes: readonly ProbeObservation[]) {
  return bindVote(probeDocument(config, probes));
}

export async function createWorkerEvidenceBundle(
  config: EvidenceConfig, probes: readonly ProbeObservation[], context: readonly ProbeContext[],
) {
  const document = probeDocument(config, probes);
  const bySlot = new Map<number, ProbeContext>();
  for (const entry of context) {
    if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= config.slot_count || bySlot.has(entry.slot)) {
      throw new Error("Unexpected or duplicate diagnostic slot");
    }
    bySlot.set(entry.slot, entry);
  }
  const observations = document.observations.map((observation) => {
    const { observed_http_status, control_state, diagnostic } = bySlot.get(observation.slot) ?? {
      observed_http_status: observation.http_status, control_state: null, diagnostic: null,
    };
    const suppressedFailure = observation.http_status === null && observation.started_at_ms !== null && observed_http_status !== null
      && Number.isInteger(observed_http_status) && observed_http_status >= 500 && observed_http_status <= 599
      && ((control_state === "unavailable" && diagnostic === "LOCAL_FAULT/CONTROL")
        || (control_state === "checking" && diagnostic === "CONTROL_PENDING"));
    if ((control_state !== null && !controlStates.includes(control_state))
        || (diagnostic !== null && !diagnostics.has(diagnostic))
        || (observed_http_status !== observation.http_status && !suppressedFailure)
        || (observation.result === "down" && (control_state === "checking" || control_state === "unavailable"))) {
      throw new Error("Invalid diagnostic observation");
    }
    return { ...observation, observed_http_status, control_state, diagnostic };
  });
  return bindVote<WorkerEvidenceDocument>({ ...document, domain: WORKER_EVIDENCE_DOMAIN, observations });
}

export async function verifyEvidenceBundle(
  input: EvidenceBundle,
  expected?: { config: EvidenceConfig; contract_vote: ContractVote },
): Promise<boolean> {
  try {
    const { evidence, contract_vote } = input;
    const rebuilt = evidence.domain === WORKER_EVIDENCE_DOMAIN
      ? await createWorkerEvidenceBundle(evidence, evidence.observations, evidence.observations)
      : await createEvidenceBundle(evidence, evidence.observations);
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

function longestSupportedRun(
  masks: readonly bigint[],
  slotCount: number,
  quorum: number,
): number {
  let lower = 0;
  let upper = slotCount;
  while (lower < upper) {
    const length = Math.ceil((lower + upper) / 2);
    let range = (1n << BigInt(length)) - 1n;
    let found = false;
    for (let start = 0; start <= slotCount - length; start += 1, range <<= 1n) {
      let count = 0;
      for (const mask of masks) {
        if ((mask & range) === range && ++count === quorum) break;
      }
      if (count === quorum) {
        found = true;
        break;
      }
    }
    if (found) lower = length;
    else upper = length - 1;
  }
  return lower;
}

type WindowVote = Pick<ContractVote, "up_mask" | "down_mask"> | null;

export function assessWindow(
  slotCount: number,
  minDownSlots: number,
  votes: readonly WindowVote[],
) {
  if (votes.length !== 3) {
    throw new Error("Invalid observation window");
  }
  return assessQuorumWindow(slotCount, minDownSlots, 2, votes);
}

/** The caller supplies one entry per authenticated member of the frozen roster. */
export function assessQuorumWindow(
  slotCount: number,
  minDownSlots: number,
  downQuorum: number,
  votes: readonly WindowVote[],
): { outcome: "breach" | "healthy" | "inconclusive"; confirmed: number; possible: number } {
  if (!Number.isInteger(slotCount) || slotCount < 2 || slotCount > 64
      || !Number.isInteger(minDownSlots) || minDownSlots < 2 || minDownSlots > slotCount) {
    throw new Error("Invalid observation window");
  }
  if (votes.length < 3 || !Number.isInteger(downQuorum)
      || downQuorum <= Math.floor(votes.length / 2) || downQuorum > votes.length) {
    throw new Error("Invalid oracle quorum");
  }
  const valid = (1n << BigInt(slotCount)) - 1n;
  const masks = Array.from(votes, (vote) => {
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

  const confirmed = longestSupportedRun(masks.map((vote) => vote.down), slotCount, downQuorum);
  const possible = longestSupportedRun(masks.map((vote) => valid & ~vote.up), slotCount, downQuorum);
  const outcome = confirmed >= minDownSlots ? "breach"
    : possible < minDownSlots ? "healthy" : "inconclusive";
  return { outcome, confirmed, possible };
}
