import { demoRoles } from "../../shared/testnet-demo.ts";
import { voteSigner } from "../src/oracles/oracle-signer.ts";
import { loadIdentity, readWorkerFile } from "../src/worker/identity.ts";
import { masterClient, MasterError, workerVersion } from "../src/worker/master-client.ts";
import { audience, masterUrl } from "./fixture-policy.mjs";

const { accounts } = JSON.parse((await readWorkerFile("/registry/deployment.json", 8192, false)).toString("utf8"));
const token = (await readWorkerFile("/admin-access/operator", 256)).toString("utf8").trim();
async function admin(action, body) {
  const response = await fetch(masterUrl + "/admin/oracles/" + action, {
    method: "POST", body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(6000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Dedicated Master enrollment failed with HTTP " + response.status);
  }
  return response.json();
}
for (const role of demoRoles) {
  const directory = "/states/" + role;
  const signer = voteSigner((await readWorkerFile(directory + "/vote", 256)).toString("utf8").trim());
  const identity = await loadIdentity(directory, {
    master: masterUrl, audience, network: "testnet", near_account: accounts[role],
    near_public_key: (await signer.getPublicKey()).toString(),
  });
  const client = masterClient(identity);
  let status;
  try { status = await client.status(); }
  catch (error) {
    if (!(error instanceof MasterError) || error.status !== 404) throw error;
    const { code } = await admin("invitations", { ttl_seconds: 300 });
    status = await client.join(code, { version: workerVersion, region: "Single-host Testnet demo" });
  }
  if (status === "PENDING_APPROVAL") ({ status } = await admin(identity.node_id + "/approve", {}));
  if (status !== "ACTIVE") throw new Error("Dedicated demo Oracle enrollment is " + status);
  console.log(role + " " + status);
}
