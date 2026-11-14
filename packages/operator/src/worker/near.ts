import { createHash } from "node:crypto";
import { baseDecode, baseEncode, createTransaction, SignedTransaction } from "near-api-js";
import type { KeyPairSigner } from "near-api-js";
import { isRecord, isU64, policyFromAgreement } from "../../../shared/oracle-protocol.ts";
import { nearRpc, NetworkMismatch } from "../../../shared/near-rpc.ts";
import type { Assignment } from "../../../shared/oracle-protocol.ts";
import type { ContractVote } from "../monitoring/evidence.ts";
import { requireVotePermission, voteAction } from "../oracles/oracle-signer.ts";
import type { PendingTransaction } from "./store.ts";

export class WorkerPolicyError extends Error {}

export interface WorkerSnapshot {
  time: number;
  blockHash: string;
  codeHash: string;
  clockSkewMs: number;
  agreement: unknown;
}

export type CheckedVote = Omit<ContractVote, "sla_id"> & { submitted: boolean };

export function checkSnapshot(assignment: Assignment, snapshot: WorkerSnapshot, oracle: string) {
  const { agreement } = snapshot;
  if (snapshot.codeHash !== assignment.code_hash || !isRecord(agreement) || typeof agreement.accepted !== "boolean"
      || !["undecided", "breach", "healthy", "inconclusive", "unaccepted"].includes(String(agreement.outcome))) {
    throw new WorkerPolicyError("Finalized contract code or agreement state differs from the assignment");
  }
  let policy;
  try { policy = policyFromAgreement(agreement); }
  catch { throw new WorkerPolicyError("Invalid finalized agreement policy"); }
  const index = policy.oracles.indexOf(oracle);
  if (JSON.stringify(policy) !== JSON.stringify(assignment.policy) || index < 0 || !Array.isArray(agreement.votes)
      || agreement.votes.length !== policy.oracles.length) {
    throw new WorkerPolicyError("Finalized oracle roster or policy differs from the assignment");
  }
  const vote: unknown = agreement.votes[index];
  if (!isRecord(vote) || typeof vote.submitted !== "boolean" || !isU64(vote.up_mask) || !isU64(vote.down_mask)
      || !Array.isArray(vote.evidence_hash) || vote.evidence_hash.length !== 32
      || !vote.evidence_hash.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new WorkerPolicyError("Invalid finalized oracle vote");
  }
  return {
    accepted: agreement.accepted, open: agreement.outcome === "undecided",
    vote: { submitted: vote.submitted, up_mask: vote.up_mask, down_mask: vote.down_mask, evidence_hash: vote.evidence_hash },
  };
}

export interface WorkerChain {
  health(): Promise<void>;
  read(assignment: Assignment): Promise<WorkerSnapshot>;
  authorize(assignment: Assignment, snapshot: WorkerSnapshot): Promise<bigint>;
  prepare(assignment: Assignment, snapshot: WorkerSnapshot, nonce: bigint, vote: ContractVote): Promise<PendingTransaction>;
  broadcast(assignment: Assignment, vote: ContractVote, pending: PendingTransaction): Promise<"accepted" | "stale">;
  finalizedTransaction(assignment: Assignment, vote: ContractVote, pending: PendingTransaction): Promise<"success" | "failed" | "unknown">;
}

