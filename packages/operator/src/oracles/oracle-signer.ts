import { Account, actions, KeyPairSigner, teraToGas } from "near-api-js";
import type { JsonRpcProvider, KeyPairString } from "near-api-js";
import { scopedVotePermission } from "../../../shared/near-rpc.ts";
import type { Vote } from "./oracle-flow.ts";

export function voteSigner(privateKey: string | undefined, source = "SLA_ORACLE_PRIVATE_KEY"): KeyPairSigner {
  if (!privateKey?.startsWith("ed25519:")) {
    throw new Error("Supply a dedicated oracle key through " + source);
  }
  try {
    return KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
  } catch {
    throw new Error("Supply a dedicated oracle key through " + source);
  }
}

export function requireVotePermission(permission: unknown, contractId: string) {
  if (typeof permission !== "object" || !permission || !("FunctionCall" in permission)) {
    throw new Error("Use a function-call key scoped to submit_vote");
  }
  if (!scopedVotePermission(permission, contractId)) {
    throw new Error("The oracle key must have a positive bounded allowance and only permit submit_vote");
  }
}

export const voteAction = (vote: Vote) => actions.functionCall("submit_vote", { ...vote }, teraToGas("30"), 0n);

export async function prepareVoteSender(
  provider: JsonRpcProvider,
  contractId: string,
  oracle: string,
  privateKey: string | undefined,
): Promise<(vote: Vote) => Promise<string>> {
  const signer = voteSigner(privateKey);
  const { permission } = await provider.viewAccessKey({
    accountId: oracle,
    publicKey: await signer.getPublicKey(),
    finalityQuery: { finality: "final" },
  });
  requireVotePermission(permission, contractId);

  const account = new Account(oracle, provider, signer);
  return async (vote) => {
    const result = await account.signAndSendTransaction({
      receiverId: contractId,
      actions: [voteAction(vote)],
      waitUntil: "FINAL",
      retries: 0,
    });
    return result.transaction_outcome.id;
  };
}
