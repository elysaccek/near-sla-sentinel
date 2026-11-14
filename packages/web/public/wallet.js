import { actions, baseDecode, baseEncode, createTransaction, PublicKey, Signature, SignedTransaction } from "near-api-js";

const methods = new Set(["create_sla", "accept_sla", "finalize", "claim"]);
const amountPattern = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,24}))?$/;
const u64 = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) < 2n ** 64n;
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const address = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function toYocto(value) {
  const match = amountPattern.exec(value);
  check(match, "Enter an amount with at most 24 decimal places.");
  const result = BigInt(match[1] + (match[2] ?? "").padEnd(24, "0"));
  check(result > 0n && result < 2n ** 128n, "Enter a positive amount within the escrow limit.");
  return result.toString();
}

export const targetHash = async (endpoint) => Array.from(await digest(new TextEncoder().encode(endpoint)));

function walletStore(mode, operation) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("sla-sentinel-sandbox-wallets", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("accounts", { keyPath: "genesis" });
    opening.onerror = () => reject(new Error("Could not open Sandbox wallet storage."));
    opening.onblocked = () => reject(new Error("Close other console tabs and retry wallet storage."));
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("accounts", mode);
      const request = operation(tx.objectStore("accounts"));
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Could not update Sandbox wallet storage.")); };
    };
  });
}

export async function openSandboxWallet(genesis, create = false) {
  const existing = await walletStore("readonly", (store) => store.get(genesis));
  if (existing) return existing;
  if (!create) return null;
  check(window.isSecureContext && crypto.subtle, "Open the local console in a browser that supports Web Crypto.");
  let key;
  try { key = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]); }
  catch { throw new Error("This browser does not support Ed25519 signing. Try a current version of Chromium or Firefox."); }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const wallet = {
    genesis, account: hex(publicKey), public_key: "ed25519:" + baseEncode(publicKey), privateKey: key.privateKey,
  };
  try { await walletStore("readwrite", (store) => store.add(wallet)); }
  catch (error) {
    const saved = await walletStore("readonly", (store) => store.get(genesis));
    if (saved) return saved;
    throw error;
  }
  return wallet;
}

export async function signEscrow({ wallet, chain, prepared, method, args, deposit }) {
  check(methods.has(method) && wallet.genesis === chain.genesis && address(wallet.account)
    && prepared.network === chain.network && prepared.genesis === chain.genesis && prepared.contract === chain.contract
    && prepared.code_hash === chain.code_hash && prepared.signer === wallet.account && prepared.public_key === wallet.public_key
    && prepared.method === method && same(prepared.args, args) && prepared.deposit === deposit,
  "The signing request differs from the reviewed terms or the connected Sandbox wallet.");
  const gas = method === "claim" ? "100000000000000" : "80000000000000";
  const blockHash = baseDecode(prepared.block_hash);
  check(prepared.gas === gas && u64(prepared.nonce) && blockHash.length === 32, "Invalid transaction preparation.");
  const key = PublicKey.from(wallet.public_key);
  const tx = createTransaction(wallet.account, key, chain.contract, BigInt(prepared.nonce),
    [actions.functionCall(method, args, BigInt(gas), BigInt(deposit))], blockHash);
  const hash = await digest(tx.encode());
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({ keyType: key.keyType, data: new Uint8Array(await crypto.subtle.sign("Ed25519", wallet.privateKey, hash)) }),
  });
  return { hash: baseEncode(hash), signed: btoa(String.fromCharCode(...signed.encode())) };
}

const pendingKey = (chain, account) => "sla-sentinel-pending:" + chain.genesis + ":" + chain.contract + ":" + account;

export const pendingTransaction = (chain, account) => JSON.parse(localStorage.getItem(pendingKey(chain, account)) ?? "null");

export function storePending(chain, pending) {
  check(!pendingTransaction(chain, pending.signer), "Check the pending transaction before signing another one.");
  localStorage.setItem(pendingKey(chain, pending.signer), JSON.stringify(pending));
}

export function clearPending(chain, pending) {
  if (pendingTransaction(chain, pending.signer)?.hash === pending.hash) {
    localStorage.removeItem(pendingKey(chain, pending.signer));
  }
}
