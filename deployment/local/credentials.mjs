import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { ensureFile } from "./files.mjs";

const persist = (path, value, group = 1000, mode = 0o600) => ensureFile(path, value, mode, [1000, group]);

const token = () => randomBytes(32).toString("base64url");
await persist("/data/postgres-auth/password", token(), 999, 0o640);
await persist("/data/master-auth/database-password", token());
const consoleToken = await persist("/data/console-auth/console-token", token());
const bootstrapToken = await persist("/data/bootstrap-auth/token", token());
const admins = {
  console: consoleToken.toString("utf8"),
  bootstrap: bootstrapToken.toString("utf8"),
};
const persisted = JSON.parse((await persist("/data/master-auth/admins.json", JSON.stringify(admins))).toString("utf8"));
if (persisted.console !== admins.console || persisted.bootstrap !== admins.bootstrap) {
  throw new Error("Local Master credentials differ from the saved admin file");
}
const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
const saved = await persist("/data/master-auth/assignment-private.der", privateKey);
const publicKey = createPublicKey(createPrivateKey({ key: saved, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
if (!(await persist("/data/assignment-public/key.der", publicKey)).equals(publicKey)) {
  throw new Error("Local assignment verification key differs from the saved signing key");
}
