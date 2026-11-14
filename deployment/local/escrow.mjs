import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Account, actions, baseEncode, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { scopedVotePermission } from "../../shared/near-rpc.ts";
import { loopbackHealth } from "../../shared/oracle-protocol.ts";
import { ensureFile } from "./files.mjs";

const network = "test-chain-sla-sentinel";
const contract = "escrow.test.near";
const rpc = new JsonRpcProvider({ url: "http://127.0.0.1:34831" }, { retries: 2 });
const finality = { finality: "final" };
assert.equal(await rpc.getNetworkId(), network);
const { genesis_hash: genesisHash } = await rpc.viewNodeStatus();
const validator = JSON.parse(await readFile("/chain/validator_key.json", "utf8"));
assert.equal(validator.account_id, "test.near");
const root = new Account(validator.account_id, rpc, KeyPairSigner.fromSecretKey(validator.secret_key));
const wasm = await readFile("/app/sla_escrow_v2.wasm");
const codeHash = baseEncode(createHash("sha256").update(wasm).digest());

async function state(accountId) {
  try { return await rpc.viewAccount({ accountId, blockQuery: finality }); }
  catch (error) {
    if (!(error instanceof AccountDoesNotExistError)) throw error;
    return null;
  }
}

async function create(accountId, funding, extraActions) {
  await root.signAndSendTransaction({
    receiverId: accountId, waitUntil: "FINAL", retries: 0,
    actions: [actions.createAccount(), actions.transfer(nearToYocto(funding)), ...extraActions],
  });
}

if (!await state(contract)) {
  await create(contract, "4", [actions.deployContract(wasm), actions.functionCall("new", {}, teraToGas("50"), 0n)]);
}
assert.equal((await state(contract))?.code_hash, codeHash,
  "This Sandbox already uses a different escrow build. Start another Compose project for the new build.");
const count = await rpc.callFunction({ contractId: contract, method: "agreement_count", args: {}, blockQuery: finality });
assert.match(count, /^(0|[1-9][0-9]*)$/);

for (let i = 1; i <= 3; i++) {
  const role = `oracle-${i}`;
  const accountId = `${role}.test.near`;
  const key = KeyPair.fromString((await ensureFile(`/${role}/vote-key`, KeyPair.fromRandom("ed25519").toString())).toString());
  const publicKey = key.getPublicKey();
  if (!await state(accountId)) {
    await create(accountId, "0.3", [
      actions.addFunctionCallAccessKey(publicKey, contract, ["submit_vote"], nearToYocto("0.25")),
    ]);
  }
  const { permission } = await rpc.viewAccessKey({ accountId, publicKey, finalityQuery: finality });
  assert.ok(scopedVotePermission(permission, contract), `Invalid vote key for ${accountId}`);
}
const deployment = { network, contract, code_hash: codeHash, endpoint: loopbackHealth };
const saved = await ensureFile("/escrow/deployment.json", JSON.stringify(deployment));
assert.deepEqual(JSON.parse(saved.toString("utf8")), deployment);
assert.equal((await ensureFile("/escrow/genesis-hash", genesisHash)).toString("utf8"), genesisHash,
  "The saved escrow identity belongs to a different Sandbox genesis");
console.log(`Verified local escrow ${contract} on ${network}`);
