import { Account, actions, KeyPairSigner, teraToGas } from "near-api-js";
import type { JsonRpcProvider, KeyPairString } from "near-api-js";
import type { Vote } from "./oracle-flow.ts";

export async function prepareVoteSender(
  provider: JsonRpcProvider,
  contractId: string,
  oracle: string,
  privateKey: string | undefined,
): Promise<(vote: Vote) => Promise<string>> {
  if (!privateKey?.startsWith("ed25519:")) {
    throw new Error("Set SLA_ORACLE_PRIVATE_KEY to the dedicated oracle key");
  }
  let signer: KeyPairSigner;
  try {
    signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
  } catch {
    throw new Error("Set SLA_ORACLE_PRIVATE_KEY to the dedicated oracle key");
  }

  const { permission } = await provider.viewAccessKey({
    accountId: oracle,
    publicKey: await signer.getPublicKey(),
    finalityQuery: { finality: "final" },
  });
  if (typeof permission !== "object" || !permission || !("FunctionCall" in permission)) {
    throw new Error("Use a function-call key scoped to submit_vote");
  }
  const access = permission.FunctionCall;
  if (access.receiver_id !== contractId || access.method_names.length !== 1
      || access.method_names[0] !== "submit_vote" || !access.allowance || BigInt(access.allowance) <= 0n) {
    throw new Error("The oracle key must have a positive bounded allowance and only permit submit_vote");
  }

  const account = new Account(oracle, provider, signer);
  return async (vote) => {
    const result = await account.signAndSendTransaction({
      receiverId: contractId,
      actions: [actions.functionCall("submit_vote", { ...vote }, teraToGas("30"), 0n)],
      waitUntil: "FINAL",
      retries: 0,
    });
    return result.transaction_outcome.id;
  };
}
