import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { DoesNotTrackShardError, TransactionTimeoutError, UnknownTransactionError, UnknownTransactionOrReceiptError } from "near-api-js/rpc-errors";
import { defaultTestnetRpc, nearRpc } from "../../../shared/near-rpc.ts";
import { isRecord } from "../../../shared/oracle-protocol.ts";
import { verifyWorkerProof, workerProofGenesis } from "../settlement/worker-proof.ts";

const archive = "https://archival-rpc.testnet.near.org";
const maximum = 1_048_576;

async function readWithArchive<T>(operation: () => Promise<T>, archival: () => Promise<T>) {
  try { return await operation(); }
  catch (error) {
    const temporary = error instanceof TypeError || error instanceof TransactionTimeoutError
      || error instanceof Error && error.name === "TimeoutError";
    const archived = error instanceof UnknownTransactionError || error instanceof UnknownTransactionOrReceiptError || error instanceof DoesNotTrackShardError
      || isRecord(error) && ([429, 502, 503, 504].includes(Number(error.httpStatus))
        || error.type === "RetriesExceeded"
        || ["UNKNOWN_BLOCK", "GARBAGE_COLLECTED_BLOCK", "UNAVAILABLE_SHARD"].includes(String(error.rpcCause)));
    if (!temporary && !archived) throw error;
  }
  for (const delay of [1000, 3000]) {
    try { return await archival(); }
    catch (error) {
      if (!isRecord(error) || error.httpStatus !== 429) throw error;
      await sleep(delay);
    }
  }
  return archival();
}

async function readProof(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const { size } = stat;
    if (!stat.isFile() || size === 0 || size > maximum) throw new Error("Provide a JSON proof file of at most 1 MiB");
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size) throw new Error("Proof file changed during reading");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))) as unknown;
  } finally { await file.close(); }
}

async function main() {
  const { values: { proof } } = parseArgs({ options: { proof: { type: "string" } } });
  if (!proof) throw new Error("Use --proof FILE with a Testnet worker recovery proof");
  const data = await readProof(proof);
  const genesis = workerProofGenesis(data);
  const primary = nearRpc(defaultTestnetRpc, "testnet", undefined, genesis);
  const history = nearRpc(archive, "testnet", undefined, genesis);
  const rpc = new JsonRpcProvider({ url: defaultTestnetRpc }, { retries: 2 });
  const archiveRpc = new JsonRpcProvider({ url: archive }, { retries: 3 });
  let checkedPrimary = false;
  let checkedArchive = false;
  async function verifyPrimary() {
    if (checkedPrimary) return;
    await primary.checkNetwork();
    checkedPrimary = true;
  }
  async function verifyArchive() {
    if (checkedArchive) return;
    await history.checkNetwork();
    checkedArchive = true;
  }
  function read<T>(primaryCall: () => Promise<T>, archiveCall: () => Promise<T>) {
    return readWithArchive(async () => {
      await verifyPrimary();
      return primaryCall();
    }, async () => {
      await verifyArchive();
      return archiveCall();
    });
  }
  const result = await verifyWorkerProof(data, {
    checkNetwork: () => readWithArchive(verifyPrimary, verifyArchive),
    block: (hash) => read(() => primary.blockAt(hash), () => history.blockAt(hash)),
    query: (hash, args) => read(() => primary.query(hash, args), () => history.query(hash, args)),
    callAtBlock: (hash, contract, method, args) =>
      read(() => primary.callAtBlock(hash, contract, method, args), () => history.callAtBlock(hash, contract, method, args)),
    transaction(accountId, txHash) {
      const args = { accountId, txHash, waitUntil: "FINAL" } as const;
      return read(() => rpc.viewTransactionStatus(args), () => archiveRpc.viewTransactionStatus(args));
    },
    receipts(accountId, txHash) {
      const args = { accountId, txHash, waitUntil: "FINAL" } as const;
      return read(async () => {
        const result = await rpc.viewTransactionStatusWithReceipts(args);
        if (!("receipts" in result) || !Array.isArray(result.receipts) || !result.receipts.length) {
          throw Object.assign(new Error("NEAR RPC did not return receipt details"), { rpcCause: "UNAVAILABLE_SHARD" });
        }
        return result;
      }, () => archiveRpc.viewTransactionStatusWithReceipts(args));
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Worker proof verification failed");
  process.exitCode = 1;
});
