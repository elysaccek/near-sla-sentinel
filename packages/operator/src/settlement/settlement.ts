interface Status {
  SuccessReceiptId?: string;
  SuccessValue?: string;
  Failure?: unknown;
}

interface Action {
  FunctionCall?: { method_name: string; args: string; deposit: string };
  Transfer?: { deposit: string };
}

interface Outcome {
  id: string;
  outcome: {
    executor_id: string;
    receipt_ids: string[];
    logs: string[];
    status: Status;
  };
}

interface Receipt {
  receipt_id: string;
  receiver_id: string;
  predecessor_id: string;
  receipt: {
    Action?: {
      actions: Action[];
      input_data_ids: string[];
      output_data_receivers: { data_id: string; receiver_id: string }[];
    };
  };
}

export interface TransactionTrace {
  final_execution_status: string;
  status: Status;
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: Action[] };
  transaction_outcome: Outcome;
  receipts_outcome: Outcome[];
  receipts?: Receipt[];
}

export interface SettlementState {
  policy_version: number;
  outcome: string;
  payment: string;
  attempt: number;
  customer: string;
  provider?: string;
  payout: string;
}

interface SettlementRequest {
  contract: string;
  slaId: string;
  transactionHash: string;
  kind?: "compensation" | "refund";
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function functionArgs(actions: Action[], method: string): Record<string, unknown> {
  const call = actions[0]?.FunctionCall;
  expect(actions.length === 1 && call?.method_name === method && call.deposit === "0",
    `Expected exactly one zero-deposit ${method} call`);
  return JSON.parse(Buffer.from(call.args, "base64").toString("utf8")) as Record<string, unknown>;
}

function matchesEvent(logs: string[], name: string, expected: Record<string, unknown>): boolean {
  return logs.some((log) => {
    if (!log.startsWith("EVENT_JSON:")) {
      return false;
    }
    try {
      const event = JSON.parse(log.slice("EVENT_JSON:".length));
      const payload = event.data?.[0];
      return event.standard === "sla_sentinel" && event.version === "1.0.0" && event.event === name
        && Array.isArray(event.data) && event.data.length === 1 && payload
        && Object.entries(expected).every(([key, value]) => payload[key] === value);
    } catch {
      return false;
    }
  });
}

export function verifySettlement(
  { contract, slaId, transactionHash, kind = "compensation" }: SettlementRequest,
  state: SettlementState,
  trace: TransactionTrace,
) {
  const expectedOutcome = kind === "refund"
    ? ["healthy", "inconclusive", "unaccepted"].includes(state.outcome)
    : state.outcome === "breach";
  expect(state.policy_version === 1 && expectedOutcome && state.payment === "paid",
    "Agreement is not a paid version-1 settlement of the requested kind");
  const beneficiary = kind === "refund" ? state.provider : state.customer;
  expect(beneficiary, "Missing settlement beneficiary");
  expect(Number.isInteger(state.attempt) && state.attempt > 0 && state.attempt <= 0xffff_ffff
    && /^[1-9][0-9]{0,38}$/.test(state.payout) && BigInt(state.payout) < (1n << 128n),
    "Invalid attempt or compensation in contract state");
  expect(trace.final_execution_status === "FINAL"
    && trace.status.SuccessValue === Buffer.from("true").toString("base64"),
    "Claim is not final with a successful callback");
  expect(trace.transaction.hash === transactionHash && trace.transaction_outcome.id === transactionHash
    && trace.transaction.signer_id === beneficiary && trace.transaction.receiver_id === contract,
    "Transaction does not match the expected beneficiary, contract, and hash");
  expect(functionArgs(trace.transaction.actions, "claim").sla_id === slaId, "Claim agreement ID differs");

  const outcomes = new Map(trace.receipts_outcome.map((receipt) => [receipt.id, receipt.outcome]));
  expect(trace.receipts?.length, "RPC response does not include receipt details");
  const receipts = new Map(trace.receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const claimId = trace.transaction_outcome.outcome.status.SuccessReceiptId;
  const claim = claimId && outcomes.get(claimId);
  expect(claim && claim.executor_id === contract && matchesEvent(claim.logs, "payment_pending", {
    sla_id: slaId,
    attempt: state.attempt,
    recipient: beneficiary,
    amount: state.payout,
  }), "Claim receipt is missing the matching payment attempt");
  const callbackId = claim.status.SuccessReceiptId;
  const callback = callbackId && receipts.get(callbackId);
  const callbackOutcome = callbackId && outcomes.get(callbackId);
  expect(callback && callbackOutcome && claim.receipt_ids.includes(callback.receipt_id)
    && callback.predecessor_id === contract && callback.receiver_id === contract
    && callbackOutcome.executor_id === contract && callbackOutcome.status.SuccessValue === "dHJ1ZQ==",
    "Successful callback receipt is missing or unrelated to the claim");
  const callbackAction = callback.receipt.Action;
  expect(callbackAction?.input_data_ids.length === 1, "Callback does not depend on one transfer");
  const callbackArgs = functionArgs(callbackAction.actions, "on_payment");
  expect(callbackArgs.sla_id === slaId && callbackArgs.attempt === state.attempt
    && matchesEvent(callbackOutcome.logs, "payment_succeeded", { sla_id: slaId, attempt: state.attempt }),
    "Callback did not confirm the matching payment attempt");

  const transferReceipts = claim.receipt_ids
    .map((id) => receipts.get(id))
    .filter((receipt) => receipt?.predecessor_id === contract && receipt.receiver_id === beneficiary
      && receipt.receipt.Action?.actions.some((action) => action.Transfer));
  expect(transferReceipts.length === 1, "Expected one native NEAR transfer to the beneficiary");
  const transfer = transferReceipts[0];
  const transferAction = transfer?.receipt.Action;
  expect(transfer && transferAction?.actions.length === 1
    && transferAction.actions[0].Transfer?.deposit === state.payout,
    "Native NEAR transfer amount differs");
  const transferOutcome = outcomes.get(transfer.receipt_id);
  expect(transferOutcome?.executor_id === beneficiary && transferOutcome.status.SuccessValue === "",
    "Native NEAR transfer did not succeed");
  expect(transferAction.output_data_receivers.some(({ data_id, receiver_id }) =>
    receiver_id === contract && data_id === callbackAction.input_data_ids[0]),
    "Callback is not linked to this transfer");

  return {
    sla_id: slaId,
    transaction_hash: transactionHash,
    customer: state.customer,
    ...(kind === "refund" ? { beneficiary } : {}),
    amount_yoctonear: state.payout,
    attempt: state.attempt,
    transfer_receipt_id: transfer.receipt_id,
    callback_receipt_id: callback.receipt_id,
  };
}
