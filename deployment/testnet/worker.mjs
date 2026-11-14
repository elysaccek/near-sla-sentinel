import { isTestnetAccount } from "../../shared/oracle-protocol.ts";
import { nearWorker } from "../src/worker/near.ts";
import { voteSigner, requireVotePermission } from "../src/oracles/oracle-signer.ts";
import { loadIdentity, privateDirectory, readWorkerFile } from "../src/worker/identity.ts";
import { masterClient, masterVerifiers } from "../src/worker/master-client.ts";
import { workerRunner } from "../src/worker/runner.ts";
import { lockWorker, openWorkerStore } from "../src/worker/store.ts";
import { demoRoles, testnetDemo } from "../../shared/testnet-demo.ts";
import { defaultTestnetRpc, nearRpc } from "../../shared/near-rpc.ts";
import { audience, controlEndpoint, endpoint, masterUrl } from "./fixture-policy.mjs";

const role = process.env.SLA_DEMO_ROLE;
if (!demoRoles.includes(role)) throw new Error("Expected a configured demonstration oracle");
const { contract, accounts } = JSON.parse((await readWorkerFile("/registry/deployment.json", 8192, false)).toString("utf8"));
const account = accounts[role];
if (!isTestnetAccount(account) || !isTestnetAccount(contract)) throw new Error("Expected dedicated Testnet accounts");
const signer = voteSigner((await readWorkerFile("/state/vote", 256)).toString("utf8").trim());
const publicKey = (await signer.getPublicKey()).toString();
const rpcUrl = process.env.SLA_DEMO_RPC ?? defaultTestnetRpc;
const rpc = nearRpc(rpcUrl, "testnet", undefined, testnetDemo.genesis);
const block = await rpc.finalizedBlock();
const [key, deployment] = await Promise.all([
  rpc.query(block.blockHash, { request_type: "view_access_key", account_id: account, public_key: publicKey }),
  rpc.query(block.blockHash, { request_type: "view_account", account_id: contract }),
]);
requireVotePermission(key.permission, contract);
if (deployment.code_hash !== testnetDemo.codeHash) throw new Error("Unexpected Testnet escrow code");
const directory = await privateDirectory("/state");
const identity = await loadIdentity(directory, { master: masterUrl, audience, network: "testnet", near_account: account, near_public_key: publicKey });
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const status = await masterClient(identity, controller.signal).status();
if (status !== "ACTIVE") throw new Error("Dedicated demo Oracle enrollment is " + status);
const observerToken = (await readWorkerFile("/state/observer-token", 256)).toString("utf8").trim();
const probe = (url, options) => {
  if (url === endpoint) return fetch("http://127.0.0.1:8787/health", { ...options, redirect: "error", headers: {
    Authorization: "Bearer " + observerToken, "X-SLA-Observer": role,
  } });
  if (url === controlEndpoint) return fetch("http://127.0.0.1:8787/ready", { ...options, redirect: "error" });
  throw new Error("Probe is outside the dedicated fixture");
};
const release = lockWorker(directory);
try {
  const store = openWorkerStore(directory);
  try {
    store.setRegistration(status);
    const verify = masterVerifiers(identity, await readWorkerFile("/registry/assignment-public.der", 256, false)).assignment;
    await workerRunner({
      store, chain: nearWorker(rpcUrl, account, signer, "testnet", controller.signal, testnetDemo.genesis),
      identity, targets: { network: "testnet", contract, codeHash: testnetDemo.codeHash, endpoints: new Set([endpoint]) },
      verify, signal: controller.signal, controls: [controlEndpoint], fetch: probe,
      evidenceDirectory: await privateDirectory("/evidence"),
      event: message => console.log(message),
    }).run();
  } finally { store.close(); }
} finally { release(); }
