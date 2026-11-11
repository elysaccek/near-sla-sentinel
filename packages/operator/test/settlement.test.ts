import assert from "node:assert/strict";
import test from "node:test";
import { verifySettlement } from "../src/settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../src/settlement/settlement.ts";

const contract = "escrow.example.testnet";
const customer = "customer.example.testnet";
const slaId = "4";
const transactionHash = "claim-tx";
const amount = "100000000000000000000000";
const request = { contract, slaId, transactionHash };
const state: SettlementState = {
  policy_version: 1, outcome: "breach", payment: "paid", attempt: 2, customer, payout: amount,
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const event = (name: string, data: Record<string, unknown>) => "EVENT_JSON:" + JSON.stringify({
  standard: "sla_sentinel", version: "1.0.0", event: name, data: [data],
});

function trace(): TransactionTrace {
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: encode(true) },
    transaction: {
      hash: transactionHash, signer_id: customer, receiver_id: contract,
      actions: [{ FunctionCall: { method_name: "claim", args: encode({ sla_id: slaId }), deposit: "0" } }],
    },
    transaction_outcome: {
      id: transactionHash,
      outcome: { executor_id: customer, logs: [], receipt_ids: ["claim"], status: { SuccessReceiptId: "claim" } },
    },
    receipts_outcome: [
      {
        id: "claim",
        outcome: {
          executor_id: contract,
          receipt_ids: ["transfer", "callback", "gas-refund"],
          logs: [event("payment_pending", { sla_id: slaId, attempt: 2, recipient: customer, amount })],
          status: { SuccessReceiptId: "callback" },
        },
      },
      {
        id: "transfer",
        outcome: { executor_id: customer, receipt_ids: [], logs: [], status: { SuccessValue: "" } },
      },
      {
        id: "callback",
        outcome: {
          executor_id: contract, receipt_ids: [], status: { SuccessValue: encode(true) },
          logs: [event("payment_succeeded", { sla_id: slaId, attempt: 2 })],
        },
      },
      {
        id: "gas-refund",
        outcome: { executor_id: customer, receipt_ids: [], logs: [], status: { SuccessValue: "" } },
      },
    ],
    receipts: [
      {
        receipt_id: "transfer", receiver_id: customer, predecessor_id: contract,
        receipt: { Action: {
          actions: [{ Transfer: { deposit: amount } }], input_data_ids: [],
          output_data_receivers: [{ receiver_id: contract, data_id: "transfer-result" }],
        } },
      },
      {
        receipt_id: "callback", receiver_id: contract, predecessor_id: contract,
        receipt: { Action: {
          actions: [{ FunctionCall: { method_name: "on_payment", args: encode({ sla_id: slaId, attempt: 2 }), deposit: "0" } }],
          input_data_ids: ["transfer-result"], output_data_receivers: [],
        } },
      },
      {
        receipt_id: "gas-refund", receiver_id: customer, predecessor_id: "system",
        receipt: { Action: {
          actions: [{ Transfer: { deposit: "100" } }], input_data_ids: [], output_data_receivers: [],
        } },
      },
    ],
  };
}

test("binds one native transfer and its callback to the recorded agreement attempt", () => {
  assert.deepEqual(verifySettlement(request, state, trace()), {
    sla_id: slaId, transaction_hash: transactionHash, customer, amount_yoctonear: amount,
    attempt: 2, transfer_receipt_id: "transfer", callback_receipt_id: "callback",
  });
});

test("verifies an inconclusive refund to the provider and rejects it as customer compensation", () => {
  const provider = "provider.example.testnet";
  const refundState = { ...state, outcome: "inconclusive", provider };
  const refund = trace();
  refund.transaction.signer_id = provider;
  refund.receipts_outcome[0].outcome.logs = [event("payment_pending", {
    sla_id: slaId, attempt: 2, recipient: provider, amount,
  })];
  refund.receipts_outcome[1].outcome.executor_id = provider;
  refund.receipts![0].receiver_id = provider;
  assert.equal(verifySettlement({ ...request, kind: "refund" }, refundState, refund).beneficiary, provider);
  assert.throws(() => verifySettlement(request, refundState, refund), /requested kind/);
  assert.throws(() => verifySettlement({ ...request, kind: "refund" }, refundState, trace()), /expected beneficiary/);
});

test("rejects pending, optimistic, and incomplete receipts", () => {
  assert.throws(() => verifySettlement(request, { ...state, payment: "pending" }, trace()), /not a paid/);
  assert.throws(() => verifySettlement(request, state, { ...trace(), final_execution_status: "EXECUTED_OPTIMISTIC" }), /not final/);
  assert.throws(() => verifySettlement(request, state, { ...trace(), receipts: [] }), /does not include receipt/);
});

test("rejects a wrong recipient, amount, and second native transfer", () => {
  const wrongRecipient = trace();
  wrongRecipient.receipts![0].receiver_id = "another.testnet";
  assert.throws(() => verifySettlement(request, state, wrongRecipient), /Expected one native/);

  const wrongAmount = trace();
  wrongAmount.receipts![0].receipt.Action!.actions[0].Transfer!.deposit = "1";
  assert.throws(() => verifySettlement(request, state, wrongAmount), /amount differs/);

  const duplicate = trace();
  duplicate.receipts![2].predecessor_id = contract;
  assert.throws(() => verifySettlement(request, state, duplicate), /Expected one native/);
});

test("rejects a failed transfer or a callback from a different promise result", () => {
  const failed = trace();
  failed.receipts_outcome[1].outcome.status = { Failure: {} };
  assert.throws(() => verifySettlement(request, state, failed), /transfer did not succeed/);

  const different = trace();
  different.receipts![1].receipt.Action!.input_data_ids = ["different-result"];
  assert.throws(() => verifySettlement(request, state, different), /not linked to this transfer/);
});

test("rejects a stale or failed callback and a transaction for another agreement", () => {
  const failed = trace();
  failed.receipts_outcome[2].outcome.status = { Failure: {} };
  assert.throws(() => verifySettlement(request, state, failed), /callback receipt is missing/);

  const stale = trace();
  stale.receipts_outcome[2].outcome.logs = [event("payment_succeeded", { sla_id: slaId, attempt: 1 })];
  assert.throws(() => verifySettlement(request, state, stale), /matching payment attempt/);
  assert.throws(() => verifySettlement({ ...request, slaId: "5" }, state, trace()), /agreement ID differs/);
});
