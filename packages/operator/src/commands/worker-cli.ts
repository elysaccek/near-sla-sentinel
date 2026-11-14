import { cpus, platform, totalmem } from "node:os";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { baseDecode } from "near-api-js";
import { approvedEndpoint, isAudience, isBase58Hash, isLoopbackOrigin, isNetworkAccount, isSandboxNetwork, isU64, loopbackHealth } from "../../../shared/oracle-protocol.ts";
import { defaultTestnetRpc } from "../../../shared/near-rpc.ts";
import { voteSigner } from "../oracles/oracle-signer.ts";
import { controlOrigin, fileError, loadIdentity, privateDirectory, readWorkerFile } from "../worker/identity.ts";
import { masterVerifiers, masterClient, workerVersion } from "../worker/master-client.ts";
import { nearWorker } from "../worker/near.ts";
import { workerRunner } from "../worker/runner.ts";
import { lockWorker, openWorkerStore } from "../worker/store.ts";

const help = `SLA Sentinel oracle worker
  join --master URL --oracle ACCOUNT --state-dir DIR [--invite-file FILE] [--audience ID] [--region LABEL]
  run --state-dir DIR --assignment-pub FILE --contract ACCOUNT --code-hash BASE58 --endpoint URL [--endpoint URL ...] [--control-endpoint URL ...]
  status --state-dir DIR
  evidence --state-dir DIR --contract ACCOUNT --sla-id ID

Set SLA_WORKER_VOTE_KEY_FILE to the private, owner-only scoped NEAR key file.
Set SLA_WORKER_TESTNET_RPC_URL for a custom HTTPS Testnet RPC.
Local Sandbox only: set SLA_WORKER_SANDBOX_NETWORK and SLA_WORKER_SANDBOX_RPC_URL. Use --demo-faults to accept signed Sandbox fault plans.
Use --evidence-export-dir DIR to export finalized local evidence to a separate owner-only directory.`;

