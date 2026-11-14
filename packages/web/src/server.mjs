import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { verifySettlement } from "../../operator/src/settlement/settlement.ts";
import { boundedJson } from "../../shared/http-json.ts";
import { nearRpc, scopedVotePermission } from "../../shared/near-rpc.ts";
import { isAccountId, isBase58Hash, isNearPublicKey, isNetworkAccount, isRecord, isU64, isUuid, loopbackControl, loopbackHealth, policyFromAgreement } from "../../shared/oracle-protocol.ts";
import { readAgreementEvidence } from "./evidence-timeline.mjs";
import { walletRoutes } from "./wallet-routes.mjs";
import { serveProduct } from "./product.mjs";

const master = "http://127.0.0.1:8789";
const consoleEnabled = process.env.SLA_LOCAL_ENABLE_CONSOLE === "1";
const sandbox = "http://127.0.0.1:34831";
const token = /^Bearer [A-Za-z0-9_-]{43,128}$/;
const credential = (await readFile(process.env.SLA_CONSOLE_TOKEN_FILE ?? "/run/console-auth/console-token", "utf8")).trim();
if (!token.test("Bearer " + credential)) throw new Error("Invalid local console credential");
const digest = (value) => createHash("sha256").update(value).digest();
const allowedToken = digest("Bearer " + credential);
const chainFile = process.env.SLA_CONSOLE_CHAIN_FILE ?? "/escrow/deployment.json";
const chain = JSON.parse(await readFile(chainFile, "utf8"));
chain.genesis = (await readFile(join(dirname(chainFile), "genesis-hash"), "utf8")).trim();
const composeProject = process.env.SLA_CONSOLE_PROJECT ?? "sla-sentinel-local";
const origin = new URL(process.env.SLA_CONSOLE_ORIGIN ?? "http://127.0.0.1:8780");
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.href !== origin.origin + "/"
    || chain.network !== "test-chain-sla-sentinel" || !isNetworkAccount(chain.contract, chain.network)
    || !isBase58Hash(chain.code_hash) || !isBase58Hash(chain.genesis) || chain.endpoint !== loopbackHealth) {
  throw new Error("Use the loopback Sandbox console");
}
if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) throw new Error("Invalid console Compose project");
const rpc = nearRpc(sandbox, chain.network, undefined, chain.genesis);
const receiptProvider = new JsonRpcProvider({ url: sandbox }, { retries: 1 });
const wallet = walletRoutes(chain, rpc, async (id, signer, hash, state) => {
  const trace = await receiptProvider.viewTransactionStatusWithReceipts({
    accountId: signer, txHash: hash, waitUntil: "FINAL",
  });
  return verifySettlement({
    contract: chain.contract, slaId: id, transactionHash: hash, policyVersion: 2,
    kind: state.outcome === "breach" ? "compensation" : "refund",
  }, state, trace);
});

