import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas, yoctoToNear } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { testnetDemo, demoRoles } from "../../shared/testnet-demo.ts";
import { isTestnetAccount } from "../../shared/oracle-protocol.ts";
import { defaultTestnetRpc, nearRpc, scopedVotePermission } from "../../shared/near-rpc.ts";
import { checkPilotWasm } from "../src/demo/settlement-pilot.ts";
import { fileError, readWorkerFile, writePrivateFile } from "../src/worker/identity.ts";
import { lockWorker } from "../src/worker/store.ts";

const { values: { submit, "provider-reserve": reserve, "sponsor-key-file": keyPath } } = parseArgs({ options: {
  submit: { type: "boolean" }, "provider-reserve": { type: "string", default: "1000" },
  "sponsor-key-file": { type: "string", default: "/bootstrap/sponsor" },
} });
if (!/^[0-9]{1,4}(?:\.[0-9]{1,4})?$/.test(reserve)) throw new Error("Use a reserve between 1 and 1000 Testnet NEAR");
const providerFunding = nearToYocto(reserve);
if (providerFunding < nearToYocto("1") || providerFunding > BigInt(testnetDemo.allocation)) throw new Error("Use a reserve between 1 and 1000 Testnet NEAR");
const sponsor = process.env.SLA_DEMO_SPONSOR;
const archiveSponsors = ["sla-sentinel-1794396951.testnet", "sla-v2-c8d8fcf53ff5.testnet"];
if (!isTestnetAccount(sponsor) || sponsor.length > 47 || archiveSponsors.some(id => sponsor === id || sponsor.endsWith("." + id))) {
  throw new Error("Set SLA_DEMO_SPONSOR to a new dedicated Testnet account");
}
const url = process.env.SLA_DEMO_RPC ?? defaultTestnetRpc;
const rpc = nearRpc(url, "testnet", undefined, testnetDemo.genesis);
const api = new JsonRpcProvider({ url }, { retries: 1 });
await rpc.checkNetwork();
const finality = { finality: "final" };
const funding = { contract: "2.5", provider: reserve, customer: "0.4", "oracle-a": "0.4", "oracle-b": "0.4", "oracle-c": "0.4" };
const accounts = Object.fromEntries(Object.keys(funding).map(role => [
  role, (role === "contract" ? "escrow" : role) + "." + sponsor,
]));
const contract = accounts.contract;
const actorSpecs = [
  { id: "contract", file: "/contract-admin/key", methods: [] },
  { id: "provider", file: "/runner-keys/provider", methods: [] },
  { id: "customer", file: "/runner-keys/customer", methods: ["accept_sla", "claim"] },
  ...demoRoles.map(id => ({ id, file: "/states/" + id + "/vote", methods: ["submit_vote"] })),
];
const current = new Map();
const nonexistent = [];
for (const actor of actorSpecs) {
  try { current.set(actor.id, await api.viewAccount({ accountId: accounts[actor.id], blockQuery: finality })); }
  catch (error) {
    if (!(error instanceof AccountDoesNotExistError)) throw error;
    nonexistent.push(actor.id);
  }
}
const sponsorAccount = await api.viewAccount({ accountId: sponsor, blockQuery: finality });
const available = BigInt(sponsorAccount.amount) - BigInt(sponsorAccount.storage_usage) * nearToYocto("0.00001");
const needed = nonexistent.reduce((sum, role) => sum + nearToYocto(funding[role]), nearToYocto("0.2"));
const existingProvider = current.get("provider");
const providerBalance = existingProvider ? yoctoToNear(BigInt(existingProvider.amount)) : null;
console.log(JSON.stringify({
  network: "testnet", sponsor, contract, provider_reserve_near: reserve, available_near: yoctoToNear(available > 0n ? available : 0n),
  provider: accounts.provider, existing_provider_balance_near: providerBalance,
  required_near: yoctoToNear(needed), sufficient: available >= needed, accounts_to_create: nonexistent,
}, null, 2));
if (submit) {
  assert.ok(available >= needed, "Fund the dedicated sponsor before provisioning");
  const release = lockWorker("/contract-admin");
  try { await provision(); }
  finally { release(); }
}

async function provision() {
  const bootstrap = KeyPairSigner.fromSecretKey((await readWorkerFile(keyPath, 256)).toString("utf8").trim());
  const root = new Account(sponsor, api, bootstrap);
  const { permission } = await api.viewAccessKey({
    accountId: sponsor, publicKey: await bootstrap.getPublicKey(), finalityQuery: finality,
  });
  assert.equal(permission, "FullAccess", "Use the dedicated sponsor's provisioning key");
  const artifact = checkPilotWasm(await readFile("/app/sla_escrow_v2.wasm"));
  assert.equal(artifact.codeHash, testnetDemo.codeHash, "Build the pinned, reviewed escrow artifact");
  async function actorKey(file, id) {
    try { return KeyPair.fromString((await readWorkerFile(file, 256)).toString("utf8").trim()); }
    catch (error) {
      if (!fileError(error, "ENOENT")) throw error;
      if (current.has(id)) throw new Error("Restore the existing key for " + id);
      const key = KeyPair.fromRandom("ed25519");
      await writePrivateFile(file, key.toString());
      return key;
    }
  }
  for (const { id, file, methods } of actorSpecs) {
    const accountId = accounts[id];
    const publicKey = (await actorKey(file, id)).getPublicKey();
    if (!current.has(id)) {
      const access = methods.length ? actions.addFunctionCallAccessKey(publicKey, contract, methods, nearToYocto("0.25"))
        : actions.addFullAccessKey(publicKey);
      await root.signAndSendTransaction({
        receiverId: accountId, waitUntil: "FINAL", retries: 0,
        actions: [actions.createAccount(), actions.transfer(nearToYocto(funding[id])), access],
      });
      console.log("Provisioned " + accountId);
    }
    const { permission: actual } = await api.viewAccessKey({ accountId, publicKey, finalityQuery: finality });
    if (demoRoles.includes(id)) assert.ok(scopedVotePermission(actual, contract), "Unexpected oracle access key permissions");
    else if (id === "customer") {
      const call = actual.FunctionCall;
      assert.ok(call?.receiver_id === contract && call.allowance && BigInt(call.allowance) > 0n
        && call.method_names.length === methods.length && methods.every(method => call.method_names.includes(method)));
    } else assert.equal(actual, "FullAccess");
  }
  const deployed = await api.viewAccount({ accountId: contract, blockQuery: finality });
  if (deployed.code_hash === "1".repeat(32)) {
    const admin = new Account(contract, api, KeyPairSigner.fromSecretKey((await readWorkerFile("/contract-admin/key", 256)).toString("utf8")));
    await admin.signAndSendTransaction({
      receiverId: contract, waitUntil: "FINAL", retries: 0,
      actions: [actions.deployContract(artifact.wasm), actions.functionCall("new", {}, teraToGas("40"), 0n)],
    });
  }
  assert.equal((await api.viewAccount({ accountId: contract, blockQuery: finality })).code_hash, artifact.codeHash);
  await api.callFunction({ contractId: contract, method: "agreement_count", args: {}, blockQuery: finality });
  await writePrivateFile("/registry/deployment.json", JSON.stringify({ contract, accounts }), "replace");
  console.log("Dedicated Testnet escrow ready " + contract);
}
