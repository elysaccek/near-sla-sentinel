import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assignmentsPath, isNearPublicKey, isNetworkAccount, nodeRequestMessage } from "../../shared/oracle-protocol.ts";
import { transaction } from "./database.ts";
import { digest, heartbeatMessage, identityKey, metadata, object, registrationMessage, RequestError, signatureMatches, text, uuid } from "./protocol.ts";

type Admin = { id: string };
const invitationPattern = /^SLA-ORACLE-[A-Za-z0-9_-]{43}$/;
const nodeColumns = "id, identity_key, near_account, near_public_key, metadata, status, created_at, last_heartbeat_at";
const online = "last_heartbeat_at >= clock_timestamp() - interval '90 seconds'";
const connectivity = `CASE WHEN ${online} THEN 'ONLINE' ELSE 'OFFLINE' END AS connectivity`;
const transitions = {
  approve: ["PENDING_APPROVAL", "ACTIVE"], reject: ["PENDING_APPROVAL", "REJECTED"],
  disable: ["ACTIVE", "DISABLED"], enable: ["DISABLED", "ACTIVE"],
} as const;

function audit(client: PoolClient, actor: string, action: string, id: string) {
  return client.query("INSERT INTO oracle_audit_log (actor, action, subject) VALUES ($1, $2, $3)", [actor, action, id]);
}

async function rateLimit(client: Pool | PoolClient, bucket: string, maximum: number) {
  const { rows: [row] } = await client.query(`INSERT INTO oracle_rate_limits (bucket, window_start, attempts)
    VALUES ($1, floor(extract(epoch FROM clock_timestamp()) / 60)::bigint, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET attempts = oracle_rate_limits.attempts + 1
    WHERE oracle_rate_limits.attempts < $2 RETURNING attempts`, [bucket, maximum]);
  if (!row) throw new RequestError(429, "Too many requests");
}