async function keyFile() {
  const path = process.env.SLA_WORKER_VOTE_KEY_FILE;
  if (!path) throw new Error("Set SLA_WORKER_VOTE_KEY_FILE");
  return voteSigner((await readWorkerFile(resolve(path), 512)).toString("utf8").trim(), "SLA_WORKER_VOTE_KEY_FILE");
}

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" }, master: { type: "string" }, audience: { type: "string" }, oracle: { type: "string" },
      "state-dir": { type: "string" }, "invite-file": { type: "string" }, region: { type: "string" },
      "assignment-pub": { type: "string" }, contract: { type: "string" }, "code-hash": { type: "string" },
      endpoint: { type: "string", multiple: true }, "sla-id": { type: "string" },
      "control-endpoint": { type: "string", multiple: true }, "demo-faults": { type: "boolean" },
      "evidence-export-dir": { type: "string" },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (positionals.length !== 1 || !["join", "status", "evidence", "run"].includes(command) || !values["state-dir"]) {
    throw new Error(help);
  }
  const sandboxNetwork = process.env.SLA_WORKER_SANDBOX_NETWORK;
  const sandboxRpc = process.env.SLA_WORKER_SANDBOX_RPC_URL;
  if ((sandboxNetwork || sandboxRpc) && (!sandboxNetwork || !isSandboxNetwork(sandboxNetwork) || !sandboxRpc || !isLoopbackOrigin(sandboxRpc))) {
    throw new Error("Local Sandbox mode requires the Sandbox network and loopback RPC");
  }
  const network = sandboxNetwork ?? "testnet";
  const sandbox = isSandboxNetwork(network);
  if (values["demo-faults"] && (!sandbox || command !== "run")) {
    throw new Error("--demo-faults requires a local Sandbox worker");
  }
  const directory = await privateDirectory(values["state-dir"]);
  const exportDir = values["evidence-export-dir"];
  let evidenceDirectory;
  if (exportDir !== undefined) {
    if (!exportDir || !sandbox || command !== "run") throw new Error("Evidence export requires a local Sandbox worker");
    const path = resolve(exportDir);
    if (path === directory || path.startsWith(directory + sep) || directory.startsWith(path + sep)) {
      throw new Error("Use a separate directory for evidence exports");
    }
    evidenceDirectory = await privateDirectory(path);
  }

  if (command === "join") {
    const { master, oracle, region } = values;
    if (!master || !isNetworkAccount(oracle, network) || (region !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9._ +:/-]{0,119}$/.test(region.trim()))) {
      throw new Error("Provide --master, an --oracle account for this network, and an optional region label");
    }
    const origin = controlOrigin(master);
    if (sandbox && !isLoopbackOrigin(origin)) throw new Error("Use a loopback Master for Sandbox");
    const audience = values.audience ?? origin;
    if (!isAudience(audience)) throw new Error("Invalid Master audience");
    const signer = await keyFile();
    const identity = await loadIdentity(directory, {
      master: origin, audience, network, near_account: oracle, near_public_key: (await signer.getPublicKey()).toString(),
    });
    const file = values["invite-file"];
    let code = "";
    if (file) {
      try { code = (await readWorkerFile(resolve(file), 256)).toString("utf8").trim(); }
      catch (error) { if (!fileError(error, "ENOENT")) throw error; }
    }
    const status = await masterClient(identity).join(code, {
      version: workerVersion, os: platform(), cpu: cpus().length + " logical",
      ram: Math.round(totalmem() / 1024 / 1024) + " MiB", ...(region ? { region: region.trim() } : {}),
    });
    const store = openWorkerStore(directory);
    try { store.setRegistration(status); }
    finally { store.close(); }
    console.log(JSON.stringify({ node_id: identity.node_id, near_account: oracle, status }));
    return;
  }

  const identity = await loadIdentity(directory);
  if (identity.network !== network) throw new Error("The worker identity belongs to a different network");
  if (sandbox && !isLoopbackOrigin(identity.master)) throw new Error("Use a loopback Master for Sandbox");
  if (command === "status") {
    const store = openWorkerStore(directory);
    try {
      console.log(JSON.stringify({ node_id: identity.node_id, near_account: identity.near_account, ...store.summary() }, null, 2));
    } finally { store.close(); }
    return;
  }
  if (command === "evidence") {
    const slaId = values["sla-id"];
    if (!isNetworkAccount(values.contract, network) || !isU64(slaId)) throw new Error("Provide --contract and --sla-id");
    const store = openWorkerStore(directory);
    try {
      const { evidence } = store.getTask([network, values.contract, slaId].join(":"));
      if (!evidence) throw new Error("Evidence is not ready");
      console.log(JSON.stringify(evidence, null, 2));
    } finally { store.close(); }
    return;
  }
  const { contract, "code-hash": codeHash, endpoint, "assignment-pub": assignmentPub } = values;
  if (!isNetworkAccount(contract, network) || !isBase58Hash(codeHash) || baseDecode(codeHash).length !== 32 || codeHash === "1".repeat(32)
      || !endpoint?.length || !assignmentPub) throw new Error(help);
  const signer = await keyFile();
  if ((await signer.getPublicKey()).toString() !== identity.near_public_key) {
    throw new Error("The worker vote key differs from the registered public key");
  }
  const endpoints = new Set(endpoint.map((url) => approvedEndpoint(url, sandbox && url === loopbackHealth)));
  const controls = [...new Set(values["control-endpoint"] ?? [])];
  const verifiers = masterVerifiers(identity, await readWorkerFile(resolve(assignmentPub), 256, false));
  const controller = new AbortController();
  const chain = nearWorker(sandboxRpc ?? process.env.SLA_WORKER_TESTNET_RPC_URL ?? defaultTestnetRpc, identity.near_account, signer, network, controller.signal);
  const release = lockWorker(directory);
  try {
    const store = openWorkerStore(directory);
    try {
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      console.log("Oracle worker " + identity.node_id + " running");
      try {
        await workerRunner({
          store, chain, identity, targets: { network, contract, codeHash, endpoints }, verify: verifiers.assignment,
          controls, verifyFault: values["demo-faults"] ? verifiers.fault : undefined,
          evidenceDirectory,
          signal: controller.signal, event: (event) => console.log(event),
        }).run();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    } finally { store.close(); }
  } finally { release(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Oracle worker failed");
  process.exitCode = 1;
});
