import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assignmentsPath, heartbeatPath, isAudience, isSandboxNetwork, registrationStatusPath } from "../../shared/oracle-protocol.ts";
import { faultSchedulePath } from "../../shared/fault-protocol.ts";
import { assignmentOptions, assignmentService } from "./assignments.ts";
import type { AssignmentOptions } from "./assignments.ts";
import { migrate } from "./database.ts";
import { digest, RequestError, uuid } from "./protocol.ts";
import { faultService } from "./faults.ts";
import { registry } from "./registry.ts";

const maxBody = 8192;

async function body(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new RequestError(415, "Expected application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBody) throw new RequestError(413, "Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  try {
    return { raw, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown };
  } catch {
    throw new RequestError(400, "Invalid JSON body");
  }
}

function respond(res: ServerResponse, status: number, value?: unknown) {
  res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

export function createMaster(db: pg.Pool, audience: string, admins: Record<string, string>, options?: AssignmentOptions, network = "testnet") {
  if (network !== "testnet" && !isSandboxNetwork(network)) throw new Error("Expected Testnet or a local Sandbox");
  const keys = Object.entries(admins).map(([id, token]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
      throw new Error("Invalid admin ID or token");
    }
    return { id, key: digest(token) };
  });
  if (keys.length === 0 || new Set(Object.values(admins)).size !== keys.length) {
    throw new Error("Configure at least one admin with a unique token");
  }
  const service = registry(db, audience, network);
  const assignments = assignmentService(db, audience, options, network);
  const faults = faultService(db, audience, network, options?.sign);
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method;
      if (isSandboxNetwork(network) && req.socket.remoteAddress !== "127.0.0.1") {
        throw new RequestError(403, "Sandbox administration is local only");
      }
      if (method === "GET" && path === "/healthz") {
        await db.query("SELECT 1");
        return respond(res, 200, { status: "ok" });
      }
      if (path.startsWith("/admin/")) {
        const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
        const tokenHash = token && digest(token);
        const admin = tokenHash && keys.find(({ key }) => timingSafeEqual(key, tokenHash));
        if (!admin) throw new RequestError(401, "Administrator authentication required");
        const after = url.searchParams.get("after");
        const cursor = after === null ? null : uuid(after);
        if (path === "/admin/oracles/invitations") {
          if (method === "POST") return respond(res, 201, await service.createInvite(admin, (await body(req)).value));
          if (method === "GET") return respond(res, 200, await service.listInvites(cursor));
        }
        const invitation = path.match(/^\/admin\/oracles\/invitations\/([^/]+)$/);
        if (method === "DELETE" && invitation) {
          await service.revokeInvite(admin, uuid(invitation[1]));
          return respond(res, 204);
        }
        if (method === "GET" && (path === "/admin/oracles" || path === "/admin/oracles/pending")) {
          return respond(res, 200, await service.listNodes(cursor, path.endsWith("/pending")));
        }
        if (method === "GET" && path === "/admin/oracles/summary") {
          return respond(res, 200, await service.summary());
        }
        const assignment = path.match(/^\/admin\/oracles\/([^/]+)\/assignments$/);
        if (method === "POST" && assignment) {
          return respond(res, 201, await assignments.assign(admin.id, uuid(assignment[1]), (await body(req)).value));
        }
        if (method === "GET" && assignment) {
          return respond(res, 200, await assignments.history(uuid(assignment[1]), cursor));
        }
        const fault = path.match(/^\/admin\/oracles\/([^/]+)\/fault-schedule$/);
        if (fault) {
          const nodeId = uuid(fault[1]);
          if (method === "GET") return respond(res, 200, await faults.read(db, nodeId));
          if (method === "POST") return respond(res, 201, await faults.update(admin.id, nodeId, (await body(req)).value));
          if (method === "DELETE") return respond(res, 200, await faults.update(admin.id, nodeId, { schedule: null }));
        }
        const node = path.match(/^\/admin\/oracles\/([^/]+)(?:\/(approve|reject|disable|enable|revoke|heartbeats))?$/);
        if (node) {
          const [, id, action] = node;
          if (method === "GET" && !action) return respond(res, 200, await service.node(uuid(id)));
          if (method === "GET" && action === "heartbeats") return respond(res, 200, await service.history(uuid(id), cursor));
          if (method === "POST" && action && action !== "heartbeats") {
            return respond(res, 200, await service.changeStatus(admin, uuid(id), action as Parameters<typeof service.changeStatus>[2]));
          }
        }
      }
      if (method === "POST" && (path === "/oracles/registration/challenge" || path === "/oracles/registration/verify")) {
        await service.limit("registration:" + req.socket.remoteAddress, 30);
        const { value } = await body(req);
        const result = path.endsWith("/challenge") ? await service.challenge(value) : await service.register(value);
        return respond(res, 201, result);
      }
      if (method === "POST" && path === heartbeatPath) {
        const { raw, value } = await body(req);
        const signature = req.headers["x-sla-signature"];
        return respond(res, 200, await service.heartbeat(
          uuid(req.headers["x-sla-node"]), typeof signature === "string" ? signature : undefined, raw, value,
        ));
      }
      if (method === "POST" && (path === assignmentsPath || path === registrationStatusPath || path === faultSchedulePath)) {
        const { raw, value } = await body(req);
        const nodeId = uuid(req.headers["x-sla-node"]);
        const signature = req.headers["x-sla-signature"];
        const signed = typeof signature === "string" ? signature : undefined;
        if (path === registrationStatusPath) {
          const result = await service.authenticated(nodeId, signed, path, raw, value, false,
            async (_client, node) => ({ id: nodeId, status: node.status }));
          return respond(res, 200, result);
        }
        if (path === faultSchedulePath) {
          const result = await service.authenticated(nodeId, signed, path, raw, value, true,
            (client) => faults.read(client, nodeId));
          return respond(res, 200, result);
        }
        const result = await service.authenticated(nodeId, signed, path, raw, value, true,
          (client, _node, cursor) => assignments.list(client, nodeId, cursor));
        return respond(res, 200, result);
      }
      throw new RequestError(404, "Route not found");
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 413) {
          res.setHeader("Connection", "close");
          req.resume();
        }
        if (error.status === 429) res.setHeader("Retry-After", error.retryAfter ?? "60");
        return respond(res, error.status, { error: error.message });
      }
      console.error("Master request failed", error instanceof Error ? error.name : "UnknownError");
      respond(res, 503, { error: "Master is temporarily unavailable" });
    }
  });
}

