import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { get } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, teraToGas } from "near-api-js";
import { loopbackHealth } from "../../shared/oracle-protocol.ts";
import { hashEndpoint } from "../src/monitoring/monitor.ts";
import { verifySettlement } from "../src/settlement/settlement.ts";
import { writePrivateFile } from "../src/worker/identity.ts";
import { scheduleFile } from "./demo-schedule.mjs";

const [scenario = "healthy", ...extra] = process.argv.slice(2);
const expected = new Map([
  ["healthy", { outcome: "healthy", reading: "up", control: "reachable", status: 200 }],
  ["outage", { outcome: "breach", reading: "down", control: "reachable", status: 503 }],
  ["control-loss", { outcome: "inconclusive", reading: "unknown", control: "unavailable", status: 503 }],
]).get(scenario);
if (!expected || extra.length) throw new Error("Usage: node local/demo.mjs [healthy|outage|control-loss]");
const lock = new DatabaseSync("/demo-state/demo-lock.sqlite");
try { lock.exec("BEGIN EXCLUSIVE"); }
catch (error) {
  lock.close();
  if (error.errcode !== 5) throw error;
  throw new Error("Another demo is running on this stack");
}
try {
  await rm(scheduleFile, { force: true });
  await run();
} finally {
  try { await rm(scheduleFile, { force: true }); }
  finally { lock.close(); }
}

