import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { actions, baseEncode, createTransaction, KeyPair, KeyPairSigner } from "near-api-js";
import { walletRoutes } from "../src/wallet-routes.mjs";
import { signEscrow, toYocto } from "../public/wallet.js";

const chain = {
  network: "test-chain-sla-sentinel", genesis: "2".repeat(32), contract: "escrow.test.near", code_hash: "3".repeat(32),
  endpoint: "http://127.0.0.1:8787/health",
};
const block = { blockHash: baseEncode(new Uint8Array(32).fill(7)), time: Date.now() };
const customer = "customer.test.near";
const provider = "provider.test.near";
const args = {
  customer, oracles: ["oracle-1.test.near", "oracle-2.test.near", "oracle-3.test.near"], down_quorum: 2,
  endpoint_hash: [...createHash("sha256").update(chain.endpoint).digest()], starts_at_ms: String(block.time + 60_000),
  slot_ms: 2000, slot_count: 3, min_down_slots: 2, reporting_grace_ms: 120_000, payout: toYocto("0.1"),
};
const agreement = {
  ...args, provider, policy_version: 2, accepted: false, outcome: "undecided", payment: "unavailable",
  ends_at_ms: String(Number(args.starts_at_ms) + 6000), reporting_deadline_ms: String(Number(args.starts_at_ms) + 126_000),
  votes: args.oracles.map(() => ({ submitted: false })),
};
const key = KeyPair.fromRandom("ed25519");

function fixture() {
  const broadcasts = [];
  const rpc = {
    finalizedBlock: async () => block,
    block: async () => block,
    query: async (_block, params) => params.request_type === "view_access_key"
      ? { permission: "FullAccess", nonce: 40 }
      : { code_hash: chain.code_hash, amount: toYocto("2") },
    callAtBlock: async (_block, _contract, method) => method === "storage_deposit" ? toYocto("0.00872") : agreement,
    request: async (method, params) => {
      broadcasts.push({ method, params });
      return { result: { final_execution_status: "NONE" } };
    },
  };
  return { routes: walletRoutes(chain, rpc), broadcasts };
}

test("funding preparation quotes exact storage and enforces the immutable offer policy", async () => {
  const { routes } = fixture();
  const input = { account: provider, public_key: key.getPublicKey().toString(), method: "create_sla", args };
  const { status, value } = await routes.handle("prepare", input);
  assert.equal(status, 200);
  assert.equal(value.deposit, toYocto("0.10872"));
  assert.equal(value.storage, toYocto("0.00872"));
  assert.equal(value.nonce, "41");
  assert.equal(value.genesis, chain.genesis);
  assert.equal((await routes.handle("prepare", { ...input, args: { ...args, down_quorum: 1 } })).status, 400);
  assert.equal((await routes.handle("prepare", { ...input, args: { ...args, endpoint_hash: args.endpoint_hash.map(() => 0) } })).status, 400);
  assert.equal((await routes.handle("prepare", { ...input, args: { ...args, customer: provider } })).status, 400);
  assert.equal((await routes.handle("prepare", { ...input, method: "accept_sla", args: { sla_id: "0" } })).status, 403);
  assert.equal((await routes.handle("prepare", { ...input, account: customer, method: "accept_sla", args: { sla_id: "0" } })).status, 200);
  assert.equal((await routes.handle("prepare", { ...input, method: "claim", args: { sla_id: "0" } })).status, 409);
});

test("only one correctly signed, scoped escrow action reaches RPC", async () => {
  const { routes, broadcasts } = fixture();
  const signer = new KeyPairSigner(key);
  const gas = 80_000_000_000_000n;
  const deposit = BigInt(toYocto("0.10872"));
  async function signed(receiver, call) {
    const tx = createTransaction(provider, key.getPublicKey(), receiver, 41n, [call], new Uint8Array(32).fill(7));
    const { signedTransaction } = await signer.signTransaction(tx);
    return Buffer.from(signedTransaction.encode()).toString("base64");
  }
  const call = actions.functionCall("create_sla", args, gas, deposit);
  assert.equal((await routes.handle("send", { signed: await signed("elsewhere.test.near", call) })).status, 400);
  assert.equal((await routes.handle("send", { signed: await signed(chain.contract, actions.transfer(deposit)) })).status, 400);
  assert.equal((await routes.handle("send", { signed: await signed(chain.contract,
    actions.functionCall("create_sla", args, gas, deposit - 1n)) })).status, 400);
  const valid = await signed(chain.contract, call);
  const tampered = Buffer.from(valid, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.equal((await routes.handle("send", { signed: tampered.toString("base64") })).status, 400);
  assert.equal((await routes.handle("send", { signed: valid })).status, 200);
  assert.deepEqual(broadcasts, [{ method: "send_tx", params: { signed_tx_base64: valid, wait_until: "INCLUDED" } }]);
});

test("browser signing rejects mismatched network, signer or reviewed deposit before signing", async () => {
  const { routes } = fixture();
  const { privateKey, publicKey } = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const account = Buffer.from(raw).toString("hex");
  const wallet = { account, privateKey, public_key: "ed25519:" + baseEncode(raw), genesis: chain.genesis };
  const request = { account, public_key: wallet.public_key, method: "create_sla", args };
  const { value: prepared } = await routes.handle("prepare", request);
  const review = { wallet, chain, prepared, method: request.method, args, deposit: prepared.deposit };
  await assert.rejects(signEscrow({ ...review, prepared: { ...prepared, genesis: "wrong" } }), /differs/);
  await assert.rejects(signEscrow({ ...review, prepared: { ...prepared, signer: provider } }), /differs/);
  await assert.rejects(signEscrow({ ...review, deposit: toYocto("1") }), /differs/);
  const result = await signEscrow(review);
  assert.equal((await routes.handle("send", { signed: result.signed })).value.hash, result.hash);
  assert.equal(toYocto("0.000000000000000000000001"), "1");
  assert.throws(() => toYocto("1e-2"), /decimal/);
});
