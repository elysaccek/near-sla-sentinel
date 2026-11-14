import { createHash } from "node:crypto";

export const heartbeatPath = "/oracles/heartbeat";
export const assignmentsPath = "/oracles/assignments";
export const registrationStatusPath = "/oracles/registration/status";

export function nodeRequestMessage(audience: string, nodeId: string, path: string, raw: Buffer) {
  const domain = path === heartbeatPath ? "sla-sentinel/heartbeat/v1" : "sla-sentinel/node-request/v1";
  return JSON.stringify([domain, audience, "POST", path, nodeId, createHash("sha256").update(raw).digest("hex")]);
}

export function registrationMessage(
  audience: string, challengeId: string, nodeId: string, key: string, nearAccount: string, profile: Record<string, string>,
  nearPublicKey?: string,
) {
  const fields = ["sla-sentinel/registration/v1", audience, challengeId, nodeId, key, nearAccount, profile];
  return JSON.stringify(nearPublicKey ? [...fields, nearPublicKey] : fields);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 && !/\s/.test(value)
    && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

export function isTestnetAccount(value: unknown): value is string {
  return isAccountId(value) && value.endsWith(".testnet");
}

export function isSandboxNetwork(value: string) {
  return /^test-chain-[A-Za-z0-9-]{1,53}$/.exec(value)?.[0] === value;
}

export function isNetworkAccount(value: unknown, network: string): value is string {
  return network === "testnet" ? isTestnetAccount(value) : isSandboxNetwork(network) && isAccountId(value);
}

export function isU64(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.exec(value)?.[0] === value
    && BigInt(value) <= (1n << 64n) - 1n;
}

export function isBase58Hash(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.exec(value)?.[0] === value;
}

export function isNearPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("ed25519:") && isBase58Hash(value.slice(8));
}

export function isAudience(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,200}$/.exec(value)?.[0] === value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export const probePolicy = "http-status-v1";
export const loopbackHealth = "http://127.0.0.1:8787/health";
export const loopbackControl = "http://127.0.0.1:8788/health";
export const assignmentPageSize = 10;

export function isLoopbackOrigin(value: string) {
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname === "127.0.0.1";
}

export function approvedEndpoint(endpoint: string, localDemo = false): string {
  if (localDemo) {
    if (endpoint !== loopbackHealth) throw new Error("Local demo mode requires the fixed loopback health endpoint");
    return endpoint;
  }
  const url = new URL(endpoint);
  if (endpoint.length > 2048 || url.protocol !== "https:" || url.href !== endpoint
      || url.username || url.password || url.search || url.hash || url.port || !url.hostname.includes(".")
      || /^(?:[\d.]+|\[.*\])$/.test(url.hostname) || /\.(?:localhost|local|internal)\.?$/.test(url.hostname)
      || url.hostname.endsWith(".")) {
    throw new Error("Use the exact preapproved HTTPS URL with a public hostname and explicit path");
  }
  return endpoint;
}

export interface AssignmentRequest {
  contract: string;
  sla_id: string;
  endpoint: string;
}

export interface AssignmentPolicy {
  policy_version: 2;
  response_policy: typeof probePolicy;
  endpoint_hash: number[];
  oracles: string[];
  down_quorum: number;
  min_down_slots: number;
  starts_at_ms: string;
  ends_at_ms: string;
  reporting_deadline_ms: string;
  slot_ms: number;
  slot_count: number;
}

export interface Assignment extends AssignmentRequest {
  network: string;
  code_hash: string;
  policy: AssignmentPolicy;
}

export function policyFromAgreement(value: unknown): AssignmentPolicy {
  if (!isRecord(value) || value.policy_version !== 2 || !Array.isArray(value.oracles)
      || value.oracles.length < 3 || value.oracles.length > 16
      || !value.oracles.every(isAccountId) || new Set(value.oracles).size !== value.oracles.length
      || !Array.isArray(value.endpoint_hash) || value.endpoint_hash.length !== 32
      || !value.endpoint_hash.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
      || value.endpoint_hash.every((x) => x === 0)
      || !isU64(value.starts_at_ms) || !isU64(value.ends_at_ms) || !isU64(value.reporting_deadline_ms)) {
    throw new Error("Unsupported V2 agreement policy");
  }
  const { oracles, endpoint_hash, starts_at_ms, ends_at_ms, reporting_deadline_ms } = value;
  const { slot_ms, slot_count, min_down_slots, down_quorum } = value;
  const bounded = (number: unknown, min: number, max: number): number is number =>
    typeof number === "number" && Number.isInteger(number) && number >= min && number <= max;
  const start = Number(starts_at_ms);
  const end = Number(ends_at_ms);
  const deadline = Number(reporting_deadline_ms);
  if (!bounded(slot_ms, 1000, 3_600_000) || !bounded(slot_count, 2, 64)
      || !bounded(min_down_slots, 2, slot_count) || !bounded(down_quorum, Math.floor(oracles.length / 2) + 1, oracles.length)
      || !Number.isSafeInteger(deadline) || end !== start + slot_ms * slot_count
      || deadline - end < 1000 || deadline - end > 86_400_000) {
    throw new Error("Invalid V2 schedule or quorum");
  }
  return {
    policy_version: 2, response_policy: probePolicy, endpoint_hash, oracles, down_quorum, min_down_slots,
    starts_at_ms, ends_at_ms, reporting_deadline_ms, slot_ms, slot_count,
  };
}

export function parseAssignment(value: unknown): Assignment {
  if (!isRecord(value) || !isAccountId(value.contract) || !isU64(value.sla_id)
      || typeof value.endpoint !== "string" || typeof value.network !== "string"
      || !isBase58Hash(value.code_hash) || !isRecord(value.policy) || value.policy.response_policy !== probePolicy) {
    throw new Error("Invalid assignment");
  }
  return {
    network: value.network, contract: value.contract, sla_id: value.sla_id, endpoint: value.endpoint,
    code_hash: value.code_hash, policy: policyFromAgreement(value.policy),
  };
}

export function assignmentMessage(audience: string, nodeId: string, assignment: Assignment) {
  // parseAssignment fixes field order for JSONB, SQLite and RPC clients.
  return JSON.stringify(["sla-sentinel/assignment/v1", audience, nodeId, parseAssignment(assignment)]);
}

export interface SignedAssignment {
  assignment: Assignment;
  signature: string;
}
