import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonRpcProvider, KeyPair } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { boundedJson } from "../../shared/http-json.ts";
import { defaultTestnetRpc, nearRpc } from "../../shared/near-rpc.ts";
import { isTestnetAccount } from "../../shared/oracle-protocol.ts";
import { demoRoles, testnetDemo } from "../../shared/testnet-demo.ts";
import { checkPilotWasm } from "../src/demo/settlement-pilot.ts";
import { fileError, readWorkerFile, writePrivateFile } from "../src/worker/identity.ts";

const reviewedEscrow = "escrow.sla-live-92f68ba3.testnet";
const reviewedSha256 = "db80cd866ac62d18a15070ce0974dc299e4d2b04065d6ac276e713dc90e27e74";
const finality = { finality: "final" };

async function installedContract() {
  const saved = await readWorkerFile("/registry/deployment.json", 8192).catch(error => {
    if (!fileError(error, "ENOENT")) throw error;
  });
  if (saved === undefined) return;
  const { contract, accounts } = JSON.parse(saved.toString("utf8"));
  const roster = [contract, accounts?.provider, accounts?.customer, ...demoRoles.map(role => accounts?.[role])];
  assert.ok(accounts?.contract === contract && roster.every(isTestnetAccount)
    && new Set(roster).size === roster.length, "Invalid saved Testnet deployment");
  console.log(contract);
}

async function sponsorKey() {
  const path = "/bootstrap/sponsor";
  try { return KeyPair.fromString((await readWorkerFile(path, 256)).toString("utf8").trim()); }
  catch (error) {
    if (!fileError(error, "ENOENT")) throw error;
    const key = KeyPair.fromRandom("ed25519");
    await writePrivateFile(path, key.toString());
    return key;
  }
}

export async function reviewedWasm(url) {
  await nearRpc(url, "testnet", undefined, testnetDemo.genesis).checkNetwork();
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "reviewed-wasm", method: "query", params: {
      request_type: "view_code", finality: "final", account_id: reviewedEscrow,
    } }),
  });
  assert.ok(response.ok, "Could not download the reviewed escrow Wasm");
  const { id, result } = await boundedJson(response, 300_000);
  assert.equal(id, "reviewed-wasm");
  assert.equal(result?.hash, testnetDemo.codeHash, "Published escrow code hash differs from the reviewed release");
  const artifact = checkPilotWasm(Buffer.from(result.code_base64, "base64"), reviewedSha256);
  assert.equal(artifact.codeHash, testnetDemo.codeHash);
  return artifact;
}

async function checkSponsor(url, accountId, waitForFinality) {
  assert.ok(/^sla-vps-[0-9a-f-]{10,32}\.testnet$/.test(accountId), "Expected a dedicated Testnet sponsor ID");
  const publicKey = (await sponsorKey()).getPublicKey();
  await nearRpc(url, "testnet", undefined, testnetDemo.genesis).checkNetwork();
  const api = new JsonRpcProvider({ url }, { retries: 1 });
  for (let attempt = 0; attempt < (waitForFinality ? 12 : 1); attempt++) {
    try { await api.viewAccount({ accountId, blockQuery: finality }); }
    catch (error) {
      if (!(error instanceof AccountDoesNotExistError)) throw error;
      if (!waitForFinality) {
        console.log(publicKey.toString());
        return;
      }
      await sleep(2500);
      continue;
    }
    const { permission } = await api.viewAccessKey({ accountId, publicKey, finalityQuery: finality });
    assert.equal(permission, "FullAccess", "Sponsor account does not have the saved bootstrap key");
    return;
  }
  throw new Error("Sponsor is not visible at Testnet finality. Check the faucet result and rerun the installer.");
}

if (import.meta.main) {
  const [command, sponsor] = process.argv.slice(2);
  const url = process.env.SLA_DEMO_RPC ?? defaultTestnetRpc;
  switch (command) {
    case "installed": await installedContract(); break;
    case "wasm": process.stdout.write((await reviewedWasm(url)).wasm); break;
    case "sponsor": await checkSponsor(url, sponsor, false); break;
    case "confirm-sponsor": await checkSponsor(url, sponsor, true); break;
    default: throw new Error("Unknown Testnet bootstrap command");
  }
}
