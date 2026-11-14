import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { isSandboxNetwork } from "../../shared/oracle-protocol.ts";
import { checkPilotWasm, runSettlementPilot } from "../src/demo/settlement-pilot.ts";

const { values: { rpc, "sandbox-home": home, wasm } } = parseArgs({ options: {
  rpc: { type: "string" },
  "sandbox-home": { type: "string" },
  wasm: { type: "string" },
} });
if (!rpc || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(rpc) || !home || !wasm) {
  throw new Error("Provide --rpc http://127.0.0.1:<port>, --sandbox-home, and --wasm");
}
const provider = new JsonRpcProvider({ url: rpc }, { retries: 2 });
const network = await provider.getNetworkId();
assert.ok(isSandboxNetwork(network), "Expected a disposable local NEAR Sandbox");
const artifact = checkPilotWasm(await readFile(wasm));
assert.throws(() => checkPilotWasm(artifact.wasm, "0".repeat(64)), /Wasm SHA-256 mismatch/);
const key = JSON.parse(await readFile(join(home, "validator_key.json"), "utf8")) as {
  account_id: string; secret_key: KeyPairString;
};
const result = await runSettlementPilot({
  artifact, root: new Account(key.account_id, provider, KeyPairSigner.fromSecretKey(key.secret_key)),
  provider, receiptProvider: provider, network, startDelayMs: 15_000, slotMs: 3_000,
  progress: (message) => console.error(message),
});
assert.deepEqual(result.results.map(({ agreement, verdict, kind, duplicate_claim_rejected }) => [
  agreement.oracles.length, agreement.down_quorum, verdict.outcome, kind, duplicate_claim_rejected,
]), [
  [3, 2, "breach", "compensation", true],
  [5, 3, "inconclusive", "refund", true],
  [7, 5, "breach", "compensation", true],
]);
console.log(JSON.stringify(result, null, 2));
