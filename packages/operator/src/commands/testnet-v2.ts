import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPairSigner, nearToYocto, yoctoToNear } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { defaultTestnetRpc } from "../../../shared/near-rpc.ts";
import { isTestnetAccount } from "../../../shared/oracle-protocol.ts";
import { checkPilotWasm, pilotAllocation, pilotMinimumFunding, runSettlementPilot } from "../demo/settlement-pilot.ts";
import { readWorkerFile } from "../worker/identity.ts";

const wasmPath = "../../contracts/sla-escrow-v2/target/wasm32-unknown-unknown/release/sla_escrow_v2.wasm";
const v1Sponsor = "sla-sentinel-1794396951.testnet";

async function sponsorAccount(provider: JsonRpcProvider, accountId: string) {
  const deadline = Date.now() + 25_000;
  while (true) {
    try {
      return await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
    } catch (error) {
      if (!(error instanceof AccountDoesNotExistError) || Date.now() >= deadline) throw error;
      await sleep(1_000);
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    sponsor: { type: "string" },
    wasm: { type: "string", default: wasmPath },
    "wasm-sha256": { type: "string" },
    "sponsor-key-file": { type: "string" },
    submit: { type: "boolean" },
  } });
  const { sponsor, "sponsor-key-file": keyFile, "wasm-sha256": expectedSha256, submit } = values;
  if (!sponsor || !isTestnetAccount(sponsor) || sponsor.length > 41) {
    throw new Error("Provide --sponsor with a disposable Testnet account of at most 41 characters");
  }
  if (sponsor === v1Sponsor || sponsor.endsWith("." + v1Sponsor)) {
    throw new Error("Create a new Testnet sponsor outside the archived V1 account tree");
  }
  if (submit && (!keyFile || !expectedSha256)) {
    throw new Error("--submit requires --sponsor-key-file and the reviewed --wasm-sha256");
  }
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("Use the artifact's lowercase hexadecimal SHA-256");
  }
  const artifact = checkPilotWasm(await readFile(values.wasm), expectedSha256);
  const provider = new JsonRpcProvider({ url: defaultTestnetRpc }, { retries: 2 });
  const receiptProvider = new JsonRpcProvider({ url: "https://archival-rpc.testnet.near.org" }, { retries: 2 });
  const [primary, archive] = await Promise.all([provider.viewNodeStatus(), receiptProvider.viewNodeStatus()]);
  assert.equal(primary.chain_id, "testnet");
  assert.equal(archive.chain_id, "testnet");
  assert.equal(primary.genesis_hash, archive.genesis_hash, "The Testnet RPC endpoints disagree on genesis");
  const account = await sponsorAccount(provider, sponsor);
  const storage = BigInt(account.storage_usage) * nearToYocto("0.00001");
  const balance = BigInt(account.amount);
  const spendable = balance > storage ? balance - storage : 0n;
  assert.ok(spendable >= pilotMinimumFunding,
    `Sponsor needs ${yoctoToNear(pilotMinimumFunding)} spendable Testnet NEAR. Found ${yoctoToNear(spendable)}.`);
  if (!submit) {
    console.log(JSON.stringify({
      network: primary.chain_id, sponsor, spendable_near: yoctoToNear(spendable),
      allocation_near: yoctoToNear(pilotAllocation), wasm_bytes: artifact.wasm.byteLength, wasm_sha256: artifact.sha256,
      code_hash: artifact.codeHash,
    }, null, 2));
    return;
  }

  let signer: KeyPairSigner;
  try {
    const key = (await readWorkerFile(keyFile!, 256)).toString("utf8").trim();
    if (!key.startsWith("ed25519:")) throw new Error("Expected an ED25519 key");
    signer = KeyPairSigner.fromSecretKey(key as KeyPairString);
  } catch {
    throw new Error("Provide the disposable sponsor's ED25519 key in an owner-only file");
  }
  const { permission } = await provider.viewAccessKey({
    accountId: sponsor, publicKey: await signer.getPublicKey(), finalityQuery: { finality: "final" },
  });
  assert.equal(permission, "FullAccess", "The disposable sponsor needs a key authorized to create subaccounts");
  const result = await runSettlementPilot({
    artifact, root: new Account(sponsor, provider, signer), provider, receiptProvider, network: primary.chain_id,
    startDelayMs: 45_000, slotMs: 3_000, progress: (message) => console.error(message),
  });
  console.log(JSON.stringify({
    ...result,
    results: result.results.map((proof) => ({
      ...proof, explorer_url: `https://testnet.nearblocks.io/txns/${proof.transaction_hash}`,
    })),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V2 Testnet pilot failed");
  process.exitCode = 1;
});
