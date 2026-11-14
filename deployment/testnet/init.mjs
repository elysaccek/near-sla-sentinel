import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { ensureFile } from "./files.mjs";
import { demoRoles } from "../../shared/testnet-demo.ts";

const token = () => randomBytes(32).toString("base64url");
await ensureFile("/postgres-auth/password", token(), 0o640, [1000, 999]);
const persist = (path, value) => ensureFile(path, value, 0o600, [1000, 1000]);
await persist("/master-auth/database-password", token());
const legacy = await readFile("/registry/operator", "utf8").catch(error => {
  if (error.code !== "ENOENT") throw error;
});
const operator = (await persist("/admin-access/operator", legacy ?? token())).toString("utf8");
const admins = JSON.parse((await persist("/master-auth/admins.json", JSON.stringify({ fixture: operator }))).toString("utf8"));
if (admins.fixture !== operator) throw new Error("Saved demo Master credentials disagree");
if (legacy) await unlink("/registry/operator");
const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
const saved = await persist("/master-auth/assignment-private.der", privateKey);
const publicKey = createPublicKey(createPrivateKey({ key: saved, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
if (!(await persist("/registry/assignment-public.der", publicKey)).equals(publicKey)) {
  throw new Error("Saved demo assignment keys disagree");
}
for (const role of demoRoles) {
  const observer = await persist("/observers/" + role + "/observer-token", token());
  if (!(await persist("/states/" + role + "/observer-token", observer)).equals(observer)) {
    throw new Error("Saved observer credentials disagree");
  }
}