async function run() {
  const network = "test-chain-sla-sentinel";
  const rpc = new JsonRpcProvider({ url: "http://127.0.0.1:34831" }, { retries: 2 });
  const { contract: contractId, code_hash: codeHash } = JSON.parse(await readFile("/escrow/deployment.json", "utf8"));
  assert.equal(await rpc.getNetworkId(), network);
  const finality = { finality: "final" };
  assert.equal((await rpc.viewAccount({ accountId: contractId, blockQuery: finality })).code_hash, codeHash);
  const token = (await readFile("/run/bootstrap-auth/token", "utf8")).trim();
  async function admin(path, body) {
    const response = await fetch("http://127.0.0.1:8789/admin/oracles" + path, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(6000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error("Local Master returned HTTP " + response.status + " for " + path);
    return response.json();
  }

  const roster = ["oracle-1.test.near", "oracle-2.test.near", "oracle-3.test.near"];
  const nodes = new Map();
  let cursor;
  do {
    const page = await admin(cursor ? "?after=" + cursor : "");
    for (const node of page.items) {
      if (roster.includes(node.near_account) && node.status === "ACTIVE" && node.connectivity === "ONLINE") {
        nodes.set(node.near_account, node.id);
      }
    }
    cursor = page.next;
  } while (cursor && nodes.size < roster.length);
  assert.equal(nodes.size, roster.length, "The three local workers must be active and sending heartbeats");

  const { account_id: rootId, secret_key: key } = JSON.parse(await readFile("/chain/validator_key.json", "utf8"));
  assert.equal(rootId, "test.near");
  const provider = new Account(rootId, rpc, KeyPairSigner.fromSecretKey(key));
  const customerKey = KeyPair.fromRandom("ed25519");
  const customerId = "customer-" + randomBytes(6).toString("hex") + "." + rootId;
  await provider.signAndSendTransaction({
    receiverId: customerId, waitUntil: "FINAL", retries: 0,
    actions: [actions.createAccount(), actions.transfer(nearToYocto("1")), actions.addFullAccessKey(customerKey.getPublicKey())],
  });
  const customer = new Account(customerId, rpc, new KeyPairSigner(customerKey));
  const call = (account, methodName, args, deposit = 0n) => account.callFunctionRaw({
    contractId, methodName, args, waitUntil: "FINAL", gas: teraToGas("100"), deposit,
  });
  const payout = nearToYocto("0.1");
  const storage = await rpc.callFunction({
    contractId, method: "storage_deposit", args: { oracle_count: roster.length }, blockQuery: finality,
  });
  const startsAt = Date.now() + 45_000;
  const slotMs = 2500;
  const slotCount = 4;
  const graceMs = 60_000;
  const offer = await call(provider, "create_sla", {
    customer: customerId, oracles: roster, down_quorum: 2, endpoint_hash: await hashEndpoint(loopbackHealth, { localDemo: true }),
    starts_at_ms: String(startsAt), slot_ms: slotMs, slot_count: slotCount, min_down_slots: 3,
    reporting_grace_ms: graceMs, payout: String(payout),
  }, BigInt(storage) + payout);
  const slaId = JSON.parse(Buffer.from(offer.status.SuccessValue, "base64").toString("utf8"));
  const args = { sla_id: slaId };
  await call(customer, "accept_sla", args);
  await Promise.all(roster.map((account) => admin("/" + nodes.get(account) + "/assignments", {
    contract: contractId, ...args, endpoint: loopbackHealth,
  })));
  if (scenario !== "healthy") {
    const activation = startsAt - 18_000;
    if (Date.now() >= activation) throw new Error("Setup took too long to schedule the probes. Run the demo again.");
    await writePrivateFile(scheduleFile, JSON.stringify({
      scenario, startsAt: activation, endsAt: startsAt + slotMs * slotCount + 2_000,
    }), "replace");
  }
  console.log(`Sandbox SLA ${slaId} accepted and assigned. Open this ID in the console now.`);
  const view = () => rpc.callFunction({ contractId, method: "get_sla", args, blockQuery: finality });
  let state;
  const deadline = startsAt + slotMs * slotCount + graceMs;
  while (!(state = await view()).votes.every(({ submitted }) => submitted)) {
    if (Date.now() >= deadline) throw new Error("Some oracle reports were still missing at the end of the reporting window");
    await sleep(1000);
  }
  await call(provider, "finalize", args);
  state = await view();
  assert.equal(state.outcome, expected.outcome, "Unexpected finalized verdict for " + scenario);
  const host = new URL(process.env.SLA_CONSOLE_ORIGIN ?? "http://127.0.0.1:8780").host;
  const readEvidence = path => new Promise((resolve, reject) => {
    get("http://127.0.0.1:8780" + path, {
      headers: { Host: host }, signal: AbortSignal.timeout(4_000),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Evidence endpoint returned HTTP " + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 40_000) response.destroy(new Error("Evidence response exceeded its size limit"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
  const evidence = await Promise.all(roster.map(async oracle => {
    const path = "/api/agreements/" + slaId + "/evidence/" + oracle;
    const timeout = Date.now() + 15_000;
    while (Date.now() < timeout) {
      const { status, bundle } = await readEvidence(path);
      if (status === "verified") {
        const slots = bundle.evidence.observations;
        assert.equal(slots.length, slotCount);
        for (const slot of slots) {
          assert.equal(slot.result, expected.reading, oracle);
          assert.equal(slot.control_state, expected.control, oracle);
          assert.equal(slot.observed_http_status, expected.status, oracle);
        if (scenario === "control-loss") assert.equal(slot.diagnostic, "LOCAL_FAULT/CONTROL", oracle);
        }
        return { oracle, slots };
      }
      if (status === "invalid") throw new Error("Evidence differs from the finalized vote for " + oracle);
      await sleep(1000);
    }
    throw new Error("Evidence was not exported in time for " + oracle);
  }));
  const kind = state.outcome === "breach" ? "compensation" : "refund";
  const beneficiary = kind === "compensation" ? customer : provider;
  const claim = await call(beneficiary, "claim", args);
  const transactionHash = claim.transaction_outcome.id;
  const trace = await rpc.viewTransactionStatusWithReceipts({
    accountId: beneficiary.accountId, txHash: transactionHash, waitUntil: "FINAL",
  });
  const proof = verifySettlement({ contract: contractId, slaId, transactionHash, kind, policyVersion: 2 }, await view(), trace);
  const genesis = (await readFile("/escrow/genesis-hash", "utf8")).trim();
  await writePrivateFile("/demo-state/" + transactionHash + ".json", JSON.stringify({ genesis, slaId, trace }));
  console.log(JSON.stringify({ network, scenario, outcome: state.outcome, kind, ...proof, evidence }, null, 2));
}
