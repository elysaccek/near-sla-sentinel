import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isAudience, isNearPublicKey, isNetworkAccount, isRecord, isUuid } from "../../../shared/oracle-protocol.ts";

export function controlOrigin(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS Master origin or http://127.0.0.1 for local testing");
  }
  return url.origin;
}

export function fileError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function readWorkerFile(path: string, maxBytes: number, privateOnly = true) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & (privateOnly ? 0o077 : 0o022)) !== 0 || stat.size > maxBytes) {
      throw new Error(privateOnly ? "Use a private, owner-only file" : "Use an owner-controlled public key file");
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error("Private file exceeds its expected size");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export async function privateDirectory(path: string) {
  const directory = resolve(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("The worker state directory must be owned by the worker and mode 0700");
  }
  return directory;
}

export async function writePrivateFile(path: string, data: string, mode: "create" | "replace" = "create") {
  const temp = path + "." + randomUUID() + ".tmp";
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally { await file.close(); }
    if (mode === "replace") await rename(temp, path);
    else await link(temp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally {
    await unlink(temp).catch((error) => { if (!fileError(error, "ENOENT")) throw error; });
  }
}

interface IdentityProfile {
  master: string;
  audience: string;
  network: string;
  near_account: string;
  near_public_key: string;
}

export interface WorkerIdentity extends IdentityProfile {
  node_id: string;
  identity_key: string;
  sign: (message: string) => string;
}

export async function loadIdentity(directory: string, profile?: IdentityProfile): Promise<WorkerIdentity> {
  const path = join(directory, "identity.json");
  if (profile && (!isNetworkAccount(profile.near_account, profile.network) || !isNearPublicKey(profile.near_public_key) || !isAudience(profile.audience)
      || controlOrigin(profile.master) !== profile.master)) {
    throw new Error("Invalid Master audience, origin or named NEAR Testnet account");
  }
  let record: unknown;
  try { record = JSON.parse((await readWorkerFile(path, 4096)).toString("utf8")); }
  catch (error) {
    if (!profile || !fileError(error, "ENOENT")) throw error;
    const { privateKey } = generateKeyPairSync("ed25519");
    const data = {
      version: 1, ...profile, node_id: randomUUID(),
      private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
    try { await writePrivateFile(path, JSON.stringify(data)); }
    catch (conflict) { if (!fileError(conflict, "EEXIST")) throw conflict; }
    record = JSON.parse((await readWorkerFile(path, 4096)).toString("utf8"));
  }
  if (!isRecord(record) || record.version !== 1 || !isUuid(record.node_id)
      || typeof record.network !== "string" || !isNetworkAccount(record.near_account, record.network) || !isNearPublicKey(record.near_public_key)
      || !isAudience(record.audience) || typeof record.master !== "string"
      || controlOrigin(record.master) !== record.master || typeof record.private_key !== "string") {
    throw new Error("Invalid stored node identity");
  }
  if (profile && (record.master !== profile.master || record.audience !== profile.audience || record.network !== profile.network
      || record.near_account !== profile.near_account || record.near_public_key !== profile.near_public_key)) {
    throw new Error("The existing identity is bound to another Master or NEAR key");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(record.private_key, "base64"), format: "der", type: "pkcs8" });
  } catch { throw new Error("Invalid stored node signing key"); }
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid stored node signing key");
  return {
    master: record.master, audience: record.audience, network: record.network, near_account: record.near_account,
    near_public_key: record.near_public_key, node_id: record.node_id,
    identity_key: publicKey.export({ format: "jwk" }).x!,
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString("base64url"),
  };
}
