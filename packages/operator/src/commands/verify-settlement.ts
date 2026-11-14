import { parseArgs } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { verifySettlement } from "../settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../settlement/settlement.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    contract: { type: "string" },
    customer: { type: "string" },
    provider: { type: "string" },
    "sla-id": { type: "string" },
    tx: { type: "string" },
    "policy-version": { type: "string", default: "1" },
    kind: { type: "string", default: "compensation" },
  } });
  const { contract, customer, provider: supplier, "sla-id": slaId, tx: transactionHash, kind } = values;
  const policyVersion = values["policy-version"];
  if (policyVersion !== "1" && policyVersion !== "2") {
    throw new Error("Use --policy-version 1 or 2");
  }
  if (kind !== "compensation" && kind !== "refund") throw new Error("Use --kind compensation or refund");
  const beneficiary = kind === "compensation" ? customer : supplier;
  const beneficiaryOption = kind === "compensation" ? "--customer" : "--provider";
  if (!contract?.endsWith(".testnet") || !beneficiary?.endsWith(".testnet")
      || !slaId || !/^(0|[1-9][0-9]{0,19})$/.test(slaId) || BigInt(slaId) >= (1n << 64n)
      || !transactionHash || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(transactionHash)) {
    throw new Error(`Provide Testnet --contract and ${beneficiaryOption}, --sla-id, and the claim --tx hash`);
  }
  const provider = new JsonRpcProvider({ url: "https://archival-rpc.testnet.near.org" });
  if (await provider.getNetworkId() !== "testnet") {
    throw new Error("RPC endpoint is not on Testnet");
  }
  const trace = await provider.viewTransactionStatusWithReceipts({
    accountId: beneficiary,
    txHash: transactionHash,
    waitUntil: "FINAL",
  });
  const state = await provider.callFunction<SettlementState>({
    contractId: contract,
    method: "get_sla",
    args: { sla_id: slaId },
    blockQuery: { finality: "final" },
  });
  if (!state || (kind === "compensation" ? state.customer : state.provider) !== beneficiary) {
    throw new Error("Agreement or settlement beneficiary does not match");
  }
  const settlement = verifySettlement({
    contract, slaId, transactionHash, kind, policyVersion: policyVersion === "1" ? 1 : 2,
  }, state, trace as unknown as TransactionTrace);
  console.log(JSON.stringify({ network: "testnet", ...settlement }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Settlement verification failed");
  process.exitCode = 1;
});
