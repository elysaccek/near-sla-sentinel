import { createHash } from "node:crypto";
import { baseDecode, baseEncode, SignedTransaction } from "near-api-js";
import { isBase58Hash, isNearPublicKey, isNetworkAccount, isRecord, isU64, policyFromAgreement } from "../../shared/oracle-protocol.ts";

const gas = 80_000_000_000_000n;
const claimGas = 100_000_000_000_000n;
const maxAge = 120_000;
const maxPayout = (1n << 128n) - 1n;
const methods = new Set(["create_sla", "accept_sla", "finalize", "claim"]);
const bytes = (encoded) => Buffer.from(encoded, "base64");

class WalletRequest extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message, status = 400) {
  if (!condition) throw new WalletRequest(status, message);
}

function fields(value, names) {
  requireValue(isRecord(value) && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name)), "Unexpected wallet request fields");
  return value;
}

function integer(value, min, max, label) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, "Invalid " + label);
  return value;
}

function yocto(value) {
  requireValue(typeof value === "string" && /^[1-9][0-9]{0,38}$/.test(value) && BigInt(value) <= maxPayout,
    "Use a positive NEAR amount with at most 24 decimal places");
  return BigInt(value);
}

function accountKey(chain, input) {
  const { account, public_key: key } = input;
  requireValue(isNetworkAccount(account, chain.network) && isNearPublicKey(key) && baseDecode(key.slice(8)).length === 32,
    "Use a Sandbox account and an Ed25519 public key");
  return { account, key };
}

