import { boundedJson } from "./http-json.ts";
import { isBase58Hash, isRecord, isSandboxNetwork, isU64 } from "./oracle-protocol.ts";

export const defaultTestnetRpc = "https://test.rpc.fastnear.com";

export class NetworkMismatch extends Error {}

export function nearRpc(rpcUrl: string, network: string, signal?: AbortSignal, genesis?: string) {
  const url = new URL(rpcUrl);
  const sandbox = isSandboxNetwork(network);
  if (url.username || url.password || url.hash
      || (sandbox ? (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
        : (url.protocol !== "https:" || network !== "testnet"))) {
    throw new Error("Expected an HTTPS Testnet RPC or a local Sandbox RPC");
  }

  async function request(method: string, params: unknown) {
    const timeout = AbortSignal.timeout(method === "send_tx" ? 8000 : 5000);
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sla-sentinel", method, params }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error("NEAR RPC HTTP " + response.status), { httpStatus: response.status });
    }
    const envelope = await boundedJson(response, 100_000);
    if (!isRecord(envelope) || envelope.id !== "sla-sentinel" || envelope.jsonrpc !== "2.0") {
      throw new Error("Invalid NEAR RPC envelope");
    }
    return envelope;
  }

  async function result(method: string, params: unknown) {
    const envelope = await request(method, params);
    if (envelope.error !== undefined || !isRecord(envelope.result) || envelope.result.error !== undefined) {
      let cause = isRecord(envelope.error) && isRecord(envelope.error.cause) ? envelope.error.cause.name : undefined;
      if (sandbox && method === "query" && isRecord(params) && params.request_type === "view_access_key"
          && isRecord(envelope.result) && envelope.result.error === `access key ${params.public_key} does not exist while viewing`) {
        cause = "UNKNOWN_ACCESS_KEY";
      }
      throw Object.assign(new Error("NEAR RPC could not read " + method), { rpcCause: cause });
    }
    return envelope.result;
  }

  async function query(blockId: string, params: object) {
    const view = await result("query", { ...params, block_id: blockId });
    if (view.block_hash !== blockId) throw new Error("NEAR RPC returned a different block");
    return view;
  }

  let checkedNetworkAt = 0;
  async function checkNetwork() {
    const age = Date.now() - checkedNetworkAt;
    if (!genesis && checkedNetworkAt && age >= 0 && age < 60_000) return;
    const status = await result("status", []);
    if (status.chain_id !== network || (genesis && status.genesis_hash !== genesis)) {
      throw new NetworkMismatch("Unexpected NEAR network or genesis");
    }
    checkedNetworkAt = Date.now();
  }

  async function blockAt(blockId?: string) {
    const { header } = await result("block", blockId === undefined ? { finality: "final" } : { block_id: blockId });
    if (!isRecord(header) || !isBase58Hash(header.hash) || (blockId && header.hash !== blockId) || !isU64(header.timestamp_nanosec)) {
      throw new Error("Invalid finalized block");
    }
    const time = Number(BigInt(header.timestamp_nanosec) / 1_000_000n);
    const clockSkewMs = Date.now() - time;
    if (!blockId && Math.abs(clockSkewMs) > 60_000) throw new Error("Finalized RPC block or local clock is stale");
    return { time, blockHash: header.hash, clockSkewMs };
  }

  async function block(blockId?: string) {
    await checkNetwork();
    return blockAt(blockId);
  }

  const finalizedBlock = () => block();

  async function callAtBlock(blockHash: string, contract: string, method: string, args: Record<string, unknown>) {
    const view = await query(blockHash, {
      request_type: "call_function", account_id: contract, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (!Array.isArray(view.result) || view.result.length > 24_000
        || !view.result.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new Error("Invalid contract return bytes");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(view.result))) as unknown;
  }

  async function readAgreement(contract: string, slaId: string) {
    const block = await finalizedBlock();
    const [account, agreement] = await Promise.all([
      query(block.blockHash, { request_type: "view_account", account_id: contract }),
      callAtBlock(block.blockHash, contract, "get_sla", { sla_id: slaId }),
    ]);
    if (!isBase58Hash(account.code_hash) || account.code_hash === "1".repeat(32)) throw new Error("Invalid contract code hash");
    return { ...block, codeHash: account.code_hash, agreement };
  }

  return { request, checkNetwork, readAgreement, query, finalizedBlock, block, blockAt, callAtBlock };
}

export function scopedVotePermission(permission: unknown, contract: string) {
  const access = isRecord(permission) ? permission.FunctionCall : undefined;
  return isRecord(access) && access.receiver_id === contract && Array.isArray(access.method_names)
    && access.method_names.length === 1 && access.method_names[0] === "submit_vote"
    && typeof access.allowance === "string" && /^[1-9][0-9]{0,38}$/.exec(access.allowance)?.[0] === access.allowance;
}
