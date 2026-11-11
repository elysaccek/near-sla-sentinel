export interface Vote {
  sla_id: string;
  up_mask: string;
  down_mask: string;
  evidence_hash: number[];
}

export interface ChainVote extends Omit<Vote, "sla_id"> {
  submitted: boolean;
}

export interface Agreement {
  policy_version: number;
  oracles: string[];
  endpoint_hash: number[];
  starts_at_ms: string;
  ends_at_ms: string;
  reporting_deadline_ms: string;
  slot_ms: number;
  slot_count: number;
  accepted: boolean;
  outcome: string;
  votes: ChainVote[];
}

export interface Snapshot {
  agreement: Agreement;
  blockTimeMs: bigint;
}

interface VoteBundle {
  contract_vote: Vote;
}

interface ReportOptions<Bundle extends VoteBundle> {
  oracle: string;
  submit: boolean;
  read: () => Promise<Snapshot>;
  load: () => Promise<Bundle | undefined>;
  store: (bundle: Bundle) => Promise<Bundle>;
  measure: (agreement: Agreement) => Promise<Bundle>;
  verify: (bundle: Bundle, agreement: Agreement) => Promise<boolean>;
  send: (vote: Vote) => Promise<string>;
  wait?: (ms: number) => Promise<void>;
}

function sameVote(recorded: ChainVote, expected: Vote): boolean {
  return recorded.up_mask === expected.up_mask && recorded.down_mask === expected.down_mask
    && recorded.evidence_hash.length === expected.evidence_hash.length
    && recorded.evidence_hash.every((byte, index) => byte === expected.evidence_hash[index]);
}

function voteFor(agreement: Agreement, oracle: string): ChainVote {
  const index = agreement.oracles.indexOf(oracle);
  if (agreement.policy_version !== 1 || agreement.oracles.length !== 3
      || new Set(agreement.oracles).size !== 3 || !agreement.votes[index]) {
    throw new Error("Unsupported agreement or unauthorized oracle");
  }
  return agreement.votes[index];
}

function requireActive(agreement: Agreement): void {
  if (!agreement.accepted || agreement.outcome !== "undecided") {
    throw new Error("Agreement must be accepted and open");
  }
}

export async function reportVote<Bundle extends VoteBundle>(options: ReportOptions<Bundle>) {
  const initial = await options.read();
  const initialVote = voteFor(initial.agreement, options.oracle);
  let bundle = await options.load();
  if (!bundle) {
    if (initialVote.submitted) {
      throw new Error("The oracle already voted. Restore the original evidence archive");
    }
    requireActive(initial.agreement);
    if (initial.blockTimeMs >= BigInt(initial.agreement.ends_at_ms)) {
      throw new Error("Observation window ended without a local evidence archive");
    }
    bundle = await options.store(await options.measure(initial.agreement));
  }

  let current = await options.read();
  if (options.submit && options.wait) {
    for (let attempt = 0; attempt < 8 && current.blockTimeMs < BigInt(current.agreement.ends_at_ms); attempt += 1) {
      await options.wait(1_000);
      current = await options.read();
    }
  }
  const existingVote = voteFor(current.agreement, options.oracle);
  if (!await options.verify(bundle, current.agreement)) {
    throw new Error("Archived evidence does not match the agreement");
  }
  const vote = bundle.contract_vote;
  if (existingVote.submitted) {
    if (!sameVote(existingVote, vote)) {
      throw new Error("Recorded vote differs from the local evidence archive");
    }
    return { status: "already_recorded" as const };
  }
  if (!options.submit) {
    return { status: "evidence_ready" as const };
  }

  requireActive(current.agreement);
  if (current.blockTimeMs < BigInt(current.agreement.ends_at_ms)
      || current.blockTimeMs >= BigInt(current.agreement.reporting_deadline_ms)) {
    throw new Error("The finalized block is outside the reporting period. Reuse the archived evidence");
  }

  let transactionHash: string | undefined;
  try {
    transactionHash = await options.send(vote);
  } catch {
    // A transport error can arrive after the receipt has executed.
  }
  const after = await options.read().catch(() => undefined);
  if (!after) {
    throw new Error(transactionHash
      ? `Could not verify the final vote for transaction ${transactionHash}`
      : "Submission outcome unavailable. Check final chain state before rerunning");
  }
  const recorded = voteFor(after.agreement, options.oracle);
  if (!recorded.submitted || !sameVote(recorded, vote)) {
    throw new Error(transactionHash
      ? `Transaction ${transactionHash} did not record the archived vote`
      : "Submission unconfirmed. Check final chain state before rerunning");
  }
  return transactionHash
    ? { status: "recorded" as const, transaction_hash: transactionHash }
    : { status: "recorded_after_rpc_error" as const };
}