export function registry(db: Pool, audience: string, network = "testnet") {
  return {
    async createInvite(admin: Admin, input: unknown) {
      const { ttl_seconds: ttl = 3600 } = object(input, ["ttl_seconds"]);
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > 86_400) {
        throw new RequestError(400, "ttl_seconds must be between 1 and 86400");
      }
      const id = randomUUID();
      const code = "SLA-ORACLE-" + randomBytes(32).toString("base64url");
      return transaction(db, async (client) => {
        const { rows: [invite] } = await client.query(`INSERT INTO oracle_invitations (id, digest, expires_at)
          VALUES ($1, $2, clock_timestamp() + $3::int * interval '1 second') RETURNING id, expires_at`, [id, digest(code), ttl]);
        await audit(client, admin.id, "invitation_created", id);
        return { ...invite, code };
      });
    },
    async listInvites(after: string | null) {
      const { rows } = await db.query(`SELECT id, created_at, expires_at, consumed_at, revoked_at
        FROM oracle_invitations WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT 51`, [after]);
      return page(rows);
    },
    async revokeInvite(admin: Admin, id: string) {
      await transaction(db, async (client) => {
        const result = await client.query(`UPDATE oracle_invitations SET revoked_at = clock_timestamp()
          WHERE id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`, [id]);
        if (!result.rowCount) throw new RequestError(409, "Invitation cannot be revoked");
        await audit(client, admin.id, "invitation_revoked", id);
      });
    },
    limit: (bucket: string, maximum: number) => rateLimit(db, bucket, maximum),
    async prune() {
      await db.query("DELETE FROM oracle_rate_limits WHERE window_start < floor(extract(epoch FROM clock_timestamp()) / 60) - 5");
      await db.query("DELETE FROM oracle_challenges WHERE expires_at < clock_timestamp() - interval '1 hour'");
      await db.query("DELETE FROM oracle_node_requests WHERE received_at < clock_timestamp() - interval '1 hour'");
    },
    async challenge(input: unknown) {
      const body = object(input, ["invite_code", "node_id", "identity_key", "near_account", "metadata", "near_public_key"]);
      const code = text(body.invite_code, "invitation", invitationPattern);
      const nodeId = uuid(body.node_id);
      const key = identityKey(body.identity_key);
      const near = body.near_account;
      if (!isNetworkAccount(near, network)) throw new RequestError(400, "Invalid NEAR account for this network");
      const voteKey = body.near_public_key;
      if (voteKey !== undefined && !isNearPublicKey(voteKey)) throw new RequestError(400, "Invalid NEAR public key");
      const profile = metadata(body.metadata ?? {}, ["hostname", "region", "version", "os", "cpu", "ram"]);
      const id = randomUUID();
      const message = registrationMessage(audience, id, nodeId, key, near, profile, voteKey);
      const { rows: [row] } = await db.query(`INSERT INTO oracle_challenges
        (id, message, invitation_id, node_id, identity_key, near_account, metadata, near_public_key, expires_at)
        SELECT $2, $3, id, $4, $5, $6, $7, $8, LEAST(expires_at, clock_timestamp() + interval '2 minutes')
        FROM oracle_invitations WHERE digest = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > clock_timestamp() RETURNING id, expires_at`,
      [digest(code), id, message, nodeId, key, near, profile, voteKey ?? null]);
      if (!row) throw new RequestError(403, "Invitation is unavailable");
      return { ...row, message };
    },
    async register(input: unknown) {
      const body = object(input, ["challenge_id", "signature"]);
      const id = uuid(body.challenge_id);
      return transaction(db, async (client) => {
        const { rows: [challenge] } = await client.query(`SELECT * FROM oracle_challenges
          WHERE id = $1 AND used_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [id]);
        if (!challenge) throw new RequestError(409, "Challenge is unavailable");
        if (!signatureMatches(challenge.identity_key, body.signature, challenge.message)) {
          throw new RequestError(401, "Invalid identity proof");
        }
        const consumed = await client.query(`UPDATE oracle_invitations SET consumed_at = clock_timestamp()
          WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()`, [challenge.invitation_id]);
        if (!consumed.rowCount) throw new RequestError(409, "Invitation is unavailable");
        const { rows: [node] } = await client.query(`INSERT INTO oracle_nodes
          (id, identity_key, near_account, invitation_id, metadata, near_public_key) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING RETURNING id, status`,
        [challenge.node_id, challenge.identity_key, challenge.near_account, challenge.invitation_id, challenge.metadata, challenge.near_public_key]);
        if (!node) throw new RequestError(409, "Node identity or NEAR account is already registered");
        await client.query("UPDATE oracle_challenges SET used_at = clock_timestamp() WHERE id = $1", [id]);
        await audit(client, node.id, "invitation_consumed", challenge.invitation_id);
        await audit(client, node.id, "registration_pending", node.id);
        return node;
      });
    },
    async changeStatus(admin: Admin, id: string, action: keyof typeof transitions | "revoke") {
      const [before, after] = action === "revoke" ? [null, "REVOKED"] : transitions[action];
      return transaction(db, async (client) => {
        const { rows: [node] } = await client.query(`UPDATE oracle_nodes
          SET status = $2, last_heartbeat_at = NULL WHERE id = $1 AND
          (($3::text IS NOT NULL AND status = $3) OR
          ($3::text IS NULL AND status IN ('PENDING_APPROVAL', 'ACTIVE', 'DISABLED')))
          RETURNING id, status`, [id, after, before]);
        if (!node) throw new RequestError(409, "Invalid node status transition");
        await audit(client, admin.id, "node_" + action, id);
        return node;
      });
    },
    async listNodes(after: string | null, pending: boolean) {
      const { rows } = await db.query(`SELECT ${nodeColumns}, ${connectivity} FROM oracle_nodes
        WHERE ($1::uuid IS NULL OR id > $1) AND (NOT $2::boolean OR status = 'PENDING_APPROVAL')
        ORDER BY id LIMIT 51`, [after, pending]);
      return page(rows);
    },
    async summary() {
      const { rows: [counts] } = await db.query(`SELECT count(*)::int AS registered,
        count(*) FILTER (WHERE status = 'ACTIVE' AND ${online})::int AS online,
        count(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pending
        FROM oracle_nodes`);
      return counts;
    },
    async node(id: string) {
      const { rows: [node] } = await db.query(`SELECT ${nodeColumns}, ${connectivity}
        FROM oracle_nodes WHERE id = $1`, [id]);
      if (!node) throw new RequestError(404, "Node not found");
      return node;
    },
    async history(id: string, cursor: string | null) {
      const { rows } = await db.query(`SELECT request_id AS id, received_at, reported_at, health
        FROM oracle_heartbeats WHERE node_id = $1 AND ($2::uuid IS NULL OR
        (received_at, request_id) < (SELECT received_at, request_id FROM oracle_heartbeats WHERE node_id = $1 AND request_id = $2))
        ORDER BY received_at DESC, request_id DESC LIMIT 51`, [id, cursor]);
      return page(rows);
    },
    async authenticated<T>(
      nodeId: string, signature: string | undefined, path: string, raw: Buffer, input: unknown, activeOnly: boolean,
      handle: (client: PoolClient, node: { status: string }, cursor: string | null) => Promise<T>,
    ) {
      const { request_id, reported_at_ms, after } = object(input,
        path === assignmentsPath ? ["request_id", "reported_at_ms", "after"] : ["request_id", "reported_at_ms"]);
      const requestId = uuid(request_id);
      const cursor = after === undefined ? null : uuid(after);
      if (typeof reported_at_ms !== "number" || !Number.isSafeInteger(reported_at_ms)) {
        throw new RequestError(400, "Invalid request timestamp");
      }
      return transaction(db, async (client) => {
        const { rows: [node] } = await client.query("SELECT identity_key, status FROM oracle_nodes WHERE id = $1 FOR SHARE", [nodeId]);
        if (!node) throw new RequestError(404, "Node is not registered");
        if (!signature || !signatureMatches(node.identity_key, signature, nodeRequestMessage(audience, nodeId, path, raw))) {
          throw new RequestError(401, "Invalid node signature");
        }
        if (Math.abs(Date.now() - reported_at_ms) > 60_000) throw new RequestError(400, "Request timestamp is outside the 60-second window");
        if (activeOnly && node.status !== "ACTIVE") throw new RequestError(403, "Node is not active");
        const result = await client.query(`INSERT INTO oracle_node_requests (node_id, request_id)
          VALUES ($1, $2) ON CONFLICT DO NOTHING`, [nodeId, requestId]);
        if (!result.rowCount) throw new RequestError(409, "Request already received");
        await rateLimit(client, "node:" + nodeId, 60);
        return handle(client, node, cursor);
      });
    },
    async heartbeat(nodeId: string, signature: string | undefined, raw: Buffer, input: unknown) {
      const { request_id: request, reported_at_ms: timestamp, health } = object(input, ["request_id", "reported_at_ms", "health"]);
      const requestId = uuid(request);
      if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) {
        throw new RequestError(400, "Invalid heartbeat timestamp");
      }
      const metrics = metadata(health, [
        "version", "uptime", "cpu", "ram", "active_slas", "last_measurement", "rpc", "last_error", "queue",
        "control", "clock", "diagnostic", "fault",
      ]);
      return transaction(db, async (client) => {
        const { rows: [node] } = await client.query("SELECT identity_key, status FROM oracle_nodes WHERE id = $1 FOR UPDATE", [nodeId]);
        if (!node || node.status !== "ACTIVE") throw new RequestError(403, "Node is not active");
        if (!signature || !signatureMatches(node.identity_key, signature, heartbeatMessage(audience, nodeId, raw))) {
          throw new RequestError(401, "Invalid heartbeat signature");
        }
        if (Math.abs(Date.now() - timestamp) > 60_000) {
          throw new RequestError(400, "Heartbeat timestamp is outside the 60-second window");
        }
        const inserted = await client.query(`INSERT INTO oracle_heartbeats (node_id, request_id, reported_at, health)
          VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [nodeId, requestId, new Date(timestamp), metrics]);
        if (!inserted.rowCount) throw new RequestError(409, "Heartbeat already received");
        const updated = await client.query(`UPDATE oracle_nodes SET last_heartbeat_at = clock_timestamp()
          WHERE id = $1 AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= clock_timestamp() - interval '10 seconds')`, [nodeId]);
        if (!updated.rowCount) throw new RequestError(429, "Send heartbeats at least 10 seconds apart", "10");
        return { id: nodeId, status: "ACTIVE" };
      });
    },
  };
}

function page<T extends { id: string }>(rows: T[]) {
  const items = rows.slice(0, 50);
  return { items, next: rows.length > 50 ? items[49].id : null };
}
