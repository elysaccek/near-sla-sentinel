import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { assessQuorumWindow } from "../src/monitoring/evidence.ts";
import type { ContractVote } from "../src/monitoring/evidence.ts";
import { prepareVoteSender } from "../src/oracles/oracle-signer.ts";
import { verifySettlement } from "../src/settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../src/settlement/settlement.ts";

type Vote = Omit<ContractVote, "sla_id"> & { submitted: boolean };
type Agreement = SettlementState & {
  oracles: string[];
  down_quorum: number;
  accepted: boolean;
  slot_count: number;
  min_down_slots: number;
  confirmed_down_slots: number;
  possible_down_slots: number;
  starts_at_ms: string;
  ends_at_ms: string;
  reporting_deadline_ms: string;
  votes: Vote[];
};

const payout = nearToYocto("0.1");
const fullMask = (1n << 64n) - 1n;
const oddSlots = BigInt("0xaaaaaaaaaaaaaaaa");
const evenSlots = fullMask ^ oddSlots;
const vote = (down: number | bigint, up: number | bigint = 0) => ({
  down_mask: String(down), up_mask: String(up),
});

async function main() {
  const { values } = parseArgs({ options: {
    rpc: { type: "string" }, "sandbox-home": { type: "string" }, wasm: { type: "string" },
    "missing-recipient-wasm": { type: "string" },
  } });
  const { rpc, "sandbox-home": sandboxHome, wasm: wasmPath, "missing-recipient-wasm": missingRecipientPath } = values;
  if (!rpc || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(rpc)
      || !sandboxHome || !wasmPath || !missingRecipientPath) {
    throw new Error("Provide --rpc http://127.0.0.1:<port>, --sandbox-home, --wasm, and --missing-recipient-wasm");
  }
  const provider = new JsonRpcProvider({ url: rpc }, { retries: 2 });
  const network = await provider.getNetworkId();
  assert.match(network, /^test-chain-/, "Expected an isolated NEAR Sandbox chain");
  const wasm = await readFile(wasmPath);
  assert.ok(WebAssembly.validate(wasm), "Expected a valid Wasm module");
  const fixtureWasm = await readFile(missingRecipientPath);
  assert.ok(WebAssembly.validate(fixtureWasm), "Expected a valid Sandbox fixture");
  const exportNames = (code: typeof wasm) => WebAssembly.Module.exports(new WebAssembly.Module(code))
    .map(({ name }) => name);
  const releaseExports = exportNames(wasm);
  const fixtureExports = exportNames(fixtureWasm);
  for (const method of ["schedule_missing_recipient", "schedule_unresolved_payment"]) {
    assert.ok(!releaseExports.includes(method), "Build the escrow artifact with default features");
    assert.ok(fixtureExports.includes(method), "Build the fixture with the sandbox-fixture feature");
  }
  const key = JSON.parse(await readFile(join(sandboxHome, "validator_key.json"), "utf8")) as {
    account_id: string; secret_key: KeyPairString;
  };
  const root = new Account(key.account_id, provider, KeyPairSigner.fromSecretKey(key.secret_key));
  const prefix = randomBytes(4).toString("hex");
  async function create(role: string, funding: `${number}` = "5", maxLength = true) {
    const name = `${prefix}-${role}`;
    const accountPrefix = maxLength ? name.padEnd(63 - root.accountId.length, "x") : name;
    const actorKey = KeyPair.fromRandom("ed25519");
    await root.createSubAccount({
      accountOrPrefix: accountPrefix, publicKey: actorKey.getPublicKey(), nearToTransfer: nearToYocto(funding),
    });
    return new Account(`${accountPrefix}.${root.accountId}`, provider, new KeyPairSigner(actorKey));
  }

  const escrow = await create("escrow", "12");
  const supplier = await create("provider");
  const customer = await create("customer");
  const oracles: Account[] = [];
  for (let i = 0; i < 16; i += 1) oracles.push(await create(`o${i}-`));
  const contractId = escrow.accountId;
  await escrow.signAndSendTransaction({
    receiverId: contractId, actions: [actions.deployContract(wasm)], waitUntil: "FINAL",
  });
  const call = (
    account: Account, methodName: string, args: Record<string, unknown>, gas: `${number}` = "100", deposit = 0n,
  ) => account.callFunctionRaw({ contractId, methodName, args, waitUntil: "FINAL", gas: teraToGas(gas), deposit });
  const view = async <T extends object | string>(method: string, args: Record<string, unknown>) => {
    const result = await provider.callFunction<T>({ contractId, method, args, blockQuery: { finality: "final" } });
    assert.ok(result != null, `Missing ${method} result`);
    return result;
  };
  const read = (sla_id: string) => view<Agreement>("get_sla", { sla_id });
  const storageUsage = async () => (await provider.viewAccount({ accountId: contractId, blockQuery: { finality: "final" } })).storage_usage;
  const chainTime = async () => Number(BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec) / 1_000_000n);
  const receiptGas = (result: Awaited<ReturnType<typeof call>>, executor = contractId) => {
    const receipt = result.receipts_outcome.find(({ outcome }) => outcome.executor_id === executor);
    assert.ok(receipt, "Expected a contract execution receipt");
    return receipt.outcome.gas_burnt / 1e12;
  };
  const newSla = (offer: Record<string, unknown>, deposit: bigint) => call(supplier, "create_sla", offer, "100", deposit);
  const slaIdOf = (tx: Awaited<ReturnType<typeof newSla>>) => {
    assert.ok(typeof tx.status === "object" && "SuccessValue" in tx.status);
    const id: unknown = JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString("utf8"));
    assert.equal(typeof id, "string");
    return id as string;
  };
  await assert.rejects(view("agreement_count", {}), /not initialized/i);
  await call(escrow, "new", {});
  await assert.rejects(call(escrow, "new", {}), /already been initialized/i);

  // Fast-forward the disposable chain without simulating observations or forging transactions.
  async function advanceSandbox() {
    const response = await fetch(rpc!, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "escrow-v2-test", method: "sandbox_fast_forward", params: { delta_height: 10 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as { error?: unknown };
    assert.equal(result.error, undefined, JSON.stringify(result));
  }

  async function advanceTo(target: number) {
    const end = Date.now() + 45_000;
    while (await chainTime() < target) {
      assert.ok(Date.now() < end, "Sandbox chain time did not advance");
      await advanceSandbox();
      await sleep(100);
    }
  }

  const sendVotes: Awaited<ReturnType<typeof prepareVoteSender>>[] = [];
  for (const oracle of oracles) {
    const voteKey = KeyPair.fromRandom("ed25519");
    await oracle.signAndSendTransaction({
      receiverId: oracle.accountId, waitUntil: "FINAL",
      actions: [actions.addFunctionCallAccessKey(voteKey.getPublicKey(), contractId, ["submit_vote"], nearToYocto("0.3"))],
    });
    sendVotes.push(await prepareVoteSender(provider, contractId, oracle.accountId, voteKey.toString()));
  }
  const secondCustomerKey = KeyPair.fromRandom("ed25519");
  await customer.signAndSendTransaction({
    receiverId: customer.accountId, actions: [actions.addFullAccessKey(secondCustomerKey.getPublicKey())], waitUntil: "FINAL",
  });
  const secondCustomer = new Account(customer.accountId, provider, new KeyPairSigner(secondCustomerKey));

  const storageQuote = async (count: number) => BigInt(await view<string>("storage_deposit", { oracle_count: count }));
  const validOracleIds = oracles.map(({ accountId }) => accountId);
  assert.ok(validOracleIds.every(id => id.length === 64), "Use maximum-length account IDs for storage tests");
  const baseOffer = {
    customer: customer.accountId,
    endpoint_hash: Array<number>(32).fill(17),
    slot_ms: 1_000,
    reporting_grace_ms: 120_000,
    payout: String(payout),
  };
  const cases = [
    { name: "three-majority", roster: validOracleIds.slice(0, 3), quorum: undefined, slots: 5, threshold: 3,
      votes: [vote(14, 17), vote(14, 17), vote(0, 31)], outcome: "breach" },
    { name: "five-rotating", roster: validOracleIds.slice(1, 6), quorum: 3, slots: 4, threshold: 4,
      votes: [vote(3), vote(3), vote(15), vote(12), vote(12)], outcome: "inconclusive" },
    { name: "seven-partial", roster: validOracleIds.slice(0, 7), quorum: 5, slots: 8, threshold: 8,
      votes: [vote(255), vote(255), vote(255), vote(255), vote(255), null, null], outcome: "breach" },
    { name: "sixteen-alternating", roster: validOracleIds, quorum: 9, slots: 64, threshold: 64,
      votes: validOracleIds.map((_, i) => i < 8 ? vote(oddSlots, evenSlots) : vote(evenSlots, oddSlots)), outcome: "healthy" },
  ] as const;

  const firstOffer = {
    ...baseOffer, starts_at_ms: String((await chainTime()) + 60_000), oracles: cases[0].roster,
    slot_count: 5, min_down_slots: 3,
  };
  const firstDeposit = payout + await storageQuote(3);
  const beforeInvalid = await storageUsage();
  await assert.rejects(newSla(firstOffer, firstDeposit - 1n), /exactly payout plus storage/);
  await assert.rejects(newSla(firstOffer, firstDeposit + 1n), /exactly payout plus storage/);
  for (const invalid of [1, 4]) {
    await assert.rejects(newSla({ ...firstOffer, down_quorum: invalid }, firstDeposit), /Invalid down quorum/);
  }
  await assert.rejects(newSla({ ...firstOffer, oracles: [validOracleIds[0], validOracleIds[0], validOracleIds[1]] }, firstDeposit), /accounts must differ/);
  await assert.rejects(newSla({ ...firstOffer, oracles: [validOracleIds[0], validOracleIds[1], customer.accountId] }, firstDeposit), /parties and contract/);
  await assert.rejects(newSla({ ...firstOffer, oracles: validOracleIds.slice(0, 2) }, firstDeposit), /Invalid oracle count/);
  await assert.rejects(newSla({ ...firstOffer, oracles: [...validOracleIds, supplier.accountId] }, firstDeposit), /Invalid oracle count/);
  assert.equal(await view<string>("agreement_count", {}), "0");
  assert.equal(await storageUsage(), beforeInvalid);

  const results = [];
  for (const [caseIndex, scenario] of cases.entries()) {
    const quote = await storageQuote(scenario.roster.length);
    const before = await storageUsage();
    const funded = await newSla({
      ...baseOffer, starts_at_ms: String((await chainTime()) + 30_000),
      oracles: scenario.roster, down_quorum: scenario.quorum,
      slot_count: scenario.slots, min_down_slots: scenario.threshold,
    }, payout + quote);
    const slaId = slaIdOf(funded);
    const bytes = await storageUsage() - before;
    assert.ok(bytes > 0 && BigInt(bytes) * nearToYocto("0.00001") <= quote);
    const snapshot = await read(slaId);
    assert.equal(snapshot.policy_version, 2);
    assert.equal(snapshot.down_quorum, scenario.quorum ?? Math.floor(scenario.roster.length / 2) + 1);
    assert.deepEqual(snapshot.oracles, scenario.roster);
    assert.equal(snapshot.accepted, false);
    const args = { sla_id: slaId };
    if (caseIndex === 0) {
      await assert.rejects(call(supplier, "accept_sla", args), /Only customer can accept/);
    }
    await call(customer, "accept_sla", args);
    if (caseIndex === 0) {
      await assert.rejects(call(customer, "accept_sla", args), /Offer cannot be accepted/);
      const firstVote = { ...args, ...vote(14, 17), evidence_hash: Array<number>(32).fill(1) };
      await assert.rejects(sendVotes[0](firstVote), /Outside reporting period/);
      await assert.rejects(call(supplier, "finalize", args), /Reporting period still open/);
      await assert.rejects(call(customer, "claim", args), /Payment not claimable/);
    }
    await advanceTo(Number(snapshot.ends_at_ms));
    const submitted: number[] = [];
    const beforeVote = await storageUsage();
    for (const [index, masks] of scenario.votes.entries()) {
      if (!masks) continue;
      const oracle = scenario.roster[index];
      const signer = sendVotes[validOracleIds.indexOf(oracle)];
      const input = { ...args, ...masks, evidence_hash: Array<number>(32).fill(index + 1) };
      if (caseIndex === 0 && index === 0) {
        await assert.rejects(sendVotes[3](input), /Unauthorized oracle/);
        await assert.rejects(signer({ ...input, up_mask: "1", down_mask: "1" }), /Invalid slot masks/);
        await assert.rejects(signer({ ...input, up_mask: "32" }), /Invalid slot masks/);
        await assert.rejects(signer({ ...input, evidence_hash: Array<number>(32).fill(0) }), /Missing evidence hash/);
      }
      const txHash = await signer(input);
      const trace = await provider.viewTransactionStatus({ accountId: oracle, txHash, waitUntil: "FINAL" });
      submitted.push(receiptGas(trace));
      if (caseIndex === 0 && index === 0) await assert.rejects(signer(input), /Oracle already voted/);
    }
    assert.equal(await storageUsage(), beforeVote, "Votes must not increase stored bytes");
    const allVotes = scenario.votes.every(entry => entry !== null);
    if (!allVotes) {
      await assert.rejects(call(supplier, "finalize", args), /Reporting period still open/);
      await advanceTo(Number(snapshot.reporting_deadline_ms));
      await assert.rejects(sendVotes[6]({ ...args, ...vote(255), evidence_hash: Array<number>(32).fill(7) }), /Outside reporting period/);
    }
    const finalization = await call(supplier, "finalize", args);
    const state = await read(slaId);
    const expected = assessQuorumWindow(scenario.slots, scenario.threshold, snapshot.down_quorum, scenario.votes);
    assert.equal(state.outcome, scenario.outcome);
    assert.equal(state.outcome, expected.outcome);
    assert.equal(state.confirmed_down_slots, expected.confirmed);
    assert.equal(state.possible_down_slots, expected.possible);
    assert.deepEqual(state.oracles, snapshot.oracles);
    assert.equal(state.down_quorum, snapshot.down_quorum);
    assert.deepEqual(state.votes, scenario.votes.map((masks, index) => ({
      ...(masks ?? vote(0)), submitted: masks !== null,
      evidence_hash: Array<number>(32).fill(masks ? index + 1 : 0),
    })));
    await assert.rejects(call(supplier, "finalize", args), /already finalized/);
    await assert.rejects(sendVotes[validOracleIds.indexOf(scenario.roster[0])]({
      ...args, ...vote(0), evidence_hash: Array<number>(32).fill(1),
    }), /cannot accept votes/);
    const kind = state.outcome === "breach" ? "compensation" : "refund";
    const beneficiary = kind === "compensation" ? customer : supplier;
    const other = kind === "compensation" ? supplier : customer;
    await assert.rejects(call(other, "claim", args), /Only beneficiary can claim/);
    await assert.rejects(call(beneficiary, "claim", args, "59"), /Attach at least 60 Tgas/);
    await assert.rejects(call(customer, "on_payment", { ...args, attempt: 1 }), /private/);

    const claims = caseIndex === 0
      ? await Promise.all([customer, secondCustomer].map(account => account.signAndSendTransaction({
        receiverId: contractId, actions: [actions.functionCall("claim", args, teraToGas("60"), 0n)],
        waitUntil: "FINAL", throwOnFailure: false,
      })))
      : [await call(beneficiary, "claim", args, "60")];
    const successes = claims.filter(tx => typeof tx.status === "object"
      && "SuccessValue" in tx.status && tx.status.SuccessValue === "dHJ1ZQ==");
    assert.equal(successes.length, 1);
    if (claims.length === 2) {
      const rejected = claims.find(tx => typeof tx.status === "object" && "Failure" in tx.status);
      assert.ok(rejected);
      assert.match(JSON.stringify(rejected.status), /Payment not claimable/);
    }
    const payment = successes[0];
    const transactionHash = payment.transaction_outcome.id;
    const trace = await provider.viewTransactionStatusWithReceipts({
      accountId: beneficiary.accountId, txHash: transactionHash, waitUntil: "FINAL",
    });
    const paid = await read(slaId);
    assert.equal(paid.attempt, 1);
    const proof = verifySettlement({ contract: contractId, slaId, transactionHash, kind, policyVersion: 2 },
      paid, trace as unknown as TransactionTrace);
    const callback = trace.receipts_outcome.find(({ id }) => id === proof.callback_receipt_id);
    assert.ok(callback);
    await assert.rejects(call(beneficiary, "claim", args), /Payment not claimable/);
    assert.equal(await storageUsage(), beforeVote, "Settlement must not increase stored bytes");
    const gas = {
      create: receiptGas(funded), max_vote: Math.max(...submitted), finalize: receiptGas(finalization),
      claim: receiptGas(payment), callback: callback.outcome.gas_burnt / 1e12,
    };
    assert.ok(gas.max_vote < 30 && gas.finalize < 100 && gas.callback < 30, JSON.stringify(gas));
    const result = {
      scenario: scenario.name, oracle_count: scenario.roster.length, quorum: snapshot.down_quorum,
      verdict: expected, storage_bytes: bytes, storage_quote_yoctonear: String(quote), receipt_gas_tgas: gas, ...proof,
    };
    results.push(result);
    console.error(`Verified ${scenario.name} on Sandbox`);
  }

  const unaccepted = await newSla({
    ...firstOffer, starts_at_ms: String((await chainTime()) + 20_000),
  }, firstDeposit);
  const unacceptedId = slaIdOf(unaccepted);
  const unacceptedArgs = { sla_id: unacceptedId };
  await assert.rejects(call(supplier, "finalize", unacceptedArgs), /Offer still open/);
  await advanceTo(Number((await read(unacceptedId)).starts_at_ms));
  await assert.rejects(call(customer, "accept_sla", unacceptedArgs), /Offer cannot be accepted/);
  await call(customer, "finalize", unacceptedArgs);
  const unacceptedState = await read(unacceptedId);
  assert.equal(unacceptedState.outcome, "unaccepted");
  assert.equal(unacceptedState.payment, "claimable");
  await assert.rejects(call(customer, "claim", unacceptedArgs), /Only beneficiary can claim/);
  const refund = await call(supplier, "claim", unacceptedArgs, "60");
  const refundHash = refund.transaction_outcome.id;
  const refundTrace = await provider.viewTransactionStatusWithReceipts({
    accountId: supplier.accountId, txHash: refundHash, waitUntil: "FINAL",
  });
  const unacceptedProof = verifySettlement({
    contract: contractId, slaId: unacceptedId, transactionHash: refundHash, kind: "refund", policyVersion: 2,
  }, await read(unacceptedId), refundTrace as unknown as TransactionTrace);
  console.error("Verified unaccepted-offer refund on Sandbox");

  const retryKey = KeyPair.fromRandom("ed25519");
  const retryAccount = await create("retry", "5", false);
  await retryAccount.signAndSendTransaction({
    receiverId: retryAccount.accountId, waitUntil: "FINAL",
    actions: [actions.deployContract(fixtureWasm),
      actions.functionCall("new", {}, teraToGas("30"), 0n)],
  });
  const retry = await call(retryAccount, "create_sla", {
    ...firstOffer, starts_at_ms: String((await chainTime()) + 20_000),
  }, "100", firstDeposit);
  const retryId = slaIdOf(retry);
  const retryArgs = { sla_id: retryId };
  await advanceTo(Number((await read(retryId)).starts_at_ms));
  await call(customer, "finalize", retryArgs);

  // Schedule the claim and the named beneficiary's deletion in one sandbox transaction batch.
  const failed = await retryAccount.signAndSendTransaction({
    receiverId: retryAccount.accountId,
    actions: [
      actions.functionCall("schedule_missing_recipient", { escrow_id: contractId, sla_id: retryId }, teraToGas("75"), 0n),
      actions.deleteAccount(root.accountId),
    ],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  assert.ok(failed.receipts_outcome.some(({ outcome }) => outcome.executor_id === retryAccount.accountId
    && typeof outcome.status === "object" && "Failure" in outcome.status), JSON.stringify(failed.receipts_outcome));
  assert.ok(failed.receipts_outcome.some(({ outcome }) => outcome.executor_id === contractId
    && outcome.logs.some(log => log.includes('"event":"payment_failed"'))
    && typeof outcome.status === "object" && "SuccessValue" in outcome.status
    && outcome.status.SuccessValue === "ZmFsc2U="), "Expected the callback to record the failed attempt");
  const retryable = await read(retryId);
  assert.equal(retryable.payment, "claimable");
  assert.equal(retryable.attempt, 1);
  await root.createSubAccount({
    accountOrPrefix: retryAccount.accountId.slice(0, -root.accountId.length - 1),
    publicKey: retryKey.getPublicKey(), nearToTransfer: nearToYocto("5"),
  });
  const recreated = new Account(retryAccount.accountId, provider, new KeyPairSigner(retryKey));
  const retried = await call(recreated, "claim", retryArgs, "60");
  const retryHash = retried.transaction_outcome.id;
  const retryTrace = await provider.viewTransactionStatusWithReceipts({
    accountId: recreated.accountId, txHash: retryHash, waitUntil: "FINAL",
  });
  const retriedState = await read(retryId);
  assert.equal(retriedState.attempt, 2);
  const retryProof = verifySettlement({
    contract: contractId, slaId: retryId, transactionHash: retryHash, kind: "refund", policyVersion: 2,
  }, retriedState, retryTrace as unknown as TransactionTrace);
  await assert.rejects(call(recreated, "claim", retryArgs), /Payment not claimable/);
  console.error("Verified transfer failure and one successful retry on Sandbox");

  const pendingEscrow = await create("pending-escrow", "5", false);
  const pendingContract = pendingEscrow.accountId;
  await pendingEscrow.signAndSendTransaction({
    receiverId: pendingContract, waitUntil: "FINAL",
    actions: [actions.deployContract(fixtureWasm), actions.functionCall("new", {}, teraToGas("30"), 0n)],
  });
  const pendingCall = (
    account: Account, methodName: string, args: Record<string, unknown>, deposit = 0n,
  ) => account.callFunctionRaw({
    contractId: pendingContract, methodName, args, waitUntil: "FINAL", gas: teraToGas("100"), deposit,
  });
  const funded = await pendingCall(supplier, "create_sla", {
    ...firstOffer, starts_at_ms: String((await chainTime()) + 20_000),
  }, firstDeposit);
  const pendingId = slaIdOf(funded);
  const pendingArgs = { sla_id: pendingId };
  const readPending = async () => {
    const state = await provider.callFunction<Agreement>({
      contractId: pendingContract, method: "get_sla", args: pendingArgs, blockQuery: { finality: "final" },
    });
    assert.ok(state, "Missing the pending fixture agreement");
    return state;
  };
  await advanceTo(Number((await readPending()).starts_at_ms));
  await pendingCall(customer, "finalize", pendingArgs);
  await assert.rejects(pendingCall(supplier, "schedule_unresolved_payment", pendingArgs), /private/);
  const unresolved = await pendingEscrow.signAndSendTransaction({
    receiverId: pendingContract,
    actions: [actions.functionCall("schedule_unresolved_payment", pendingArgs, teraToGas("60"), 0n)],
    waitUntil: "FINAL", throwOnFailure: false,
  });
  const unresolvedHash = unresolved.transaction_outcome.id;
  const unresolvedTrace = await provider.viewTransactionStatusWithReceipts({
    accountId: pendingContract, txHash: unresolvedHash, waitUntil: "FINAL",
  }) as unknown as TransactionTrace;
  assert.equal(unresolvedTrace.final_execution_status, "FINAL");
  const claimId = unresolvedTrace.transaction_outcome.outcome.status.SuccessReceiptId;
  const claim = unresolvedTrace.receipts_outcome.find(({ id }) => id === claimId)?.outcome;
  assert.ok(claim);
  const callbackId = claim.status.SuccessReceiptId;
  assert.ok(callbackId && claim.receipt_ids.includes(callbackId));
  assert.equal(claim.executor_id, pendingContract);
  assert.ok(claim.logs.some(log => log.includes('"event":"payment_pending"')));
  const callback = unresolvedTrace.receipts?.find(({ receipt_id }) => receipt_id === callbackId);
  const callbackOutcome = unresolvedTrace.receipts_outcome.find(({ id }) => id === callbackId)?.outcome;
  const callbackAction = callback?.receipt.Action;
  assert.equal(callback?.predecessor_id, pendingContract);
  assert.equal(callback?.receiver_id, pendingContract);
  assert.equal(callbackOutcome?.executor_id, pendingContract);
  assert.match(JSON.stringify(callbackOutcome?.status), /GasExceeded|Exceeded the prepaid gas/i);
  assert.equal(callbackAction?.actions[0].FunctionCall?.method_name, "on_payment");
  assert.equal(callbackAction?.input_data_ids.length, 1);
  const transfers = unresolvedTrace.receipts?.filter(receipt => claim.receipt_ids.includes(receipt.receipt_id)
    && receipt.predecessor_id === pendingContract && receipt.receiver_id === supplier.accountId
    && receipt.receipt.Action?.actions.some(action => action.Transfer));
  assert.ok(transfers?.length === 1);
  const transfer = transfers[0];
  const transferAction = transfer.receipt.Action;
  assert.equal(transferAction?.actions.length, 1);
  assert.equal(transferAction?.actions[0].Transfer?.deposit, String(payout));
  assert.ok(transferAction?.output_data_receivers.some(({ data_id, receiver_id }) =>
    receiver_id === pendingContract && data_id === callbackAction?.input_data_ids[0]));
  const transferOutcome = unresolvedTrace.receipts_outcome.find(({ id }) => id === transfer.receipt_id)?.outcome;
  assert.equal(transferOutcome?.executor_id, supplier.accountId);
  assert.equal(transferOutcome?.status.SuccessValue, "");
  const pending = await readPending();
  assert.equal(pending.outcome, "unaccepted");
  assert.equal(pending.payment, "pending");
  assert.equal(pending.attempt, 1);
  const blocked = await supplier.signAndSendTransaction({
    receiverId: pendingContract, actions: [actions.functionCall("claim", pendingArgs, teraToGas("60"), 0n)],
    waitUntil: "FINAL", throwOnFailure: false,
  });
  assert.match(JSON.stringify(blocked.status), /Payment not claimable/);
  assert.deepEqual(await readPending(), pending, "A blocked claim must preserve the original attempt");
  console.error("Verified a successful transfer with a failed callback and a blocked second claim on Sandbox");

  console.log(JSON.stringify({
    network, contract: contractId, scenarios: results, unaccepted_refund: unacceptedProof,
    failed_transfer_tx: failed.transaction_outcome.id, retry_payment: retryProof,
    unresolved_callback: {
      contract: pendingContract, sla_id: pendingId, beneficiary: supplier.accountId, amount_yoctonear: String(payout),
      transaction_hash: unresolvedHash, transfer_receipt_id: transfer.receipt_id, callback_receipt_id: callbackId,
      blocked_claim_tx: blocked.transaction_outcome.id, payment: pending.payment, attempt: pending.attempt,
    },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
