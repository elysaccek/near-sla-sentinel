import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPairSigner, nearToYocto, yoctoToNear } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { runPaymentDemo } from "../demo/payment-demo.ts";

const MINIMUM_FUNDING = nearToYocto("6");
const WASM_PATH = "../../contracts/sla-escrow/target/wasm32-unknown-unknown/release/sla_escrow.wasm";

async function waitForSponsor(provider: JsonRpcProvider, accountId: string) {
  const deadline = Date.now() + 20_000;
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
    wasm: { type: "string", default: WASM_PATH },
    submit: { type: "boolean" },
  } });
  const sponsor = values.sponsor;
  if (!sponsor || sponsor.length > 46 || !/^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$/.test(sponsor)) {
    throw new Error("Provide --sponsor with a named Testnet account of at most 46 characters");
  }
  const wasm = await readFile(values.wasm);
  assert.ok(WebAssembly.validate(wasm), "Expected a valid Wasm module");
  assert.ok(wasm.byteLength <= 250_000, "Wasm exceeds the Testnet demo's deployment storage budget");

  const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }, { retries: 2 });
  const network = await provider.getNetworkId();
  assert.equal(network, "testnet");
  const account = await waitForSponsor(provider, sponsor);
  const balance = BigInt(account.amount);
  const storage = BigInt(account.storage_usage) * nearToYocto("0.00001");
  const spendable = balance > storage ? balance - storage : 0n;
  assert.ok(spendable >= MINIMUM_FUNDING, `Sponsor needs 6 spendable Testnet NEAR. Found ${yoctoToNear(spendable)}.`);
  if (!values.submit) {
    console.log(JSON.stringify({ network, sponsor, spendable_near: yoctoToNear(spendable), wasm_bytes: wasm.byteLength }));
    return;
  }

  const receiptProvider = new JsonRpcProvider({ url: "https://archival-rpc.testnet.near.org" }, { retries: 2 });
  assert.equal(await receiptProvider.getNetworkId(), "testnet");
  let signer: KeyPairSigner;
  try {
    const key = process.env.SLA_TESTNET_SPONSOR_KEY;
    if (!key?.startsWith("ed25519:")) throw new Error();
    signer = KeyPairSigner.fromSecretKey(key as KeyPairString);
  } catch {
    throw new Error("Set SLA_TESTNET_SPONSOR_KEY locally to the disposable Testnet sponsor's ED25519 key");
  }
  const { permission } = await provider.viewAccessKey({
    accountId: sponsor, publicKey: await signer.getPublicKey(), finalityQuery: { finality: "final" },
  });
  assert.equal(permission, "FullAccess", "The disposable Testnet sponsor must be able to create subaccounts");
  const root = new Account(sponsor, provider, signer);
  const result = await runPaymentDemo({
    provider, receiptProvider, root, network, wasm, measure: true,
    escrowFunding: nearToYocto("4"), actorFunding: nearToYocto("0.25"),
    startDelayMs: 45_000, slotMs: 3_000, reportingGraceMs: 180_000,
    onAccount: (role, id) => console.error(`${role}: ${id}`),
    onClaim: (hash) => console.error(`Claim: https://testnet.nearblocks.io/txns/${hash}`),
  });
  console.log(JSON.stringify({ ...result, explorer_url: `https://testnet.nearblocks.io/txns/${result.transaction_hash}` }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Testnet payment check failed");
  process.exitCode = 1;
});
