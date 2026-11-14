import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import pg from "pg";
import { assignmentMessage, assignmentsPath, nodeRequestMessage, policyFromAgreement, registrationStatusPath } from "../../shared/oracle-protocol.ts";
import { migrate } from "../src/database.ts";
import { assignmentOptions } from "../src/assignments.ts";
import { digest, heartbeatMessage, identityKey, registrationMessage, signatureMatches } from "../src/protocol.ts";
import { createMaster } from "../src/server.ts";

const audience = "test.sla-sentinel.local";
const adminToken = randomBytes(32).toString("base64url");
const database = process.env.SLA_MASTER_TEST_DATABASE_URL;
const testEndpoint = "https://api.example.com/health";

function identity(name: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    profile: {
      node_id: randomUUID(),
      identity_key: publicKey.export({ format: "jwk" }).x!,
      near_account: name + ".testnet",
      near_public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
      metadata: { region: "example", version: "0.1.0" },
    },
    sign: (message: string) => sign(null, Buffer.from(message), privateKey).toString("base64url"),
  };
}

test("Master resolves the policy, code and vote permission at one finalized Testnet block", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "jwk" }).x!;
  const contract = "escrow.testnet";
  const candidate = { near_account: "oracle.testnet", near_public_key: "ed25519:" + "2".repeat(32) };
  const block = "3".repeat(32);
  const codeHash = "4".repeat(32);
  const start = Date.now() + 10_000;
  const agreement = {
    policy_version: 2, oracles: [candidate.near_account, "b.testnet", "c.testnet", "d.testnet", "e.testnet"],
    endpoint_hash: Array.from(digest(testEndpoint)), starts_at_ms: String(start), ends_at_ms: String(start + 2000),
    reporting_deadline_ms: String(start + 60_000), slot_ms: 1000, slot_count: 2, down_quorum: 3,
    min_down_slots: 2, outcome: "undecided",
  };
  let fullAccess = false;
  t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    const { method, params, id } = JSON.parse(String(options.body));
    let result: object;
    if (method === "status") result = { chain_id: "testnet" };
    else if (method === "block") {
      assert.equal(params.finality, "final");
      result = { header: { hash: block, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } };
    } else {
      assert.equal(method, "query");
      assert.equal(params.block_id, block);
      if (params.request_type === "view_access_key") {
        assert.equal(params.account_id, candidate.near_account);
        assert.equal(params.public_key, candidate.near_public_key);
        result = { block_hash: block, permission: fullAccess ? "FullAccess" :
          { FunctionCall: { allowance: "10", receiver_id: contract, method_names: ["submit_vote"] } } };
      } else {
        assert.equal(params.account_id, contract);
        result = params.request_type === "view_account" ? { block_hash: block, code_hash: codeHash }
          : { block_hash: block, result: [...Buffer.from(JSON.stringify(agreement))] };
      }
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  const options = assignmentOptions(privateKey.export({ format: "der", type: "pkcs8" }));
  const req = { contract, sla_id: "0", endpoint: testEndpoint };
  const resolved = await options.load(req, candidate);
  assert.equal(resolved.code_hash, codeHash);
  assert.equal(resolved.policy.down_quorum, 3);
  assert.equal(signatureMatches(rawPublic, options.sign("assignment"), "assignment"), true);
  fullAccess = true;
  await assert.rejects(options.load(req, candidate), /scoped vote key/);
});

test("identity proofs bind the service, node, action and exact heartbeat body", () => {
  const node = identity("crypto");
  const { node_id: id, identity_key: key } = node.profile;
  const payload = Buffer.from('{"request_id":"heartbeat"}');
  const message = heartbeatMessage(audience, id, payload);
  const signature = node.sign(message);
  assert.equal(signatureMatches(key, signature, message), true);
  assert.equal(signatureMatches(key, signature, heartbeatMessage("other.example", id, payload)), false);
  assert.equal(signatureMatches(key, signature, heartbeatMessage(audience, randomUUID(), payload)), false);
  assert.equal(signatureMatches(key, signature, heartbeatMessage(audience, id, Buffer.concat([payload, Buffer.from(" ")]))), false);
  assert.equal(signatureMatches(key, signature, registrationMessage(audience, randomUUID(), id, key, "crypto.testnet", {})), false);
  assert.throws(() => signatureMatches(key, signature + "=", message), /Invalid key or signature/);
  assert.equal(identityKey(key), key);
  assert.throws(() => identityKey(Buffer.alloc(32).toString("base64url")), /Invalid Ed25519 identity key/);
});

