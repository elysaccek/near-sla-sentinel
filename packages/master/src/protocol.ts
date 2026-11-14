import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { heartbeatPath, nodeRequestMessage } from "../../shared/oracle-protocol.ts";
export { registrationMessage } from "../../shared/oracle-protocol.ts";

export class RequestError extends Error {
  readonly status: number;
  readonly retryAfter?: string;

  constructor(status: number, message: string, retryAfter?: string) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new RequestError(400, "Unexpected request fields");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) {
    throw new RequestError(400, "Invalid " + label);
  }
  return value;
}

export const uuid = (value: unknown) => text(value, "ID", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();
export const base64url = (value: unknown, length: number) => {
  const encoded = text(value, "key or signature", /^[A-Za-z0-9_-]{1,100}$/);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== encoded) {
    throw new RequestError(400, "Invalid key or signature");
  }
  return bytes;
};

export function identityKey(value: unknown) {
  const bytes = base64url(value, 32);
  try {
    const point = ed25519.Point.fromBytes(bytes, false);
    if (!point.isSmallOrder() && point.isTorsionFree()) return bytes.toString("base64url");
  } catch {
    // Invalid point encoding.
  }
  throw new RequestError(400, "Invalid Ed25519 identity key");
}

export function signatureMatches(key: string, signature: unknown, message: string) {
  return ed25519.verify(base64url(signature, 64), Buffer.from(message), base64url(key, 32), { zip215: false });
}

export function heartbeatMessage(audience: string, nodeId: string, body: Buffer) {
  return nodeRequestMessage(audience, nodeId, heartbeatPath, body);
}

export function metadata(value: unknown, keys: string[]) {
  const fields = object(value, keys);
  return Object.fromEntries(Object.entries(fields).map(([key, item]) =>
    [key, text(item, key, /^[A-Za-z0-9][A-Za-z0-9._ +:/-]{0,119}$/)]));
}
