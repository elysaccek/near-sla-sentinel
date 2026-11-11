import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { JsonRpcProvider, KeyPair, SignedTransaction, teraToGas } from "near-api-js";
import { prepareVoteSender } from "../src/oracles/oracle-signer.ts";

const contract = "escrow.example.testnet";
const oracle = "oracle-a.example.testnet";
const url = "https://rpc.example.invalid";
const scopedKey = {
  FunctionCall: { allowance: "1000000000000000000000", receiver_id: contract, method_names: ["submit_vote"] },
};
const vote = { sla_id: "7", up_mask: "17", down_mask: "14", evidence_hash: Array<number>(32).fill(1) };

test("the SDK signs exactly one zero-deposit vote for the expected contract", async (t) => {
  const key = KeyPair.fromRandom("ed25519");
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (endpoint: string, options: RequestInit) => {
    assert.equal(endpoint, url);
    const request = JSON.parse(String(options.body));
    requests.push(request.method);
    let result: object;
    switch (request.method) {
      case "query":
        assert.equal(request.params.request_type, "view_access_key");
        assert.equal(request.params.account_id, oracle);
        assert.equal(request.params.public_key, key.getPublicKey().toString());
        if (requests.length === 1) assert.equal(request.params.finality, "final");
        result = { nonce: 42, permission: scopedKey };
        break;
      case "block":
        assert.equal(request.params.finality, "final");
        result = { header: { hash: "1".repeat(32) } };
        break;
      case "send_tx": {
        assert.equal(request.params.wait_until, "FINAL");
        const signed = SignedTransaction.decode(Buffer.from(request.params.signed_tx_base64, "base64"));
        const tx = signed.transaction;
        assert.equal(tx.signerId, oracle);
        assert.equal(tx.receiverId, contract);
        assert.equal(tx.publicKey.toString(), key.getPublicKey().toString());
        assert.equal(tx.actions.length, 1);
        const call = tx.actions[0].functionCall;
        assert.ok(call);
        assert.equal(call.methodName, "submit_vote");
        assert.equal(call.deposit, 0n);
        assert.equal(call.gas, teraToGas("30"));
        assert.deepEqual(JSON.parse(Buffer.from(call.args).toString("utf8")), vote);
        const digest = createHash("sha256").update(tx.encode()).digest();
        assert.ok(tx.publicKey.verify(digest, signed.signature.data));
        result = { final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction_outcome: { id: "fixture-hash" } };
        break;
      }
      default:
        assert.fail(`Unexpected RPC method ${request.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });

  const send = await prepareVoteSender(new JsonRpcProvider({ url }, { retries: 1 }), contract, oracle, key.toString());
  assert.equal(await send(vote), "fixture-hash");
  assert.deepEqual(requests.sort(), ["block", "query", "query", "send_tx"]);
});

test("rejects full-access, wrong-receiver, broad, and unlimited oracle keys before sending", async (t) => {
  const key = KeyPair.fromRandom("ed25519");
  const { FunctionCall: access } = scopedKey;
  const permissions = [
    "FullAccess",
    { FunctionCall: { ...access, receiver_id: "another.testnet" } },
    { FunctionCall: { ...access, method_names: [] } },
    { FunctionCall: { ...access, method_names: ["submit_vote", "claim"] } },
    { FunctionCall: { ...access, allowance: null } },
    { FunctionCall: { ...access, allowance: "0" } },
  ];
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    assert.equal(request.method, "query");
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { nonce: 42, permission: permissions.shift() } });
  });
  const provider = new JsonRpcProvider({ url }, { retries: 1 });
  await assert.rejects(prepareVoteSender(provider, contract, oracle, "ed25519:invalid"), /dedicated oracle key/);
  assert.equal(fetch.mock.callCount(), 0);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await assert.rejects(prepareVoteSender(provider, contract, oracle, key.toString()), /only permit submit_vote|scoped to submit_vote/);
  }
  assert.equal(fetch.mock.callCount(), 6);
});
