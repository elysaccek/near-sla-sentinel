import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseDecode } from "near-api-js";
import { scopedVotePermission } from "../../../shared/near-rpc.ts";
import { isBase58Hash, isNearPublicKey, isRecord, isTestnetAccount, isU64, policyFromAgreement } from "../../../shared/oracle-protocol.ts";
import { assessQuorumWindow, verifyEvidenceBundle, WORKER_EVIDENCE_DOMAIN } from "../monitoring/evidence.ts";
import type { ContractVote, EvidenceBundle, WorkerEvidenceDocument } from "../monitoring/evidence.ts";
import { hashEndpoint } from "../monitoring/monitor.ts";
import { verifySettlement } from "./settlement.ts";
import type { SettlementState, TransactionTrace } from "./settlement.ts";

export interface WorkerProofChain {
  checkNetwork(): Promise<void>;
  block(hash: string): Promise<{ time: number }>;
  query(blockHash: string, args: object): Promise<Record<string, unknown>>;
  callAtBlock(blockHash: string, contract: string, method: string, args: Record<string, unknown>): Promise<unknown>;
  transaction(account: string, hash: string): Promise<unknown>;
  receipts(account: string, hash: string): Promise<unknown>;
}

function finalizedTransaction(value: unknown, account: string, contract: string, hash: string) {
  assert.ok(isRecord(value) && value.final_execution_status === "FINAL"
    && isRecord(value.transaction) && isRecord(value.transaction_outcome) && isRecord(value.status),
  "Expected a finalized transaction");
  const { transaction, transaction_outcome: outcome, status, receipts_outcome: receipts } = value;
  assert.ok(transaction.hash === hash && outcome.id === hash && transaction.signer_id === account
    && transaction.receiver_id === contract && Array.isArray(transaction.actions) && isBase58Hash(outcome.block_hash),
  "Transaction differs from the expected signer, contract or hash");
  const receiptId = isRecord(outcome.outcome) && isRecord(outcome.outcome.status) ? outcome.outcome.status.SuccessReceiptId : undefined;
  const receipt = Array.isArray(receipts) ? receipts.find((item: unknown) => isRecord(item) && item.id === receiptId) : undefined;
  assert.ok(isRecord(receipt) && isBase58Hash(receiptId) && isBase58Hash(receipt.block_hash)
    && isRecord(receipt.outcome) && receipt.outcome.executor_id === contract && isRecord(receipt.outcome.status),
  "Missing the contract execution receipt");
  return { transaction, inclusionBlock: outcome.block_hash, status, receiptBlock: receipt.block_hash, receiptStatus: receipt.outcome.status };
}

