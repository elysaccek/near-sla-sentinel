import { parseArgs } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { verifySettlement } from "../settlement/settlement.ts";
import type { SettlementState, TransactionTrace } from "../settlement/settlement.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    contract: { type: "string" },
    customer: { type: "string" },
    "sla-id": { type: "string" },
    tx: { type: "string" },
  } });
  const { contract, customer, "sla-id": slaId, tx: transactionHash } = values;
  if (!contract?.endsWith(".testnet") || !customer?.endsWith(".testnet")
      || !slaId || !/^(0|[1-9][0-9]{0,19})$/.test(slaId) || BigInt(slaId) >= (1n << 64n)
      || !transactionHash || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(transactionHash)) {
    throw new Error("Provide Testnet --contract and --customer, --sla-id, and the claim --tx hash");
  }
  const provider = new JsonRpcProvider({ url: "https://archival-rpc.testnet.near.org" });
  if (await provider.getNetworkId() !== "testnet") {
    throw new Error("RPC endpoint is not on Testnet");
  }
  const trace = await provider.viewTransactionStatusWithReceipts({
    accountId: customer,
    txHash: transactionHash,
    waitUntil: "FINAL",
  });
  const state = await provider.callFunction<SettlementState>({
    contractId: contract,
    method: "get_sla",
    args: { sla_id: slaId },
    blockQuery: { finality: "final" },
  });
  if (!state || state.customer !== customer) {
    throw new Error("Agreement or customer does not match");
  }
  const settlement = verifySettlement({ contract, slaId, transactionHash }, state, trace as unknown as TransactionTrace);
  console.log(JSON.stringify({ network: "testnet", ...settlement }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Settlement verification failed");
  process.exitCode = 1;
});
