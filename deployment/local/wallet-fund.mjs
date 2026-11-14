import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Account, actions, JsonRpcProvider, KeyPairSigner, nearToYocto } from "near-api-js";
import { isBase58Hash } from "../../shared/oracle-protocol.ts";

const { positionals: [accountId, ...rest], values: { genesis } } = parseArgs({
  allowPositionals: true, options: { genesis: { type: "string" } },
});
if (!/^[0-9a-f]{64}$/.test(accountId ?? "") || rest.length || (genesis !== undefined && !isBase58Hash(genesis))) {
  throw new Error("Usage: node local/wallet-fund.mjs IMPLICIT_SANDBOX_ACCOUNT_ID [--genesis SANDBOX_GENESIS]");
}
const rpc = new JsonRpcProvider({ url: "http://127.0.0.1:34831" }, { retries: 2 });
const status = await rpc.viewNodeStatus();
assert.equal(status.chain_id, "test-chain-sla-sentinel");
assert.equal(status.genesis_hash, (await readFile("/escrow/genesis-hash", "utf8")).trim());
if (genesis !== undefined && genesis !== status.genesis_hash) {
  throw new Error("This wallet funding command belongs to a different Sandbox chain");
}
const { account_id: sponsor, secret_key: sponsorKey } = JSON.parse(await readFile("/chain/validator_key.json", "utf8"));
assert.equal(sponsor, "test.near");
const root = new Account(sponsor, rpc, KeyPairSigner.fromSecretKey(sponsorKey));
const result = await root.signAndSendTransaction({
  receiverId: accountId, actions: [actions.transfer(nearToYocto("2"))], waitUntil: "FINAL", retries: 0,
});
console.log("Funded " + accountId + " with 2 Sandbox NEAR · " + result.transaction_outcome.id);