export function walletRoutes(chain, rpc, verifyPayment) {
  async function escrowAt(blockHash) {
    const escrow = await rpc.query(blockHash, { request_type: "view_account", account_id: chain.contract });
    requireValue(escrow.code_hash === chain.code_hash, "The finalized escrow code has changed", 409);
  }

  async function accessAt(blockHash, account, key) {
    let view;
    try {
      view = await rpc.query(blockHash, { request_type: "view_access_key", account_id: account, public_key: key });
    } catch (error) {
      if (["UNKNOWN_ACCOUNT", "UNKNOWN_ACCESS_KEY"].includes(error.rpcCause)) {
        throw new WalletRequest(404, "The account or key is not registered on this Sandbox");
      }
      throw error;
    }
    requireValue(view.permission === "FullAccess", "This wallet key cannot sign an escrow transaction", 403);
    return view;
  }

  async function offer(input, signer, block, preparing) {
    const args = fields(input, [
      "customer", "oracles", "down_quorum", "endpoint_hash", "starts_at_ms", "slot_ms", "slot_count",
      "min_down_slots", "reporting_grace_ms", "payout",
    ]);
    const { customer, oracles, endpoint_hash: hash } = args;
    requireValue(isNetworkAccount(customer, chain.network) && customer !== signer
      && ![signer, customer].includes(chain.contract), "Provider and customer must be distinct Sandbox accounts");
    requireValue(Array.isArray(oracles) && oracles.length >= 3 && oracles.length <= 16
      && new Set(oracles).size === oracles.length
      && oracles.every((account) => isNetworkAccount(account, chain.network) && ![signer, customer, chain.contract].includes(account)),
    "Select 3 to 16 distinct oracles outside the agreement parties");
    integer(args.down_quorum, Math.floor(oracles.length / 2) + 1, oracles.length, "down quorum");
    integer(args.slot_ms, 1000, 3_600_000, "slot interval");
    integer(args.slot_count, 2, 64, "slot count");
    integer(args.min_down_slots, 2, args.slot_count, "consecutive outage length");
    integer(args.reporting_grace_ms, 1000, 86_400_000, "reporting grace");
    const payout = yocto(args.payout);
    const earliest = Math.max(block.time, Date.now()) + (preparing ? 15_000 : 0);
    requireValue(isU64(args.starts_at_ms) && Number(args.starts_at_ms) > earliest
      && Number(args.starts_at_ms) <= block.time + 604_800_000, "Choose a future start within the next seven days", 409);
    const expectedHash = createHash("sha256").update(chain.endpoint).digest();
    requireValue(Array.isArray(hash) && hash.length === 32 && hash.every((byte, index) => byte === expectedHash[index]),
      "The offer must use this Sandbox's configured target");
    const [storage] = await Promise.all([
      rpc.callAtBlock(block.blockHash, chain.contract, "storage_deposit", { oracle_count: oracles.length }),
      rpc.query(block.blockHash, { request_type: "view_account", account_id: customer }).catch((error) => {
        if (error.rpcCause === "UNKNOWN_ACCOUNT") throw new WalletRequest(404, "Fund the customer account on this Sandbox first");
        throw error;
      }),
    ]);
    const deposit = payout + yocto(storage);
    requireValue(deposit <= maxPayout, "Compensation plus storage exceeds the escrow limit");
    return { args, deposit, storage };
  }

  async function terms(method, input, account, block, preparing = false) {
    if (method === "create_sla") return offer(input, account, block, preparing);
    const args = fields(input, ["sla_id"]);
    requireValue(isU64(args.sla_id), "Use a valid SLA ID");
    const agreement = await rpc.callAtBlock(block.blockHash, chain.contract, "get_sla", args);
    requireValue(isRecord(agreement), "Agreement not found", 404);
    const policy = policyFromAgreement(agreement);
    const now = Math.max(block.time, Date.now());
    if (method === "accept_sla") {
      requireValue(account === agreement.customer, "Connect the customer named in the agreement", 403);
      requireValue(agreement.accepted === false && agreement.outcome === "undecided" && now < Number(policy.starts_at_ms),
        "The offer is already accepted or its acceptance window has closed", 409);
    } else if (method === "finalize") {
      const ready = agreement.accepted ? now >= Number(policy.reporting_deadline_ms)
        || (now >= Number(policy.ends_at_ms) && agreement.votes.every((vote) => vote.submitted))
        : now >= Number(policy.starts_at_ms);
      requireValue(ready && agreement.outcome === "undecided", "The agreement is not ready to finalize", 409);
    } else {
      const beneficiary = agreement.outcome === "breach" ? agreement.customer : agreement.provider;
      requireValue(account === beneficiary, "Connect the settlement beneficiary", 403);
      requireValue(agreement.payment === "claimable", "The agreement is not claimable", 409);
    }
    return { args, deposit: 0n };
  }

  async function account(input) {
    const { account, key } = accountKey(chain, fields(input, ["account", "public_key"]));
    const { blockHash } = await rpc.finalizedBlock();
    let registered = true;
    try { await accessAt(blockHash, account, key); }
    catch (error) {
      if (error instanceof WalletRequest && error.status === 404) registered = false;
      else throw error;
    }
    const view = registered ? await rpc.query(blockHash, { request_type: "view_account", account_id: account }) : null;
    return { account, registered, balance: view?.amount ?? "0" };
  }

  async function prepare(input) {
    const { account, key } = accountKey(chain, fields(input, ["account", "public_key", "method", "args"]));
    requireValue(methods.has(input.method), "Unsupported escrow action");
    const block = await rpc.finalizedBlock();
    const [, access] = await Promise.all([escrowAt(block.blockHash), accessAt(block.blockHash, account, key)]);
    const { args, deposit, storage } = await terms(input.method, input.args, account, block, true);
    if (deposit) {
      const { amount } = await rpc.query(block.blockHash, { request_type: "view_account", account_id: account });
      requireValue(typeof amount === "string" && BigInt(amount) > deposit,
        "The wallet balance must cover the deposit and gas", 409);
    }
    const nonce = access.nonce;
    requireValue(isU64(nonce) || (Number.isSafeInteger(nonce) && nonce >= 0), "Invalid finalized access key nonce", 503);
    return {
      network: chain.network, genesis: chain.genesis, contract: chain.contract, code_hash: chain.code_hash,
      signer: account, public_key: key, method: input.method, args, deposit: deposit.toString(), storage,
      gas: String(input.method === "claim" ? claimGas : gas),
      block_hash: block.blockHash, nonce: (BigInt(nonce) + 1n).toString(), prepared_at_ms: block.time,
    };
  }

  async function send(input) {
    const { signed } = fields(input, ["signed"]);
    requireValue(typeof signed === "string" && signed.length <= 4096 && bytes(signed).toString("base64") === signed,
      "Invalid signed transaction encoding");
    let signedTx;
    try { signedTx = SignedTransaction.decode(bytes(signed)); }
    catch { throw new WalletRequest(400, "Invalid signed transaction encoding"); }
    const tx = signedTx.transaction;
    const hash = createHash("sha256").update(tx.encode()).digest();
    const txHash = baseEncode(hash);
    const action = tx.actions[0]?.functionCall;
    requireValue(tx.receiverId === chain.contract && tx.actions.length === 1 && action && methods.has(action.methodName)
      && isNetworkAccount(tx.signerId, chain.network) && isNearPublicKey(tx.publicKey.toString())
      && signedTx.signature.signatureType === tx.publicKey.keyType
      && tx.publicKey.verify(hash, signedTx.signature.data), "Expected a valid signature for one supported escrow call");
    let args;
    try { args = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(action.args))); }
    catch { throw new WalletRequest(400, "Invalid escrow transaction arguments"); }
    const block = await rpc.finalizedBlock();
    await escrowAt(block.blockHash);
    const [, anchor] = await Promise.all([
      accessAt(block.blockHash, tx.signerId, tx.publicKey.toString()),
      rpc.block(baseEncode(Uint8Array.from(tx.blockHash))),
    ]);
    requireValue(block.time >= anchor.time && Math.max(block.time, Date.now()) - anchor.time <= maxAge,
      "This signature expired. Review the terms again.", 409);
    const valid = await terms(action.methodName, args, tx.signerId, block);
    requireValue(action.deposit === valid.deposit && action.gas === (action.methodName === "claim" ? claimGas : gas),
      "Unexpected gas or deposit for the signed escrow call");
    const { result, error } = await rpc.request("send_tx", { signed_tx_base64: signed, wait_until: "INCLUDED" });
    const cause = error?.cause?.name;
    if (cause === "INVALID_TRANSACTION" || cause === "REQUEST_ROUTED") {
      const observed = await status({ hash: txHash, signer: tx.signerId });
      if (cause === "INVALID_TRANSACTION" && observed.status === "unknown") {
        throw new WalletRequest(409, "The Sandbox rejected this transaction before inclusion");
      }
      return { hash: txHash };
    }
    requireValue(error === undefined && isRecord(result), "Sandbox RPC did not accept the signed transaction", 503);
    return { hash: txHash };
  }

  async function status(input) {
    const { hash, signer } = fields(input, ["hash", "signer"]);
    requireValue(isBase58Hash(hash) && baseDecode(hash).length === 32 && isNetworkAccount(signer, chain.network),
      "Provide a valid transaction and signer");
    await rpc.checkNetwork();
    const { result, error } = await rpc.request("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
    if (["UNKNOWN_TRANSACTION", "UNKNOWN_TRANSACTION_OR_RECEIPT"].includes(error?.cause?.name)) {
      return { status: "unknown", hash };
    }
    requireValue(error === undefined && isRecord(result), "Sandbox transaction status is unavailable", 503);
    if (result.final_execution_status !== "FINAL") return { status: "pending", hash };
    const tx = result.transaction;
    const call = tx?.actions?.[0]?.FunctionCall;
    requireValue(tx?.hash === hash && tx?.signer_id === signer && tx?.receiver_id === chain.contract
      && tx?.actions?.length === 1 && methods.has(call?.method_name) && result.transaction_outcome?.id === hash,
    "Final transaction does not match this escrow or signer", 409);
    if (isRecord(result.status) && Object.hasOwn(result.status, "Failure")) return { status: "failed", hash };
    requireValue(typeof result.status?.SuccessValue === "string", "Final transaction result is unavailable", 503);
    let id;
    if (call.method_name === "create_sla") {
      id = JSON.parse(bytes(result.status.SuccessValue).toString("utf8"));
    } else {
      id = JSON.parse(bytes(call.args).toString("utf8")).sla_id;
    }
    requireValue(isU64(id), "The finalized transaction did not return a valid SLA ID", 503);
    const snapshot = await rpc.readAgreement(chain.contract, id);
    if (snapshot.codeHash !== chain.code_hash || snapshot.agreement === null) {
      throw new WalletRequest(503, "Waiting for the finalized escrow state");
    }
    if (call.method_name === "create_sla") {
      const args = JSON.parse(bytes(call.args).toString("utf8"));
      requireValue(snapshot.agreement.provider === signer && Object.entries(args).every(([key, value]) =>
        key === "reporting_grace_ms"
          ? Number(snapshot.agreement.reporting_deadline_ms) - Number(snapshot.agreement.ends_at_ms) === value
          : JSON.stringify(snapshot.agreement[key]) === JSON.stringify(value)), "Finalized offer differs from the signed terms", 409);
    } else if (call.method_name === "accept_sla") {
      requireValue(snapshot.agreement.customer === signer && snapshot.agreement.accepted === true,
        "Finalized acceptance differs from the expected customer", 409);
    } else if (call.method_name === "claim") {
      const completed = bytes(result.status.SuccessValue).toString("utf8") === "true";
      requireValue(!completed || snapshot.agreement.payment === "paid", "Waiting for the finalized settlement state", 503);
      const payment = completed ? "paid" : snapshot.agreement.payment;
      const proof = completed ? await verifyPayment(id, signer, hash, snapshot.agreement) : undefined;
      return { status: "final", hash, sla_id: id, method: call.method_name, payment, proof };
    }
    return { status: "final", hash, sla_id: id, method: call.method_name };
  }

  return {
    async handle(route, body) {
      try {
        return { status: 200, value: await ({ account, prepare, send, status })[route](body) };
      } catch (error) {
        if (!(error instanceof WalletRequest)) throw error;
        return { status: error.status, value: { error: error.message } };
      }
    },
  };
}
