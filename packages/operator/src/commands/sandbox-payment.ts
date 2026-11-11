import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPairSigner, nearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { runPaymentDemo } from "../demo/payment-demo.ts";

async function main() {
  const { values } = parseArgs({ options: {
    rpc: { type: "string" },
    "sandbox-home": { type: "string" },
    wasm: { type: "string" },
    measure: { type: "boolean" },
    scenario: { type: "string", default: "breach" },
  } });
  const { rpc, "sandbox-home": sandboxHome, wasm: wasmPath } = values;
  if (!rpc || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(rpc) || !sandboxHome || !wasmPath) {
    throw new Error("Provide --rpc http://127.0.0.1:<port>, --sandbox-home, and --wasm");
  }
  if (values.scenario !== "breach" && values.scenario !== "inconclusive") {
    throw new Error("Use --scenario breach or --scenario inconclusive");
  }
  if (values.scenario === "inconclusive" && values.measure) {
    throw new Error("The inconclusive scenario uses scripted observations. Omit --measure");
  }
  const wasm = await readFile(wasmPath);
  const provider = new JsonRpcProvider({ url: rpc }, { retries: 2 });
  const network = await provider.getNetworkId();
  assert.match(network, /^test-chain-/, "Expected an isolated NEAR Sandbox chain");
  const key = JSON.parse(await readFile(join(sandboxHome, "validator_key.json"), "utf8")) as {
    account_id: string;
    secret_key: KeyPairString;
  };
  const root = new Account(key.account_id, provider, KeyPairSigner.fromSecretKey(key.secret_key));
  const result = await runPaymentDemo({
    provider, receiptProvider: provider, root, network, wasm, measure: values.measure ?? false,
    scenario: values.scenario,
    escrowFunding: nearToYocto("50"), actorFunding: nearToYocto("10"),
    startDelayMs: 15_000, slotMs: values.measure ? 3_000 : 1_000, reportingGraceMs: 120_000,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Sandbox payment check failed");
  process.exitCode = 1;
});
