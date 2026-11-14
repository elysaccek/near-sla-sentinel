import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  approvedEndpoint, assignmentMessage, assignmentPageSize, isNearPublicKey, isNetworkAccount, isRecord, isSandboxNetwork,
  isU64, loopbackHealth, parseAssignment, policyFromAgreement,
} from "../../shared/oracle-protocol.ts";
import type { Assignment, AssignmentRequest } from "../../shared/oracle-protocol.ts";
import { defaultTestnetRpc, nearRpc, scopedVotePermission } from "../../shared/near-rpc.ts";
import { transaction } from "./database.ts";
import { digest, object, RequestError } from "./protocol.ts";

interface Candidate {
  near_account: string;
  near_public_key: string;
}

export interface AssignmentOptions {
  load: (request: AssignmentRequest, candidate: Candidate) => Promise<Assignment>;
  sign: (message: string) => string;
}

export function assignmentOptions(keyDer: Buffer, rpcUrl = defaultTestnetRpc, network = "testnet"): AssignmentOptions {
  const key = createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  if (createPublicKey(key).asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 assignment key");
  const rpc = nearRpc(rpcUrl, network);

  return {
    sign: (message) => sign(null, Buffer.from(message), key).toString("base64url"),
    async load(request, candidate) {
      const { agreement, time, codeHash, blockHash } = await rpc.readAgreement(request.contract, request.sla_id);
      if (!isRecord(agreement) || agreement.outcome !== "undecided") {
        throw new RequestError(409, "Only open agreements can be assigned");
      }
      let policy;
      try { policy = policyFromAgreement(agreement); }
      catch { throw new RequestError(422, "Expected a V2 escrow agreement"); }
      if (time >= Number(policy.ends_at_ms)) throw new RequestError(409, "Observation window has ended");
      if (!policy.oracles.includes(candidate.near_account)) {
        throw new RequestError(409, "Node account is absent from the finalized oracle roster");
      }
      const { permission } = await rpc.query(blockHash, {
        request_type: "view_access_key", account_id: candidate.near_account, public_key: candidate.near_public_key,
      });
      if (!scopedVotePermission(permission, request.contract)) throw new RequestError(409, "Node does not have a scoped vote key");
      return { ...request, network, code_hash: codeHash, policy };
    },
  };
}

export function assignmentService(db: Pool, audience: string, options: AssignmentOptions | undefined, network = "testnet") {
  return {
    async assign(adminId: string, nodeId: string, input: unknown) {
      if (!options) throw new RequestError(503, "Assignment signing is not configured");
      const { contract, sla_id, endpoint } = object(input, ["contract", "sla_id", "endpoint"]);
      if (!isNetworkAccount(contract, network) || !isU64(sla_id) || typeof endpoint !== "string") {
        throw new RequestError(400, "Provide a contract, SLA ID and endpoint for this network");
      }
      try { approvedEndpoint(endpoint, isSandboxNetwork(network) && endpoint === loopbackHealth); }
      catch { throw new RequestError(400, "Invalid assignment endpoint"); }
      const { rows: [candidate] } = await db.query("SELECT status, near_account, near_public_key FROM oracle_nodes WHERE id = $1", [nodeId]);
      if (!candidate || candidate.status !== "ACTIVE") throw new RequestError(403, "Node is not active");
      if (!isNearPublicKey(candidate.near_public_key)) throw new RequestError(409, "Node needs a registered NEAR vote public key");
      const assignment = parseAssignment(await options.load({ contract, sla_id, endpoint }, candidate));
      if (assignment.network !== network || assignment.contract !== contract || assignment.sla_id !== sla_id
          || assignment.endpoint !== endpoint || !digest(endpoint).equals(Buffer.from(assignment.policy.endpoint_hash))) {
        throw new RequestError(422, "Endpoint or agreement identity differs from finalized policy");
      }
      const signature = options.sign(assignmentMessage(audience, nodeId, assignment));
      return transaction(db, async (client) => {
        const { rows: [node] } = await client.query("SELECT status, near_account, near_public_key FROM oracle_nodes WHERE id = $1 FOR UPDATE", [nodeId]);
        if (!node || node.status !== "ACTIVE") throw new RequestError(403, "Node is not active");
        if (node.near_public_key !== candidate.near_public_key || node.near_account !== candidate.near_account
            || !assignment.policy.oracles.includes(node.near_account)) {
          throw new RequestError(409, "Node account is absent from the finalized oracle roster");
        }
        const { rows: [row] } = await client.query(`INSERT INTO oracle_assignments
          (id, node_id, network, contract, sla_id, assignment, signature) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (node_id, network, contract, sla_id) DO NOTHING RETURNING id`,
        [randomUUID(), nodeId, assignment.network, contract, sla_id, assignment, signature]);
        if (row) {
          await client.query("INSERT INTO oracle_audit_log (actor, action, subject) VALUES ($1, 'assignment_created', $2)", [adminId, row.id]);
          return { id: row.id, assignment };
        }
        const { rows: [existing] } = await client.query(`SELECT id, assignment FROM oracle_assignments
          WHERE node_id = $1 AND network = $2 AND contract = $3 AND sla_id = $4`, [nodeId, assignment.network, contract, sla_id]);
        if (assignmentMessage(audience, nodeId, existing.assignment) !== assignmentMessage(audience, nodeId, assignment)) {
          throw new RequestError(409, "Existing assignment has a different policy");
        }
        await client.query("UPDATE oracle_assignments SET signature = $1 WHERE id = $2 AND signature <> $1", [signature, existing.id]);
        return { id: existing.id, assignment };
      });
    },

    async list(client: PoolClient, nodeId: string, cursor: string | null) {
      if (!options) throw new RequestError(503, "Assignment signing is not configured");
      const { rows } = await client.query(`SELECT id, assignment, signature FROM oracle_assignments
        WHERE node_id = $1 AND network = $4 AND ($2::uuid IS NULL OR id > $2)
        AND (assignment -> 'policy' ->> 'ends_at_ms')::bigint > floor(extract(epoch FROM clock_timestamp()) * 1000)
        ORDER BY id LIMIT $3`, [nodeId, cursor, assignmentPageSize + 1, network]);
      const page = rows.slice(0, assignmentPageSize);
      return {
        items: page.map(({ assignment, signature }) => ({ assignment, signature })),
        next: rows.length > page.length ? page.at(-1)?.id : null,
      };
    },

    async history(nodeId: string, cursor: string | null) {
      const { rows } = await db.query(`SELECT id, created_at, assignment FROM oracle_assignments
        WHERE node_id = $1 AND network = $2 AND ($3::uuid IS NULL OR id > $3) ORDER BY id LIMIT 51`, [nodeId, network, cursor]);
      const items = rows.slice(0, 50);
      return { items, next: rows.length > items.length ? items.at(-1)?.id : null };
    },
  };
}