async function main() {
  const { SLA_MASTER_DATABASE_URL: database, SLA_MASTER_ADMIN_FILE: adminFile, SLA_MASTER_AUDIENCE: audience } = process.env;
  if (!database || !adminFile || !isAudience(audience)) {
    throw new Error("Set SLA_MASTER_DATABASE_URL, SLA_MASTER_ADMIN_FILE and SLA_MASTER_AUDIENCE");
  }
  const admins: unknown = JSON.parse(await readFile(adminFile, "utf8"));
  if (!admins || typeof admins !== "object" || Array.isArray(admins)
      || Object.values(admins).some((token) => typeof token !== "string")) throw new Error("Invalid admin file");
  const port = Number(process.env.SLA_MASTER_PORT ?? 8789);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid master port");
  const host = process.env.SLA_MASTER_HOST ?? "127.0.0.1";
  const sandboxNetwork = process.env.SLA_MASTER_SANDBOX_NETWORK;
  const sandboxRpc = process.env.SLA_MASTER_SANDBOX_RPC_URL;
  const signingFile = process.env.SLA_MASTER_ASSIGNMENT_KEY_FILE;
  if ((sandboxNetwork || sandboxRpc) && (!sandboxNetwork || !isSandboxNetwork(sandboxNetwork) || !sandboxRpc || !signingFile)) {
    throw new Error("Local Sandbox mode requires the Sandbox network, loopback RPC and an assignment key");
  }
  const network = sandboxNetwork ?? "testnet";
  if (host !== "127.0.0.1" && (host !== "0.0.0.0" || network !== "testnet")) {
    throw new Error("Invalid Master host. Sandbox requires loopback");
  }
  const options = signingFile ? assignmentOptions(await readFile(signingFile), sandboxRpc ?? process.env.SLA_MASTER_TESTNET_RPC_URL, network) : undefined;
  const passwordFile = process.env.SLA_MASTER_DATABASE_PASSWORD_FILE;
  let connectionString = database;
  if (passwordFile) {
    const url = new URL(database);
    const password = (await readFile(passwordFile, "utf8")).trim();
    if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:")
        || url.password || url.searchParams.has("password") || !password) {
      throw new Error("Use a PostgreSQL URL without a password when setting the database password file");
    }
    url.password = encodeURIComponent(password);
    connectionString = url.toString();
  }
  const db = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  db.on("error", () => console.error("An idle database connection failed"));
  try {
    await migrate(db);
    const server = createMaster(db, audience, admins as Record<string, string>, options, network);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const maintenance = registry(db, audience, network);
    const prune = setInterval(() => maintenance.prune().catch(() => console.error("Master cleanup failed")), 60_000);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        clearInterval(prune);
        server.close(() => { void db.end(); });
      });
    }
    console.log("SLA Sentinel Master listening on " + host + ":" + port + " for " + network);
  } catch (error) {
    await db.end();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof RequestError ? error.message : "Master could not start");
    process.exitCode = 1;
  });
}