export function nearWorker(rpcUrl: string, oracle: string, signer: KeyPairSigner, network = "testnet", signal?: AbortSignal, genesis?: string): WorkerChain {
  const rpc = nearRpc(rpcUrl, network, signal, genesis);
  return {
    async health() {
      const { result, error } = await rpc.request("status", []);
      if (error !== undefined || !isRecord(result) || result.chain_id !== network
          || !isRecord(result.sync_info) || result.sync_info.syncing !== false) {
        throw new Error("Oracle RPC is unavailable or syncing");
      }
    },
    async read(assignment) {
      try { return await rpc.readAgreement(assignment.contract, assignment.sla_id); }
      catch (error) {
        if (error instanceof NetworkMismatch) throw new WorkerPolicyError(error.message);
        throw error;
      }
    },
    async authorize(assignment, snapshot) {
      const { permission, nonce } = await rpc.query(snapshot.blockHash, {
        request_type: "view_access_key", account_id: oracle, public_key: (await signer.getPublicKey()).toString(),
      });
      try { requireVotePermission(permission, assignment.contract); }
      catch { throw new WorkerPolicyError("Worker key is not scoped to this escrow and submit_vote"); }
      if (!isU64(nonce) && (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0)) {
        throw new Error("Invalid access key nonce");
      }
      return BigInt(nonce);
    },
    async prepare(assignment, snapshot, nonce, vote) {
      const transaction = createTransaction(
        oracle, await signer.getPublicKey(), assignment.contract, nonce + 1n, [voteAction(vote)], baseDecode(snapshot.blockHash),
      );
      const { txHash, signedTransaction } = await signer.signTransaction(transaction);
      return { hash: baseEncode(txHash), signed: Buffer.from(signedTransaction.encode()).toString("base64") };
    },
    async broadcast(assignment, vote, pending) {
      await rpc.checkNetwork();
      if (typeof pending.signed !== "string" || pending.signed.length > 4096) {
        throw new WorkerPolicyError("Invalid queued transaction bytes");
      }
      const raw = Buffer.from(pending.signed, "base64");
      let signed;
      try { signed = SignedTransaction.decode(raw); }
      catch { throw new WorkerPolicyError("Invalid queued transaction encoding"); }
      const tx = signed.transaction;
      const hash = createHash("sha256").update(tx.encode()).digest();
      const actual = tx.actions[0]?.functionCall;
      const expected = voteAction(vote).functionCall!;
      const publicKey = await signer.getPublicKey();
      if (pending.hash !== baseEncode(hash) || tx.signerId !== oracle || tx.receiverId !== assignment.contract
          || tx.publicKey.toString() !== publicKey.toString() || tx.actions.length !== 1 || !actual
          || actual.methodName !== expected.methodName || actual.gas !== expected.gas || actual.deposit !== 0n
          || !Buffer.from(actual.args).equals(Buffer.from(expected.args))
          || !publicKey.verify(hash, signed.signature.data)) {
        throw new WorkerPolicyError("Queued transaction differs from the persisted vote");
      }
      const envelope = await rpc.request("send_tx", { signed_tx_base64: pending.signed, wait_until: "INCLUDED" });
      if (envelope.error === undefined && isRecord(envelope.result)
          && ["INCLUDED", "INCLUDED_FINAL", "EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"]
            .includes(String(envelope.result.final_execution_status))) return "accepted";
      const error = envelope.error;
      const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined;
      const info = cause && isRecord(cause.info) ? cause.info : undefined;
      const invalid = isRecord(error) && isRecord(error.data) ? error.data.TxExecutionError : info?.TxExecutionError;
      const reason = isRecord(invalid) ? invalid.InvalidTxError : undefined;
      if (cause?.name === "INVALID_TRANSACTION" && reason === "Expired") {
        return "stale";
      }
      throw new Error("Vote transaction has no confirmed result");
    },
    async finalizedTransaction(assignment, vote, pending) {
      if (vote.sla_id !== assignment.sla_id || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pending.hash)) {
        throw new WorkerPolicyError("Invalid queued transaction identity");
      }
      await rpc.checkNetwork();
      const { result, error } = await rpc.request("tx", {
        tx_hash: pending.hash, sender_account_id: oracle, wait_until: "FINAL",
      });
      if (error !== undefined || !isRecord(result) || result.final_execution_status !== "FINAL"
          || !isRecord(result.transaction_outcome) || result.transaction_outcome.id !== pending.hash
          || !isRecord(result.status)) return "unknown";
      if ("Failure" in result.status) return "failed";
      return "SuccessValue" in result.status ? "success" : "unknown";
    },
  };
}