function callArgs(action: unknown, method: string) {
  assert.ok(isRecord(action) && Object.keys(action).length === 1 && isRecord(action.FunctionCall)
    && action.FunctionCall.method_name === method && action.FunctionCall.deposit === "0"
    && typeof action.FunctionCall.args === "string", `Expected a zero-deposit ${method} call`);
  const bytes = Buffer.from(action.FunctionCall.args, "base64");
  assert.equal(bytes.toString("base64"), action.FunctionCall.args, "Invalid call arguments encoding");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function eventTime(events: unknown, name: string) {
  assert.ok(Array.isArray(events) && events.length <= 64, "Invalid recorded events");
  const matches = events.filter((event: unknown) => isRecord(event) && event.event === name);
  assert.equal(matches.length, 1, `Expected one recorded ${name} event`);
  const { ms } = matches[0];
  assert.ok(typeof ms === "number" && Number.isSafeInteger(ms) && ms > 0, `Invalid time for ${name}`);
  return ms;
}

function hash32(value: unknown): value is string {
  return isBase58Hash(value) && baseDecode(value).length === 32;
}

export function workerProofGenesis(value: unknown) {
  assert.ok(isRecord(value) && value.network === "testnet" && hash32(value.genesis), "Expected a Testnet worker proof");
  return value.genesis;
}

export async function verifyWorkerProof(input: unknown, chain: WorkerProofChain) {
  assert.ok(isRecord(input));
  const genesis = workerProofGenesis(input);
  const { contract, code_hash, wasm_sha256, deployment_tx, provider, customer, target, events, agreement: savedAgreement } = input;
  // The recovery archive calls the settlement “refund”. Use “settlement” for new runs, including compensation.
  assert.ok(input.settlement === undefined || input.refund === undefined, "Use one settlement summary");
  const savedSettlement = input.settlement ?? input.refund;
  assert.ok(isTestnetAccount(contract) && isTestnetAccount(provider) && isTestnetAccount(customer)
    && hash32(code_hash) && hash32(deployment_tx) && typeof wasm_sha256 === "string" && /^[0-9a-f]{64}$/.test(wasm_sha256)
    && typeof target === "string" && isRecord(savedSettlement) && isU64(savedSettlement.sla_id)
    && hash32(savedSettlement.transaction_hash) && isRecord(savedAgreement),
  "Invalid deployment, agreement or settlement identity");
  const sla_id = savedSettlement.sla_id;
  const policy = policyFromAgreement(savedAgreement);
  assert.ok(policy.oracles.every(isTestnetAccount), "Expected a Testnet oracle roster");
  assert.deepEqual(await hashEndpoint(target), policy.endpoint_hash, "Target URL differs from the accepted endpoint hash");
  assert.ok(savedAgreement.accepted === true && savedAgreement.provider === provider && savedAgreement.customer === customer,
    "Expected an accepted agreement with matching parties");
  const offline = eventTime(events, "master_offline_confirmed");
  const recorded = eventTime(events, "all_votes_recorded_master_offline");
  const restored = eventTime(events, "master_available_again");
  assert.ok(offline < Number(policy.starts_at_ms) && recorded >= Number(policy.ends_at_ms) && recorded < restored,
    "Recorded outage does not cover the agreement window and reporting");
  const restartedOracle = input.restarted_oracle ?? policy.oracles[0];
  assert.ok(isTestnetAccount(restartedOracle) && policy.oracles.includes(restartedOracle), "Invalid restarted oracle");
  const currentEvents = input.restarted_oracle !== undefined;
  const firstProbe = eventTime(events, currentEvents ? "oracle_first_probe_persisted" : "oracle_1_first_probe_persisted");
  const restart = eventTime(events, currentEvents ? "oracle_restarted" : "oracle_1_restarted");
  const heartbeat = eventTime(events, "all_heartbeats_recovered");
  assert.ok(firstProbe >= Number(policy.starts_at_ms) && firstProbe < restart
    && restart < Number(policy.ends_at_ms) && heartbeat > restored, "Invalid recorded restart or heartbeat timeline");

  const { oracles: keyRows, evidence, vote_transactions: votes } = input;
  assert.ok([keyRows, evidence, votes].every((rows) => Array.isArray(rows) && rows.length === policy.oracles.length),
    "Expected one key, evidence bundle and vote transaction per oracle");
  const byAccount = new Map<string, { hash: string; included_at_ms: number; up_slots: number }>();
  for (const row of votes as unknown[]) {
    assert.ok(isRecord(row) && isTestnetAccount(row.oracle) && hash32(row.hash)
      && typeof row.included_at_ms === "number" && Number.isSafeInteger(row.included_at_ms)
      && typeof row.up_slots === "number" && Number.isInteger(row.up_slots) && !byAccount.has(row.oracle),
    "Invalid or duplicate vote transaction reference");
    byAccount.set(row.oracle, { hash: row.hash, included_at_ms: row.included_at_ms, up_slots: row.up_slots });
  }
  const byKey = new Map<string, string>();
  for (const row of keyRows as unknown[]) {
    assert.ok(isRecord(row) && isTestnetAccount(row.account) && isNearPublicKey(row.public_key) && !byKey.has(row.account),
      "Invalid or duplicate oracle key reference");
    byKey.set(row.account, row.public_key);
  }
  const byEvidence = new Map<string, EvidenceBundle & { evidence: WorkerEvidenceDocument }>();
  for (const bundle of evidence as EvidenceBundle[]) {
    const doc = bundle?.evidence;
    assert.ok(doc?.domain === WORKER_EVIDENCE_DOMAIN && isTestnetAccount(doc.oracle) && !byEvidence.has(doc.oracle),
      "Invalid or duplicate worker evidence");
    byEvidence.set(doc.oracle, { ...bundle, evidence: doc });
  }

  await chain.checkNetwork();
  const deploy = finalizedTransaction(await chain.transaction(contract, deployment_tx), contract, contract, deployment_tx);
  const deploymentActions = deploy.transaction.actions as unknown[];
  const [deployAction, initialize] = deploymentActions;
  assert.ok(deploymentActions.length === 2 && isRecord(deployAction) && Object.keys(deployAction).length === 1
    && isRecord(deployAction.DeployContract) && typeof deployAction.DeployContract.code === "string"
    && deploy.status.SuccessValue === "" && deploy.receiptStatus.SuccessValue === "",
  "Deployment must install and initialize the escrow");
  assert.deepEqual(callArgs(initialize, "new"), {}, "Invalid initialization arguments");
  // NEAR may return the 32-byte code digest in this action instead of the Wasm.
  const code = Buffer.from(deployAction.DeployContract.code, "base64");
  assert.equal(code.toString("base64"), deployAction.DeployContract.code, "Invalid deployment bytes encoding");
  const expectedDigest = Buffer.from(wasm_sha256, "hex");
  const deployedDigest = code.length === 32 ? code : createHash("sha256").update(code).digest();
  assert.ok(deployedDigest.equals(expectedDigest) && expectedDigest.equals(baseDecode(code_hash)), "Deployment code hash differs");

  const kind = savedAgreement.outcome === "breach" ? "compensation" : "refund";
  const beneficiary = kind === "refund" ? provider : customer;
  const claimHash = savedSettlement.transaction_hash;
  const trace = await chain.receipts(beneficiary, claimHash) as TransactionTrace;
  const callback = trace?.receipts_outcome?.find((receipt) => receipt.id === savedSettlement.callback_receipt_id);
  assert.ok(isRecord(callback) && hash32(callback.block_hash), "Missing the archived callback block");
  const blockHash = callback.block_hash;
  const [contractAtPayment, agreement] = await Promise.all([
    chain.query(blockHash, { request_type: "view_account", account_id: contract }),
    chain.callAtBlock(blockHash, contract, "get_sla", { sla_id }),
  ]);
  assert.equal(contractAtPayment.code_hash, code_hash, "Escrow code hash differs at settlement");
  assert.deepEqual(agreement, savedAgreement, "Archived agreement differs from the proof");
  const settlement = verifySettlement({ contract, slaId: sla_id, transactionHash: claimHash, policyVersion: 2, kind },
    savedAgreement as unknown as SettlementState, trace);
  assert.deepEqual(settlement, savedSettlement, "Archived transfer or callback differs from the proof");
  const callbackTime = (await chain.block(blockHash)).time;

  const acceptedHash = input.acceptance_tx;
  assert.ok(hash32(acceptedHash), "Invalid acceptance transaction hash");
  const acceptance = finalizedTransaction(await chain.transaction(customer, acceptedHash), customer, contract, acceptedHash);
  const acceptActions = acceptance.transaction.actions as unknown[];
  assert.equal(acceptActions.length, 1);
  assert.deepEqual(callArgs(acceptActions[0], "accept_sla"), { sla_id });
  assert.ok(acceptance.status.SuccessValue === "" && acceptance.receiptStatus.SuccessValue === ""
    && (await chain.block(acceptance.receiptBlock)).time < offline,
    "Expected customer acceptance before the recorded outage");

  const recordedVotes = savedAgreement.votes;
  assert.ok(Array.isArray(recordedVotes) && recordedVotes.length === policy.oracles.length, "Invalid on-chain vote roster");
  const verified = [];
  const masks: ContractVote[] = [];
  const blockTimes = new Map<string, number>();
  async function timeAt(hash: string) {
    let time = blockTimes.get(hash);
    if (time === undefined) {
      time = (await chain.block(hash)).time;
      blockTimes.set(hash, time);
    }
    return time;
  }
  for (const [index, oracle] of policy.oracles.entries()) {
    const entry = byAccount.get(oracle);
    const publicKey = byKey.get(oracle);
    const bundle = byEvidence.get(oracle);
    assert.ok(entry && publicKey && bundle, `Missing proof data for ${oracle}`);
    const vote: unknown = recordedVotes[index];
    assert.ok(isRecord(vote) && vote.submitted === true && isU64(vote.up_mask) && isU64(vote.down_mask)
      && Array.isArray(vote.evidence_hash), `Missing a finalized vote for ${oracle}`);
    const contract_vote = { sla_id, up_mask: vote.up_mask, down_mask: vote.down_mask, evidence_hash: vote.evidence_hash };
    const { endpoint_hash, starts_at_ms, slot_ms, slot_count } = policy;
    assert.ok(await verifyEvidenceBundle(bundle, { config: { network: "testnet", contract, sla_id, oracle,
      endpoint_hash, starts_at_ms, slot_ms, slot_count }, contract_vote }), `Evidence differs from the finalized vote for ${oracle}`);
    const { observations } = bundle.evidence;
    const measured = observations.filter(({ started_at_ms }) => started_at_ms !== null);
    assert.ok(measured.length && measured.every(({ started_at_ms, finished_at_ms }) =>
      started_at_ms !== null && finished_at_ms !== null && started_at_ms >= offline && finished_at_ms <= recorded),
    `Measurements fall outside the recorded outage for ${oracle}`);
    if (oracle === restartedOracle) {
      const first = observations[0];
      assert.ok(first.finished_at_ms !== null && first.finished_at_ms <= firstProbe
        && measured.some(({ started_at_ms }) => started_at_ms !== null && started_at_ms >= restart),
      "First oracle evidence must include a probe before and after the recorded restart");
    }
    const up = observations.filter(({ result }) => result === "up").length;
    assert.equal(up, entry.up_slots, `Recorded Up count differs for ${oracle}`);
    const tx = finalizedTransaction(await chain.transaction(oracle, entry.hash), oracle, contract, entry.hash);
    assert.ok(tx.transaction.public_key === publicKey && typeof tx.status.SuccessValue === "string"
      && typeof tx.receiptStatus.SuccessValue === "string", `Vote did not succeed with the expected key for ${oracle}`);
    const actions = tx.transaction.actions as unknown[];
    assert.equal(actions.length, 1, "Expected a single vote action");
    assert.deepEqual(callArgs(actions[0], "submit_vote"), contract_vote, `Vote arguments differ for ${oracle}`);
    const included = await timeAt(tx.inclusionBlock);
    const executed = await timeAt(tx.receiptBlock);
    assert.equal(included, entry.included_at_ms, `Vote inclusion time differs for ${oracle}`);
    assert.ok(included >= offline && included <= executed && executed >= Number(policy.ends_at_ms)
      && executed < Number(policy.reporting_deadline_ms) && executed <= recorded && executed < callbackTime,
    `Vote execution falls outside the reporting period and recorded outage for ${oracle}`);
    const { permission } = await chain.query(tx.inclusionBlock, {
      request_type: "view_access_key", account_id: oracle, public_key: publicKey,
    });
    assert.ok(scopedVotePermission(permission, contract), `Vote key was outside its scope for ${oracle}`);
    const voteEscrow = await chain.query(tx.receiptBlock, { request_type: "view_account", account_id: contract });
    assert.equal(voteEscrow.code_hash, code_hash, `Escrow code hash differs at vote execution for ${oracle}`);
    masks.push(contract_vote);
    verified.push({ oracle, vote_transaction: entry.hash, included_at_ms: included, executed_at_ms: executed, measurements: measured.length, up_slots: up });
  }
  const verdict = assessQuorumWindow(policy.slot_count, policy.min_down_slots, policy.down_quorum, masks);
  assert.deepEqual(verdict, { outcome: savedAgreement.outcome, confirmed: savedAgreement.confirmed_down_slots,
    possible: savedAgreement.possible_down_slots }, "Quorum verdict differs from finalized state");
  assert.deepEqual(verdict, input.verdict, "Quorum verdict differs from the proof");
  const duplicateHash = input.duplicate_claim_rejected_tx;
  assert.ok(hash32(duplicateHash) && duplicateHash !== claimHash, "Invalid duplicate claim transaction");
  const duplicate = finalizedTransaction(await chain.transaction(beneficiary, duplicateHash), beneficiary, contract, duplicateHash);
  const actions = duplicate.transaction.actions as unknown[];
  assert.equal(actions.length, 1);
  assert.deepEqual(callArgs(actions[0], "claim"), { sla_id });
  assert.ok(isRecord(duplicate.status.Failure) && JSON.stringify(duplicate.status.Failure).includes("Payment not claimable")
    && isRecord(duplicate.receiptStatus.Failure)
    && (await chain.block(duplicate.receiptBlock)).time > callbackTime, "Duplicate claim did not fail after the successful settlement");

  return {
    network: "testnet", genesis, contract, sla_id, code_hash, deployment_tx, verdict, votes: verified,
    settlement: { kind, ...settlement }, duplicate_claim_rejected_tx: duplicateHash,
    recorded_outage: { source: "operator_log", offline_ms: offline, votes_recorded_ms: recorded, available_ms: restored,
      restarted_oracle: restartedOracle, restarted_ms: restart, heartbeats_recovered_ms: heartbeat },
  };
}
