import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { boundedJson } from "../../../shared/http-json.ts";
import { faultScheduleMessage, faultSchedulePath, parseFaultSchedule } from "../../../shared/fault-protocol.ts";
import type { SignedFaultSchedule } from "../../../shared/fault-protocol.ts";
import {
  assignmentMessage, assignmentPageSize, assignmentsPath, heartbeatPath, isRecord, isUuid, nodeRequestMessage,
  parseAssignment, registrationMessage, registrationStatusPath,
} from "../../../shared/oracle-protocol.ts";
import type { SignedAssignment } from "../../../shared/oracle-protocol.ts";
import type { WorkerIdentity } from "./identity.ts";

export const workerVersion = "0.1.0";

export class MasterError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Master request returned HTTP " + status);
    this.status = status;
  }
}

export function masterVerifiers(identity: WorkerIdentity, der: Buffer) {
  const key: KeyObject = createPublicKey({ key: der, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected a trusted Ed25519 assignment public key");
  function check(message: string, encoded: unknown) {
    if (typeof encoded !== "string" || encoded.length !== 86) throw new Error("Invalid Master signature format");
    const signature = Buffer.from(encoded, "base64url");
    if (signature.toString("base64url") !== encoded || !verify(null, Buffer.from(message), key, signature)) {
      throw new Error("Master signature does not match this node and message");
    }
    return encoded;
  }
  return {
    assignment(value: unknown): SignedAssignment {
      if (!isRecord(value)) throw new Error("Invalid signed assignment");
      const assignment = parseAssignment(value.assignment);
      return { assignment, signature: check(assignmentMessage(identity.audience, identity.node_id, assignment), value.signature) };
    },
    fault(value: unknown): SignedFaultSchedule {
      if (!isRecord(value)) throw new Error("Invalid signed demo fault schedule");
      const plan = parseFaultSchedule(value.plan);
      return { plan, signature: check(faultScheduleMessage(identity.audience, identity.network, identity.node_id, plan), value.signature) };
    },
  };
}

export function assignmentVerifier(identity: WorkerIdentity, der: Buffer) {
  return masterVerifiers(identity, der).assignment;
}

export type RegistrationStatus = "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "DISABLED" | "REVOKED";
const statuses: readonly RegistrationStatus[] = ["PENDING_APPROVAL", "ACTIVE", "REJECTED", "DISABLED", "REVOKED"];

export function masterClient(identity: WorkerIdentity, signal?: AbortSignal) {
  async function post(path: string, data: object, signed = false) {
    const body = Buffer.from(JSON.stringify(data));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (signed) {
      headers["X-SLA-Node"] = identity.node_id;
      headers["X-SLA-Signature"] = identity.sign(nodeRequestMessage(identity.audience, identity.node_id, path, body));
    }
    const timeout = AbortSignal.timeout(5000);
    const response = await fetch(new URL(path, identity.master), {
      method: "POST", body, headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MasterError(response.status);
    }
    return boundedJson(response, 48_000);
  }
  const request = () => ({ request_id: randomUUID(), reported_at_ms: Date.now() });
  function statusFrom(value: unknown) {
    if (!isRecord(value) || value.id !== identity.node_id || !statuses.includes(value.status as RegistrationStatus)) {
      throw new Error("Master returned an unexpected registration status");
    }
    return value.status as RegistrationStatus;
  }
  const status = async () => statusFrom(await post(registrationStatusPath, request(), true));
  return {
    status,
    async join(code: string, metadata: Record<string, string>) {
      try { return await status(); }
      catch (error) { if (!(error instanceof MasterError) || error.status !== 404) throw error; }
      if (!/^SLA-ORACLE-[A-Za-z0-9_-]{43}$/.test(code) || code.length !== 54) throw new Error("Invalid invite code");
      const { node_id, identity_key, near_account, near_public_key } = identity;
      try {
        const challenge = await post("/oracles/registration/challenge", {
          invite_code: code, node_id, identity_key, near_account, metadata, near_public_key,
        });
        if (!isRecord(challenge) || !isUuid(challenge.id)
            || challenge.message !== registrationMessage(identity.audience, challenge.id, node_id, identity_key, near_account, metadata, near_public_key)) {
          throw new Error("Master returned a challenge for different registration terms");
        }
        return statusFrom(await post("/oracles/registration/verify", {
          challenge_id: challenge.id, signature: identity.sign(challenge.message),
        }));
      } catch (error) {
        // Registration may have committed before the response was lost.
        return status().catch(() => { throw error; });
      }
    },
    async heartbeat(health: Record<string, string>) {
      return statusFrom(await post(heartbeatPath, { ...request(), health }, true));
    },
    async faultSchedule() {
      return post(faultSchedulePath, request(), true);
    },
    async assignments(after?: string) {
      const page = await post(assignmentsPath, { ...request(), after }, true);
      if (!isRecord(page) || !Array.isArray(page.items) || page.items.length > assignmentPageSize
          || (page.next !== null && (!isUuid(page.next) || page.next <= (after ?? "") || page.items.length !== assignmentPageSize))) {
        throw new Error("Master returned an invalid assignment page");
      }
      return { items: page.items as unknown[], next: page.next };
    },
  };
}