async function recordedClaim(hash, signer) {
  if (!isBase58Hash(hash) || !isNetworkAccount(signer, chain.network)) return null;
  let file;
  let record;
  try {
    file = await open("/demo-state/" + hash + ".json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 131_072) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead !== stat.size) return null;
    record = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { await file?.close(); }
  const { genesis, slaId, trace } = record;
  if (genesis !== chain.genesis || !isU64(slaId) || trace?.transaction?.signer_id !== signer) return null;
  const { agreement: state, codeHash } = await rpc.readAgreement(chain.contract, slaId);
  if (!state || codeHash !== chain.code_hash) throw new Error("Recorded claim does not match the active escrow");
  const proof = verifySettlement({
    contract: chain.contract, slaId, transactionHash: hash, policyVersion: 2,
    kind: state.outcome === "breach" ? "compensation" : "refund",
  }, state, trace);
  return { status: "final", hash, sla_id: slaId, method: "claim", payment: "paid", source: "recorded", proof };
}
const endpointHash = digest(chain.endpoint);

const assets = new Map();
for (const [path, file, contentType] of [
  ["/console", "index.html", "text/html"],
  ["/app.js", "app.js", "text/javascript"],
  ["/agreement-ui.js", "agreement-ui.js", "text/javascript"],
  ["/evidence-ui.js", "evidence-ui.js", "text/javascript"],
  ["/wallet-bundle.js", "wallet-bundle.js", "text/javascript"],
  ["/styles.css", "styles.css", "text/css"],
]) {
  assets.set(path, { contentType, body: await readFile(new URL("../public/" + file, import.meta.url)) });
}
const security = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(response, status, value) {
  response.writeHead(status, { ...security, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function serviceStatus(url, expected) {
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok || !expected) {
      await response.body?.cancel();
      return response.ok;
    }
    return expected(await boundedJson(response, 96_000));
  } catch { return false; }
}

function masterRoute(path, method) {
  if (method === "GET" && ["/oracles", "/oracles/pending", "/oracles/summary"].includes(path)) return path;
  if (path === "/oracles/invitations" && ["GET", "POST"].includes(method)) return path;
  const invite = /^\/oracles\/invitations\/([^/]+)$/.exec(path);
  if (invite && method === "DELETE" && isUuid(invite[1])) return path;
  const node = /^\/oracles\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (!node || !isUuid(node[1])) return;
  if (method === "GET" && (!node[2] || ["heartbeats", "assignments"].includes(node[2]))) return path;
  if (method === "POST" && node[2] === "assignments") return path;
  if (method === "POST" && ["approve", "reject", "disable", "enable", "revoke"].includes(node[2])) return path;
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 6144) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function agreement(response, id, oracle) {
  if (!isU64(id)) return json(response, 400, { error: "Use a valid SLA ID" });
  if (oracle !== undefined && !isAccountId(oracle)) return json(response, 400, { error: "Use a valid oracle account" });
  const snapshot = await rpc.readAgreement(chain.contract, id);
  if (snapshot.codeHash !== chain.code_hash) throw new Error("The finalized contract code hash changed");
  const value = snapshot.agreement;
  if (value === null) return json(response, 404, { error: "Agreement not found" });
  if (!isRecord(value)) throw new Error("Unexpected agreement state");
  const policy = policyFromAgreement(value);
  if (oracle !== undefined) {
    const index = policy.oracles.indexOf(oracle);
    if (index < 0) return json(response, 404, { error: "Oracle is outside the finalized agreement roster" });
    if (!Array.isArray(value.votes) || value.votes.length !== policy.oracles.length) throw new Error("Invalid finalized votes");
    const { endpoint_hash, starts_at_ms, slot_ms, slot_count } = policy;
    const config = { network: chain.network, contract: chain.contract, sla_id: id, oracle,
      endpoint_hash, starts_at_ms, slot_ms, slot_count };
    const result = await readAgreementEvidence("/evidence", config, value.votes[index]);
    return json(response, 200, { genesis: chain.genesis, ...result });
  }
  return json(response, 200, {
    sla_id: id, network: chain.network, genesis: chain.genesis, contract: chain.contract,
    block_hash: snapshot.blockHash, chain_time_ms: snapshot.time,
    ...policy, provider: value.provider, customer: value.customer, payout: value.payout,
    accepted: value.accepted, outcome: value.outcome, payment: value.payment,
    confirmed_down_slots: value.confirmed_down_slots, possible_down_slots: value.possible_down_slots, votes: value.votes,
    target_url: Buffer.from(policy.endpoint_hash).equals(endpointHash) ? chain.endpoint : null,
  });
}

async function eligibleOracles(response, cursor, authorization) {
  const url = new URL("/admin/oracles", master);
  if (cursor) url.searchParams.set("after", cursor);
  const [registry, { blockHash }] = await Promise.all([
    fetch(url, { headers: { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(5500) }),
    rpc.finalizedBlock(),
  ]);
  const page = await boundedJson(registry, 128_000);
  if (!registry.ok) return json(response, registry.status, page);
  const escrow = await rpc.query(blockHash, { request_type: "view_account", account_id: chain.contract });
  if (escrow.code_hash !== chain.code_hash) return json(response, 409, { error: "The finalized escrow code has changed" });
  const candidates = page.items.filter((node) => node.status === "ACTIVE" && node.connectivity === "ONLINE"
    && isNetworkAccount(node.near_account, chain.network) && isNearPublicKey(node.near_public_key));
  const verified = await Promise.all(candidates.map(async (node) => {
    try {
      const view = await rpc.query(blockHash, {
        request_type: "view_access_key", account_id: node.near_account, public_key: node.near_public_key,
      });
      if (scopedVotePermission(view.permission, chain.contract)) return { id: node.id, near_account: node.near_account };
    } catch (error) {
      if (!["UNKNOWN_ACCOUNT", "UNKNOWN_ACCESS_KEY"].includes(error.rpcCause)) throw error;
    }
    return null;
  }));
  return json(response, 200, { items: verified.filter(Boolean), next: page.next });
}

createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
  try {
    if (request.headers.host !== origin.host) return json(response, 421, { error: "Unexpected console host" });
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin.origin) return json(response, 421, { error: "Unexpected console origin" });
    const { pathname: path } = url;
    const method = request.method;
    if (method === "GET" && path === "/healthz") return json(response, 200, { status: "ok" });
    if (!consoleEnabled) {
      if (method === "GET" && await serveProduct(path, response, security)) return;
      return json(response, 404, { error: "Route not found" });
    }
    // Existing agreement and recording URLs still open the console.
    const legacyAgreement = path === "/" && url.searchParams.has("sla");
    const asset = assets.get(legacyAgreement ? "/console" : path);
    if (method === "GET" && asset) {
      response.writeHead(200, { ...security, "Content-Type": asset.contentType + "; charset=utf-8" });
      return response.end(asset.body);
    }
    if (method === "GET" && await serveProduct(path, response, security)) return;
    if ((request.headers.origin && request.headers.origin !== origin.origin)
        || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
      return json(response, 403, { error: "Use the console's own origin" });
    }
    if (method === "GET" && path === "/api/health") {
      const [masterOnline, chainOnline, targetOnline, controlOnline] = await Promise.all([
        serviceStatus(master + "/healthz", (value) => value.status === "ok"),
        serviceStatus(sandbox + "/status", (value) => value.chain_id === chain.network && value.genesis_hash === chain.genesis
          && value.sync_info?.syncing === false),
        serviceStatus(loopbackHealth),
        serviceStatus(loopbackControl),
      ]);
      return json(response, 200, {
        master: masterOnline, sandbox: chainOnline, target: targetOnline, control: controlOnline, network: chain.network,
        contract: chain.contract, genesis: chain.genesis, code_hash: chain.code_hash, endpoint: chain.endpoint,
        compose_project: composeProject,
      });
    }
    const route = path.startsWith("/api/") && masterRoute(path.slice(4), method);
    const eligible = method === "GET" && path === "/api/oracles/eligible";
    const sla = method === "GET" && /^\/api\/agreements\/([^/]+)(?:\/evidence\/([^/]+))?$/.exec(path);
    if (sla) return await agreement(response, sla[1], sla[2]);
    const transaction = method === "POST" && /^\/api\/wallet\/(account|prepare|send|status)$/.exec(path);
    const settlementVerification = method === "POST" && path === "/api/settlement/verify";
    if (!route && !eligible && !transaction && !settlementVerification) {
      return json(response, 404, { error: "Route not found" });
    }
    const authorization = request.headers.authorization;
    if ((route || eligible) && (!token.test(authorization ?? "") || !timingSafeEqual(digest(authorization), allowedToken))) {
      return json(response, 401, { error: "Enter the local operator token" });
    }
    if (method !== "GET" && request.headers.origin !== origin.origin) {
      return json(response, 403, { error: "Use the console's own origin" });
    }
    const cursors = url.searchParams.getAll("after");
    if (cursors.length > 1 || (cursors.length === 1 && (method !== "GET" || !isUuid(cursors[0])))) {
      return json(response, 400, { error: "Invalid page cursor" });
    }
    if (eligible) return await eligibleOracles(response, cursors[0], authorization);
    const headers = {};
    let body;
    if (method === "POST") {
      if (request.headers["content-type"] !== "application/json") {
        return json(response, 415, { error: "Expected application/json" });
      }
      body = await requestBody(request);
      if (!body) {
        response.setHeader("Connection", "close");
        request.resume();
        return json(response, 413, { error: "Request body is too large" });
      }
      headers["Content-Type"] = "application/json";
    }
    if (transaction || settlementVerification) {
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { return json(response, 400, { error: "Invalid JSON body" }); }
      if (settlementVerification) {
        const recorded = await recordedClaim(payload?.hash, payload?.signer);
        if (recorded) return json(response, 200, recorded);
      }
      const result = await wallet.handle(settlementVerification ? "status" : transaction[1], payload);
      return json(response, result.status, result.value);
    }
    const upstream = new URL("/admin" + route, master);
    if (cursors.length) upstream.searchParams.set("after", cursors[0]);
    headers.Authorization = authorization;
    const result = await fetch(upstream, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(7000) });
    if (result.status === 204) {
      response.writeHead(204, security);
      return response.end();
    }
    return json(response, result.status, await boundedJson(result, 512_000));
  } catch {
    if (!response.headersSent) json(response, 503, { error: "The requested service could not complete the request" });
    else response.end();
  }
}).listen(8780, "0.0.0.0");
