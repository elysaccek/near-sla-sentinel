import { createPublicKey } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { approvedEndpoint, isAudience, isBase58Hash, isNetworkAccount } from "../../packages/shared/oracle-protocol.ts";
import { createFile, install, privateDirectory, projectName, readFile, readOptional, rpcUrl } from "../install-common.mjs";

const defaultRpc = "https://test.rpc.fastnear.com";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Bytes(value) {
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  return value.match(/^1*/)[0].length + (number ? Math.ceil(number.toString(16).length / 2) : 0);
}

function masterOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS Master origin without credentials, a path or query");
  }
  return url.origin;
}

function validate({ project, master, audience, account, contract, codeHash, endpoint, control1, control2, rpc, region }) {
  projectName(project);
  masterOrigin(master);
  if (!isAudience(audience) || !isNetworkAccount(account, "testnet") || !isNetworkAccount(contract, "testnet")) {
    throw new Error("Provide a valid Master audience and named Testnet accounts");
  }
  if (!isBase58Hash(codeHash) || codeHash === "1".repeat(32) || base58Bytes(codeHash) !== 32) {
    throw new Error("Provide the finalized 32-byte Base58 contract code hash");
  }
  const endpoints = [endpoint, control1, control2].filter(Boolean);
  if (!endpoint || new Set(endpoints.map(value => new URL(approvedEndpoint(value)).hostname)).size !== endpoints.length) {
    throw new Error("Use distinct hostnames for the target and control URLs");
  }
  if (region && !/^[A-Za-z0-9][A-Za-z0-9._ +:/-]{0,119}$/.test(region)) throw new Error("Invalid region label");
  rpcUrl(rpc);
}

await install("oracle", async ({ dir, credentials, ask, saved, compose, writeConfig, defaultProject, checkProject }) => {
  let values = saved;
  if (!values) {
    const master = masterOrigin(await ask("Master HTTPS origin"));
    values = {
      master,
      project: await ask("Compose project name", defaultProject),
      audience: await ask("Master audience", new URL(master).protocol + "//" + new URL(master).hostname),
      account: await ask("Oracle Testnet account"),
      contract: await ask("V2 escrow Testnet account"),
      codeHash: await ask("Finalized escrow code hash"),
      endpoint: await ask("Approved target HTTPS URL"),
      control1: await ask("First control HTTPS URL (optional)"),
      control2: await ask("Second control HTTPS URL (optional)"),
      rpc: await ask("Testnet RPC URL", defaultRpc),
      region: await ask("Region label (optional)"),
    };
  }
  validate(values);
  await checkProject(values.project);
  const state = join(dir, "state");
  const voteFile = join(credentials, "vote-key");
  const publicFile = join(credentials, "assignment-public.der");
  const storedVote = await readOptional(voteFile, 512);
  const vote = storedVote ?? await readFile(await ask("Path to the private scoped vote key"), 512);
  const key = vote.toString("utf8").trim();
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,90}$/.test(key) || ![32, 64].includes(base58Bytes(key.slice(8)))) {
    throw new Error("Expected an Ed25519 vote key file");
  }
  const publicKey = await readOptional(publicFile, 256) ?? await readFile(await ask("Path to the trusted assignment public key"), 256, false);
  if (createPublicKey({ key: publicKey, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") {
    throw new Error("Expected an Ed25519 SPKI DER assignment public key");
  }

  const hasIdentity = existsSync(join(state, "identity.json"));
  const inviteInput = await ask(hasIdentity ? "Path to a new invite file (optional for an enrolled node)" : "Path to the private invitation file");
  const invitePath = inviteInput && resolve(inviteInput);
  if (/[\r\n:]/.test(invitePath)) throw new Error("Invalid invitation file path");
  const invite = invitePath && (await readFile(invitePath, 256)).toString("utf8").trim();
  if ((!hasIdentity && !invite) || (invite && !/^SLA-ORACLE-[A-Za-z0-9_-]{43}$/.test(invite))) {
    throw new Error("Expected a private file containing a one-use Oracle invite");
  }

  await privateDirectory(dir);
  await privateDirectory(credentials);
  await privateDirectory(state);
  if (!storedVote) await createFile(voteFile, key + "\n");
  await createFile(publicFile, publicKey);
  await writeConfig(values, {
    SLA_ORACLE_STATE: state, SLA_ORACLE_CREDENTIALS: credentials,
    SLA_ORACLE_CONTRACT: values.contract, SLA_ORACLE_CODE_HASH: values.codeHash,
    SLA_ORACLE_ENDPOINT: values.endpoint, SLA_ORACLE_CONTROL_1: values.control1, SLA_ORACLE_CONTROL_2: values.control2,
    SLA_WORKER_TESTNET_RPC_URL: rpcUrl(values.rpc),
  });
  await compose(values.project, ["build", "oracle"]);
  const args = ["run", "--rm", "--no-deps", "-T"];
  if (invitePath) args.push("-v", `${invitePath}:/run/sla-sentinel/invite:ro`);
  args.push("oracle", "join", "--master", values.master, "--audience", values.audience, "--oracle", values.account);
  if (invitePath) args.push("--invite-file", "/run/sla-sentinel/invite");
  if (values.region) args.push("--region", values.region);
  const registration = JSON.parse(await compose(values.project, args, true));
  if (!["PENDING_APPROVAL", "ACTIVE"].includes(registration.status)) {
    throw new Error("The Master reports " + registration.status + " for this identity");
  }
  console.log("Oracle " + registration.node_id + " " + registration.status);
  await compose(values.project, ["up", "-d", "--wait", "--wait-timeout", "60", "oracle"]);
  if (registration.status === "PENDING_APPROVAL") console.log("Give the node ID to the Master operator for approval.");
  if (invitePath) console.log("Remove the consumed invitation file after confirming enrollment.");
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
