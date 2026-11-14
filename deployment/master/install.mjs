import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import { createFile, install, privateDirectory, projectName, readOptional, rpcUrl, tcpPort } from "../install-common.mjs";

const defaultRpc = "https://test.rpc.fastnear.com";

function validate({ project, domain, bind, httpPort, httpsPort, rpc }) {
  projectName(project);
  if (domain.length > 180 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw new Error("Provide a lower-case DNS name without a scheme, path or port");
  }
  tcpPort(httpPort);
  tcpPort(httpsPort);
  if (isIP(bind) !== 4 || httpPort === httpsPort) throw new Error("Provide an IPv4 bind address and two distinct TCP ports");
  rpcUrl(rpc);
}

await install("master", async ({ dir, credentials, ask, saved, compose, writeConfig, defaultProject, checkProject }) => {
  const values = saved ?? {
    project: await ask("Compose project name", defaultProject),
    domain: await ask("Master DNS name"),
    rpc: await ask("Testnet RPC URL", defaultRpc),
    bind: await ask("Bind IPv4 address", "0.0.0.0"),
    httpPort: await ask("HTTP port", "80"),
    httpsPort: await ask("HTTPS port", "443"),
  };
  validate(values);
  await checkProject(values.project);
  await privateDirectory(dir);
  await privateDirectory(credentials);
  for (const name of ["postgres-password", "database-password", "operator-token"]) {
    const path = join(credentials, name);
    const existing = await readOptional(path, 256);
    if (existing && !/^[A-Za-z0-9_-]{43,128}\n?$/.test(existing.toString("utf8"))) throw new Error("Invalid saved " + name);
    if (!existing) {
      if (saved) throw new Error("Restore the missing " + name + " from backup");
      await createFile(path, randomBytes(32).toString("base64url") + "\n");
    }
  }
  const token = (await readOptional(join(credentials, "operator-token"), 256)).toString("utf8").trim();
  const adminPath = join(credentials, "admins.json");
  const admins = await readOptional(adminPath, 8192);
  if (admins) {
    let parsed;
    try { parsed = JSON.parse(admins.toString("utf8")); }
    catch { throw new Error("Invalid saved admin file"); }
    if (parsed?.operator !== token) throw new Error("Saved admin files disagree");
  } else {
    if (saved) throw new Error("Restore the missing admin file from backup");
    await createFile(adminPath, JSON.stringify({ operator: token }) + "\n");
  }
  const signingPath = join(credentials, "assignment-private.der");
  let signing = await readOptional(signingPath, 256);
  if (!signing) {
    if (saved || await readOptional(join(credentials, "assignment-public.der"), 256)) {
      throw new Error("Restore the original assignment signing key from backup");
    }
    signing = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
    await createFile(signingPath, signing);
  }
  const key = createPrivateKey({ key: signing, format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid saved assignment key");
  await createFile(join(credentials, "assignment-public.der"), createPublicKey(key).export({ format: "der", type: "spki" }));
  await writeConfig(values, {
    SLA_MASTER_DOMAIN: values.domain, SLA_MASTER_CREDENTIALS: credentials,
    SLA_BIND_IP: values.bind, SLA_HTTP_PORT: values.httpPort, SLA_HTTPS_PORT: values.httpsPort,
    SLA_MASTER_TESTNET_RPC_URL: rpcUrl(values.rpc),
  });
  await compose(values.project, ["up", "--build", "-d", "--wait", "--wait-timeout", "120"]);
  const origin = `https://${values.domain}${values.httpsPort === "443" ? "" : ":" + values.httpsPort}`;
  console.log("Master services started for " + origin);
  console.log("Assignment public key " + join(credentials, "assignment-public.der"));
  const publicHealth = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(5000), redirect: "error" }).catch(() => null);
  if (publicHealth?.ok) console.log("HTTPS health check passed");
  else console.log("Check DNS and HTTPS readiness at " + origin + "/healthz");
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