test("registry lifecycle over HTTP and PostgreSQL", { skip: !database && "Set SLA_MASTER_TEST_DATABASE_URL" }, async (t) => {
  const schema = "master_test_" + randomBytes(8).toString("hex");
  const base = { connectionString: database, connectionTimeoutMillis: 5000, statement_timeout: 5000 };
  const maintenance = new pg.Pool(base);
  t.after(() => maintenance.end());
  await maintenance.query(`CREATE SCHEMA "${schema}"`);
  const dbOptions = {
    ...base,
    onConnect: (client: pg.Client) => client.query(`SET search_path TO "${schema}"`),
  };
  const { privateKey: assignmentKey, publicKey: assignmentPublicKey } = generateKeyPairSync("ed25519");
  const key = assignmentPublicKey.export({ format: "jwk" }).x!;
  let otherRoster = false;
  const options = {
    sign: (message: string) => sign(null, Buffer.from(message), assignmentKey).toString("base64url"),
    load: async (request: { contract: string; sla_id: string; endpoint: string }, node: { near_account: string; near_public_key: string }) => {
      assert.match(node.near_public_key, /^ed25519:/);
      const start = 1_850_000_000_000;
      return { ...request, network: "testnet", code_hash: "2".repeat(32), policy: policyFromAgreement({
        policy_version: 2, oracles: [otherRoster ? "outsider.testnet" : node.near_account, "b.testnet", "c.testnet"],
        down_quorum: 2, min_down_slots: 2, slot_ms: 1000, slot_count: 2, starts_at_ms: String(start),
        ends_at_ms: String(start + 2000), reporting_deadline_ms: String(start + 62_000),
        endpoint_hash: Array.from(digest(testEndpoint)),
      }) };
    },
  };
  let db = new pg.Pool(dbOptions);
  let server = createMaster(db, audience, { operator: adminToken }, options);
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
  });
  // Drop through a separate client so cleanup does not depend on hook order.
  t.after(async () => {
    const client = new pg.Client(base);
    await client.connect();
    try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await client.end(); }
  });
  let url: string;
  async function listen() {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    url = "http://127.0.0.1:" + address.port;
  }
  await migrate(db);
  assert.equal((await db.query("SELECT current_schema() AS schema")).rows[0].schema, schema);
  await listen();

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(url + path, { ...init, signal: AbortSignal.timeout(7000) });
    return { status: response.status, value: response.status === 204 ? undefined : await response.json(), headers: response.headers };
  }
  const post = (path: string, data: unknown) => request(path, {
    method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" },
  });
  const admin = (path: string, method = "GET", data?: unknown) => request("/admin/oracles" + path, {
    method, body: data === undefined ? undefined : JSON.stringify(data),
    headers: { Authorization: "Bearer " + adminToken, "Content-Type": "application/json" },
  });
  const invite = async () => {
    const result = await admin("/invitations", "POST", { ttl_seconds: 60 });
    assert.equal(result.status, 201);
    return result.value as { id: string; code: string };
  };
  const challenge = (code: string, node: ReturnType<typeof identity>) =>
    post("/oracles/registration/challenge", { invite_code: code, ...node.profile });
  const prove = (challenge: { id: string; message: string }, node: ReturnType<typeof identity>) =>
    post("/oracles/registration/verify", { challenge_id: challenge.id, signature: node.sign(challenge.message) });
  const sendHeartbeat = (
    node: ReturnType<typeof identity>, timestamp = Date.now(), signingNode = node, requestId = randomUUID(),
  ) => {
    const raw = Buffer.from(JSON.stringify({ request_id: requestId, reported_at_ms: timestamp, health: { rpc: "ok" } }));
    return request("/oracles/heartbeat", { method: "POST", body: raw, headers: {
      "Content-Type": "application/json", "X-SLA-Node": node.profile.node_id,
      "X-SLA-Signature": signingNode.sign(heartbeatMessage(audience, node.profile.node_id, raw)),
    } });
  };
  const nodeRequest = (path: string, node: ReturnType<typeof identity>, signer = node, nonce = randomUUID()) => {
    const raw = Buffer.from(JSON.stringify({ request_id: nonce, reported_at_ms: Date.now() }));
    return request(path, { method: "POST", body: raw, headers: {
      "Content-Type": "application/json", "X-SLA-Node": node.profile.node_id,
      "X-SLA-Signature": signer.sign(nodeRequestMessage(audience, node.profile.node_id, path, raw)),
    } });
  };

  const first = identity("first");
  const second = identity("second");
  let enrolled: ReturnType<typeof identity>;

  await t.test("only the administrator can create or inspect invitations and the code is disclosed once", async () => {
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await post("/admin/oracles/invitations", {})).status, 401);
    assert.equal((await request("/admin/oracles/summary")).status, 401);
    assert.deepEqual((await admin("/summary")).value, { registered: 0, online: 0, pending: 0 });
    const issued = await invite();
    const stored = await db.query("SELECT digest FROM oracle_invitations WHERE id = $1", [issued.id]);
    assert.deepEqual(stored.rows[0].digest, digest(issued.code));
    const listed = await admin("/invitations");
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(listed.value).includes(issued.code), false);
    assert.equal(Object.hasOwn(listed.value.items[0], "digest"), false);
    assert.equal((await challenge("SLA-ORACLE-" + randomBytes(32).toString("base64url"), first)).status, 403);
    await db.query("UPDATE oracle_invitations SET expires_at = clock_timestamp() WHERE id = $1", [issued.id]);
    assert.equal((await challenge(issued.code, first)).status, 403);
    const revoked = await invite();
    const outstanding = await challenge(revoked.code, first);
    assert.equal(outstanding.status, 201);
    assert.equal((await admin("/invitations/" + revoked.id, "DELETE")).status, 204);
    assert.equal((await prove(outstanding.value, first)).status, 409);
    assert.equal((await challenge(revoked.code, first)).status, 403);
  });

  await t.test("concurrent signed requests consume an invitation once and await approval", async () => {
    const issued = await invite();
    const [a, b] = await Promise.all([challenge(issued.code, first), challenge(issued.code, second)]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal((await prove(a.value, second)).status, 401);
    const [proofA, proofB] = await Promise.all([prove(a.value, first), prove(b.value, second)]);
    assert.deepEqual([proofA.status, proofB.status].sort(), [201, 409]);
    enrolled = proofA.status === 201 ? first : second;
    const id = enrolled.profile.node_id;
    assert.equal((proofA.status === 201 ? proofA : proofB).value.id, id);
    assert.equal((await prove(proofA.status === 201 ? a.value : b.value, enrolled)).status, 409);
    assert.equal((await challenge(issued.code, first)).status, 403);
    assert.equal((await admin("/pending")).value.items[0].id, id);
    assert.deepEqual((await admin("/summary")).value, { registered: 1, online: 0, pending: 1 });
    assert.equal((await sendHeartbeat(enrolled)).status, 403);
    assert.equal((await nodeRequest(registrationStatusPath, enrolled)).value.status, "PENDING_APPROVAL");
    assert.equal((await nodeRequest(assignmentsPath, enrolled)).status, 403);
    assert.equal((await admin("/" + id + "/approve", "POST")).value.status, "ACTIVE");
  });

  await t.test("only the assigned active node can read a signed immutable policy", async () => {
    const id = enrolled.profile.node_id;
    const request = { contract: "escrow.testnet", sla_id: "0", endpoint: testEndpoint };
    otherRoster = true;
    assert.equal((await admin("/" + id + "/assignments", "POST", request)).status, 409);
    otherRoster = false;
    assert.equal((await admin("/" + id + "/assignments", "POST", { ...request, endpoint: "https://other.example.com/health" })).status, 422);
    const issued = await admin("/" + id + "/assignments", "POST", request);
    assert.equal(issued.status, 201);
    assert.equal((await admin("/" + id + "/assignments", "POST", request)).value.id, issued.value.id);
    assert.equal((await admin("/" + id + "/assignments")).value.items[0].id, issued.value.id);
    assert.equal((await admin("/" + id + "/fault-schedule", "POST", { schedule: null })).status, 404);
    const foreign = enrolled === first ? second : first;
    assert.equal((await nodeRequest(assignmentsPath, enrolled, foreign)).status, 401);
    const requestId = randomUUID();
    const list = await nodeRequest(assignmentsPath, enrolled, enrolled, requestId);
    assert.equal(list.status, 200);
    assert.equal(list.value.items.length, 1);
    const [{ assignment, signature }] = list.value.items;
    assert.equal(signatureMatches(key, signature, assignmentMessage(audience, id, assignment)), true);
    assert.equal(signatureMatches(key, signature, assignmentMessage(audience, foreign.profile.node_id, assignment)), false);
    assert.equal((await nodeRequest(assignmentsPath, enrolled, enrolled, requestId)).status, 409);
  });

  await t.test("heartbeat signatures, replay, freshness and connectivity are independent of approval", async () => {
    const id = enrolled.profile.node_id;
    const peer = enrolled === first ? second : first;
    const requestId = randomUUID();
    const timestamp = Date.now();
    assert.equal((await sendHeartbeat(enrolled, timestamp, peer)).status, 401);
    assert.equal((await sendHeartbeat(enrolled, timestamp - 120_000)).status, 400);
    assert.equal((await sendHeartbeat(enrolled, timestamp + 120_000)).status, 400);
    assert.equal((await sendHeartbeat(enrolled, timestamp, enrolled, requestId)).status, 200);
    assert.equal((await sendHeartbeat(enrolled, timestamp, enrolled, requestId)).status, 409);
    assert.equal((await sendHeartbeat(enrolled)).status, 429);
    assert.equal((await admin("/" + id + "/heartbeats")).value.items.length, 1);
    assert.equal((await admin("/" + id)).value.connectivity, "ONLINE");
    assert.deepEqual((await admin("/summary")).value, { registered: 1, online: 1, pending: 0 });
    await db.query("UPDATE oracle_nodes SET last_heartbeat_at = clock_timestamp() - interval '2 minutes' WHERE id = $1", [id]);
    const offline = await admin("/" + id);
    assert.equal(offline.value.status, "ACTIVE");
    assert.equal(offline.value.connectivity, "OFFLINE");
    assert.equal((await admin("/" + id + "/disable", "POST")).value.status, "DISABLED");
    assert.equal((await sendHeartbeat(enrolled)).status, 403);
    assert.equal((await admin("/" + id + "/enable", "POST")).value.status, "ACTIVE");
  });

  await t.test("restart preserves records and revocation reserves the account and key", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
    db = new pg.Pool(dbOptions);
    await migrate(db);
    server = createMaster(db, audience, { operator: adminToken }, options);
    await listen();
    const id = enrolled.profile.node_id;
    assert.equal((await admin("/" + id)).value.status, "ACTIVE");
    assert.equal((await nodeRequest(assignmentsPath, enrolled)).value.items.length, 1);
    assert.equal((await admin("/" + id + "/revoke", "POST")).value.status, "REVOKED");
    assert.equal((await admin("/" + id + "/enable", "POST")).status, 409);
    assert.equal((await sendHeartbeat(enrolled)).status, 403);
    assert.equal((await nodeRequest(assignmentsPath, enrolled)).status, 403);
    const issued = await invite();
    const repeated = await challenge(issued.code, enrolled);
    assert.equal(repeated.status, 201);
    assert.equal((await prove(repeated.value, enrolled)).status, 409);
    const duplicate = identity("duplicate");
    duplicate.profile.near_account = enrolled.profile.near_account;
    assert.equal((await prove((await challenge(issued.code, duplicate)).value, duplicate)).status, 409);
    const applicant = identity("applicant");
    assert.equal((await prove((await challenge(issued.code, applicant)).value, applicant)).status, 201);
    assert.equal((await admin("/" + applicant.profile.node_id + "/reject", "POST")).value.status, "REJECTED");
    assert.equal((await sendHeartbeat(applicant)).status, 403);
    const { rows } = await db.query("SELECT actor, action FROM oracle_audit_log WHERE subject = $1 ORDER BY id", [id]);
    assert.deepEqual(rows.map(({ actor, action }) => [actor, action]), [
      [id, "registration_pending"], ["operator", "node_approve"], ["operator", "node_disable"],
      ["operator", "node_enable"], ["operator", "node_revoke"],
    ]);
  });

  await t.test("registry pagination supports more than fifty nodes", async () => {
    for (let n = 0; n < 52; n++) {
      const node = identity("scale-" + n);
      const code = "SLA-ORACLE-" + randomBytes(32).toString("base64url");
      const id = randomUUID();
      await db.query(`INSERT INTO oracle_invitations (id, digest, expires_at, consumed_at)
        VALUES ($1, $2, clock_timestamp(), clock_timestamp())`, [id, digest(code)]);
      await db.query(`INSERT INTO oracle_nodes (id, identity_key, near_account, invitation_id, metadata)
        VALUES ($1, $2, $3, $4, $5)`, [node.profile.node_id, node.profile.identity_key, node.profile.near_account, id, {}]);
    }
    const page1 = (await admin("")).value;
    assert.equal(page1.items.length, 50);
    const page2 = (await admin("?after=" + page1.next)).value;
    assert.equal(page2.next, null);
    assert.equal(new Set([...page1.items, ...page2.items].map(({ id }: { id: string }) => id)).size, 54);
  });

  await t.test("registration throttling ignores untrusted forwarding headers", async () => {
    const { rows: [window] } = await db.query("SELECT floor(extract(epoch FROM clock_timestamp()) / 60)::bigint AS minute");
    // Seed both minutes to keep this assertion stable around minute boundaries.
    for (const minute of [Number(window.minute), Number(window.minute) + 1]) {
      await db.query(`INSERT INTO oracle_rate_limits (bucket, window_start, attempts) VALUES ('registration:127.0.0.1', $1, 30)
        ON CONFLICT (bucket, window_start) DO UPDATE SET attempts = 30`, [minute]);
    }
    const result = await request("/oracles/registration/challenge", {
      method: "POST", body: "{}", headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.5" },
    });
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "60");
  });
});
