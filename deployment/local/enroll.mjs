import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { KeyPairSigner } from "near-api-js";
import { loadIdentity } from "../src/worker/identity.ts";
import { masterClient, MasterError, workerVersion } from "../src/worker/master-client.ts";

const origin = "http://127.0.0.1:8789";
const token = (await readFile("/run/bootstrap-auth/token", "utf8")).trim();
async function admin(path, payload = {}) {
  const response = await fetch(origin + "/admin/oracles/" + path, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Local enrollment administration failed with HTTP " + response.status);
  return response.json();
}

for (let i = 1; i <= 3; i++) {
  const role = `oracle-${i}`;
  const key = KeyPairSigner.fromSecretKey(await readFile(`/${role}/vote-key`, "utf8"));
  const identity = await loadIdentity(`/${role}`, {
    master: origin, audience: origin, network: "test-chain-sla-sentinel", near_account: `${role}.test.near`,
    near_public_key: (await key.getPublicKey()).toString(),
  });
  const client = masterClient(identity);
  let status;
  try { status = await client.status(); }
  catch (error) {
    if (!(error instanceof MasterError) || error.status !== 404) throw error;
    const { code } = await admin("invitations", { ttl_seconds: 300 });
    status = await client.join(code, { version: workerVersion, region: "Local Sandbox" });
  }
  if (status === "PENDING_APPROVAL") ({ status } = await admin(identity.node_id + "/approve"));
  assert.ok(["ACTIVE", "DISABLED", "REJECTED", "REVOKED"].includes(status));
  console.log(`${identity.near_account}: ${status}`);
}
