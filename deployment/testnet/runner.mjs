import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Account, actions, baseEncode, JsonRpcProvider, KeyPairSigner, nearToYocto, SignedTransaction, teraToGas } from "near-api-js";
import { boundedJson } from "../../shared/http-json.ts";
import { defaultTestnetRpc, nearRpc } from "../../shared/near-rpc.ts";
import { isTestnetAccount, isU64 } from "../../shared/oracle-protocol.ts";
import { demoRoles, nextDemoWindows, previousDemoPayout, testnetDemo } from "../../shared/testnet-demo.ts";
import { hashEndpoint } from "../src/monitoring/monitor.ts";
import { verifyEvidenceBundle } from "../src/monitoring/evidence.ts";
import { verifySettlement } from "../src/settlement/settlement.ts";
import { privateDirectory, readWorkerFile, writePrivateFile } from "../src/worker/identity.ts";
import { lockWorker } from "../src/worker/store.ts";
import { endpoint, masterUrl, reportingGraceMs } from "./fixture-policy.mjs";
const { minDown, slotCount, slotMs } = testnetDemo;

const stateDir = await privateDirectory("/runner-state");
const release = lockWorker(stateDir);
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try { await run(controller.signal); }
finally { release(); }

async function run(signal) {
  const deployment = (await readWorkerFile("/registry/deployment.json", 8192, false)).toString("utf8");
  const { contract, accounts } = JSON.parse(deployment);
  const roster = demoRoles.map(role => accounts[role]);
  assert.ok([contract, accounts.provider, accounts.customer, ...roster].every(isTestnetAccount)
    && new Set([contract, accounts.provider, accounts.customer, ...roster]).size === 6, "Expected dedicated Testnet accounts");
  const statePath = stateDir + "/runner.json";
  const binding = createHash("sha256").update(deployment).digest("hex");
  let state;
  try { state = JSON.parse((await readWorkerFile(statePath, 1_000_000)).toString("utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = { binding, history: [], lastWindow: 0, current: null, phase: "waiting" };
  }
  assert.equal(state.binding, binding, "Runner state belongs to a different deployment");
  const save = () => writePrivateFile(statePath, JSON.stringify(state), "replace");
  let reserve;
  let checkedReserveAt = 0;
  let observers = [];
  async function publish(phase) {
    if (phase !== state.phase) {
      console.log("Testnet demo " + phase + (state.current?.sla === undefined ? "" : " · SLA " + state.current.sla));
      state.phase = phase;
      await save();
    }
    await writePrivateFile("/live-public/activity.json", JSON.stringify({
      network: "testnet", genesis: testnetDemo.genesis, contract, phase, updatedAt: Date.now(), reserve, observers,
      run: state.current && { ...state.current.window, sla: state.current.sla }, history: state.history,
    }), "replace");
  }
  const url = process.env.SLA_DEMO_RPC ?? defaultTestnetRpc;
  const rpc = nearRpc(url, "testnet", signal, testnetDemo.genesis);
  const api = new JsonRpcProvider({ url }, { retries: 1 });
  const receipts = new JsonRpcProvider({ url: process.env.SLA_DEMO_RECEIPT_RPC ?? url }, { retries: 1 });
  const receiptStatus = await receipts.viewNodeStatus();
  assert.equal(receiptStatus.chain_id, "testnet");
  assert.equal(receiptStatus.genesis_hash, testnetDemo.genesis);
  const signers = Object.fromEntries(await Promise.all(["provider", "customer"].map(async role => [
    role, KeyPairSigner.fromSecretKey((await readWorkerFile("/runner-keys/" + role, 256)).toString("utf8").trim()),
  ])));
  const actor = role => new Account(accounts[role], api, signers[role]);
  const finality = { finality: "final" };
  const read = async sla => {
    const block = await rpc.readAgreement(contract, sla);
    assert.equal(block.codeHash, testnetDemo.codeHash, "Unexpected escrow code");
    return block;
  };
  function summarizeObservations(agreement) {
    const count = mask => BigInt(mask).toString(2).replaceAll("0", "").length;
    return {
      slots: agreement.slot_count,
      required: agreement.min_down_slots,
      confirmed: agreement.confirmed_down_slots,
      possible: agreement.possible_down_slots,
      oracles: agreement.votes.map((vote, index) => {
        const up = vote.submitted ? count(vote.up_mask) : 0;
        const down = vote.submitted ? count(vote.down_mask) : 0;
        return { id: demoRoles[index], submitted: vote.submitted, up, down, unknown: agreement.slot_count - up - down };
      }),
    };
  }
  const endpointHash = await hashEndpoint(endpoint);
  const token = (await readWorkerFile("/admin-access/operator", 256)).toString("utf8").trim();
  async function admin(suffix, body) {
    const response = await fetch(masterUrl + "/admin/oracles" + suffix, {
      method: body ? "POST" : "GET", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Demo Master request failed with HTTP " + response.status);
    }
    return boundedJson(response, 64_000);
  }
  async function checkDeployment() {
    const { blockHash } = await rpc.finalizedBlock();
    const result = await rpc.query(blockHash, { request_type: "view_account", account_id: contract });
    assert.equal(result.code_hash, testnetDemo.codeHash, "Unexpected escrow code");
  }
  async function providerReserve() {
    const account = await api.viewAccount({ accountId: accounts.provider, blockQuery: finality });
    const available = BigInt(account.amount) - BigInt(account.storage_usage) * nearToYocto("0.00001");
    reserve = String(available > 0n ? available : 0n);
    checkedReserveAt = Date.now();
  }

  async function registry() {
    const { items } = await admin("");
    const nodes = roster.map(account => items.find(item => item.near_account === account
      && item.status === "ACTIVE" && item.connectivity === "ONLINE")?.id);
    observers = demoRoles.map((id, i) => ({ id, state: nodes[i] ? "online" : "offline" }));
    return nodes;
  }

  // Persist signed bytes before broadcasting. Recovery only sends that exact transaction again.
  async function execute(current, role, method, args, deposit = 0n) {
    let pending = current.pending;
    if (!pending) {
      await checkDeployment();
      const signed = await actor(role).createSignedTransaction({
        receiverId: contract, actions: [actions.functionCall(method, args, teraToGas("100"), deposit)],
      });
      pending = {
        method, role, hash: baseEncode(createHash("sha256").update(signed.transaction.encode()).digest()),
        signed: Buffer.from(signed.encode()).toString("base64"),
      };
      current.pending = pending;
      await save();
    }
    assert.equal(pending.method, method);
    assert.equal(pending.role, role);
    const signed = SignedTransaction.decode(Buffer.from(pending.signed, "base64"));
    const call = signed.transaction.actions[0]?.functionCall;
    assert.equal(signed.transaction.signerId, accounts[role]);
    assert.equal(signed.transaction.receiverId, contract);
    assert.equal(signed.transaction.actions.length, 1);
    assert.equal(call?.methodName, method);
    assert.deepEqual(JSON.parse(Buffer.from(call.args).toString("utf8")), args);
    assert.equal(call.deposit, deposit);
    assert.equal(baseEncode(createHash("sha256").update(signed.transaction.encode()).digest()), pending.hash);
    const lookup = await rpc.request("tx", { tx_hash: pending.hash, sender_account_id: accounts[role], wait_until: "NONE" });
    if (lookup.result) {
      if (lookup.result.final_execution_status !== "FINAL") return null;
      assert.equal(lookup.result.transaction_outcome.id, pending.hash);
      if (typeof lookup.result.status?.SuccessValue === "string") return lookup.result;
      if (lookup.result.status?.Failure) {
        current.blocked = true;
        await save();
        throw new Error("Signed " + method + " failed at finality. Inspect transaction " + pending.hash);
      }
      return null;
    }
    if (!["UNKNOWN_TRANSACTION", "UNKNOWN_TRANSACTION_OR_RECEIPT"].includes(lookup.error?.cause?.name)) {
      throw new Error("Waiting for RPC transaction reconciliation");
    }
    const response = await rpc.request("send_tx", { signed_tx_base64: pending.signed, wait_until: "INCLUDED" });
    const invalid = response.error?.data?.TxExecutionError?.InvalidTxError ?? response.error?.cause?.info?.TxExecutionError?.InvalidTxError;
    if (invalid === "Expired" || invalid?.InvalidNonce) {
      const archived = await receipts.viewTransactionStatusWithReceipts({
        accountId: accounts[role], txHash: pending.hash, waitUntil: "NONE",
      }).catch(() => null);
      if (archived?.final_execution_status === "FINAL" && archived.transaction_outcome.id === pending.hash
          && typeof archived.status?.SuccessValue === "string") return archived;
      current.blocked = true;
      await save();
      throw new Error("Signed " + method + " needs reconciliation: " + pending.hash);
    }
    return null;
  }

  async function archive(current, agreement, signer) {
    const trace = await receipts.viewTransactionStatusWithReceipts({
      accountId: accounts[signer], txHash: current.claim, waitUntil: "FINAL",
    });
    const outcome = agreement.outcome;
    const proof = verifySettlement({
      contract, slaId: current.sla, transactionHash: current.claim,
      policyVersion: 2, kind: outcome === "breach" ? "compensation" : "refund",
    }, agreement, trace);
    const bundles = [];
    for (const [index, role] of demoRoles.entries()) {
      const vote = agreement.votes[index];
      if (!vote.submitted) continue;
      const digest = Buffer.from(vote.evidence_hash).toString("hex");
      const bundle = JSON.parse((await readWorkerFile("/evidence/" + role + "/" + digest + ".json", 32_768)).toString("utf8"));
      const config = {
        network: "testnet", contract, sla_id: current.sla, oracle: roster[index], endpoint_hash: agreement.endpoint_hash,
        starts_at_ms: agreement.starts_at_ms, slot_count: agreement.slot_count, slot_ms: agreement.slot_ms,
      };
      const { submitted: _submitted, ...contractVote } = vote;
      assert.ok(await verifyEvidenceBundle(bundle, { config, contract_vote: { ...contractVote, sla_id: current.sla } }),
        "Oracle evidence differs from the finalized vote");
      bundles.push(bundle);
    }
    const { time: settledAt } = await rpc.finalizedBlock();
    const row = {
      ...current.window, sla: current.sla, outcome, tx: current.claim, settledAt,
      amount: proof.amount_yoctonear, transfer: proof.transfer_receipt_id, callback: proof.callback_receipt_id,
      observations: summarizeObservations(agreement),
    };
    await writePrivateFile(stateDir + "/settlement-" + current.sla + ".json",
      JSON.stringify({ network: "testnet", contract, row, agreement, evidence: bundles, trace }), "replace");
    state.history = [...state.history.slice(-499), row];
    state.current = null;
    checkedReserveAt = 0;
    await save();
    console.log("Finalized Testnet claim " + current.claim);
  }

  async function advance() {
    const now = Date.now();
    if (now - checkedReserveAt > 55_000) {
      await providerReserve();
      await registry().catch(() => { observers = []; });
    }
    let current = state.current;
    if (current?.blocked) return "paused";
    if (!current) {
      const scheduled = nextDemoWindows(now).sort((a, b) => a.start - b.start)[0];
      const commissioning = process.env.SLA_DEMO_COMMISSION === "1" && !state.commissioned
        && scheduled.start - now > 360_000
        && !nextDemoWindows(now - 180_000).some(item => item.start <= now);
      const window = commissioning
        ? { scenario: "target", start: now + 90_000, end: now + 270_000, commissioning: true }
        : scheduled;
      if (window.start <= state.lastWindow || window.start - now > 100_000 || window.start - now < 50_000) return "waiting";
      await checkDeployment();
      const quote = await api.callFunction({ contractId: contract, method: "storage_deposit", args: { oracle_count: roster.length }, blockQuery: finality });
      const deposit = BigInt(testnetDemo.payout) + BigInt(quote);
      if (BigInt(reserve) < deposit + nearToYocto("0.01")) return "funding-required";
      const nodes = await registry();
      if (nodes.some(id => !id)) return "waiting";
      current = state.current = { window, nodes, deposit: String(deposit), payout: testnetDemo.payout };
      state.lastWindow = window.start;
      if (commissioning) state.commissioned = true;
      await save();
    }
    const { window } = current;
    if (window.commissioning && now < window.start && !current.fixtureScheduled) {
      await writePrivateFile("/live-public/commissioning.json", JSON.stringify({ start: window.start, end: window.end }), "replace");
      current.fixtureScheduled = true;
      await save();
    }
    if (current.sla === undefined && now >= window.start && !current.pending) {
      state.current = null;
      await save();
      return "waiting";
    }
    if (current.sla === undefined) {
      await publish("funding");
      const tx = await execute(current, "provider", "create_sla", {
        customer: accounts.customer, oracles: roster, down_quorum: 2, endpoint_hash: endpointHash,
        starts_at_ms: String(window.start), slot_ms: slotMs, slot_count: slotCount, min_down_slots: minDown,
        reporting_grace_ms: reportingGraceMs, payout: current.payout ?? previousDemoPayout,
      }, BigInt(current.deposit));
      if (!tx) return "funding";
      current.sla = JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString("utf8"));
      assert.ok(isU64(current.sla));
      delete current.pending;
      await save();
    }
    const args = { sla_id: current.sla };
    const { time, agreement } = await read(current.sla);
    assert.ok(agreement);
    const start = Number(agreement.starts_at_ms);
    const end = Number(agreement.ends_at_ms);
    const deadline = Number(agreement.reporting_deadline_ms);
    const signer = agreement.outcome === "breach" ? "customer" : "provider";
    if (current.pending?.method === "accept_sla" || (time < start && !agreement.accepted && !current.pending)) {
      if (agreement.accepted) {
        delete current.pending;
        await save();
      } else {
        // The first transaction may be in flight when the acceptance window closes.
        // Reconciliation keeps the original hash and does not create another accept call.
        const tx = await execute(current, "customer", "accept_sla", args);
        if (tx) { delete current.pending; await save(); }
        return "funding";
      }
    }
    if (!current.assigned && agreement.accepted && agreement.outcome === "undecided" && time < end) {
      await Promise.all(current.nodes.map(id => admin("/" + id + "/assignments", { contract, ...args, endpoint })));
      current.assigned = true;
      await save();
    }
    if (agreement.outcome === "undecided") {
      const ready = agreement.accepted
        ? time >= deadline || (time >= end && agreement.votes.every(vote => vote.submitted))
        : time >= start;
      if (!ready) {
        if (time < start) return "scheduled";
        return time < end ? "observing" : "reporting";
      }
      const tx = await execute(current, "provider", "finalize", args);
      if (tx) { delete current.pending; await save(); }
      return "settling";
    }
    if (current.pending?.method === "finalize") {
      delete current.pending;
      await save();
    }
    if (agreement.payment === "paid") {
      if (!current.claim && current.pending?.method === "claim") {
        current.claim = current.pending.hash;
        await save();
      }
      assert.ok(current.claim, "Payment was made outside this run. Reconcile its claim before continuing.");
      await archive(current, agreement, signer);
      return "waiting";
    }
    if (current.pending?.method === "claim" || agreement.payment === "claimable") {
      const tx = await execute(current, signer, "claim", args);
      if (tx) {
        if (Buffer.from(tx.status.SuccessValue, "base64").toString() !== "true") {
          current.blocked = true;
          await save();
          throw new Error("Claim callback did not confirm transfer. Inspect " + current.pending.hash);
        }
        current.claim = current.pending.hash;
        delete current.pending;
        await save();
      }
      return "settling";
    }
    return "settling";
  }

  await checkDeployment();
  const olderRows = state.history.filter(row => !row.observations);
  for (const row of olderRows) {
    const archived = await readWorkerFile(stateDir + "/settlement-" + row.sla + ".json", 1_000_000);
    const { agreement, row: proof } = JSON.parse(archived.toString("utf8"));
    assert.ok(proof.tx === row.tx && agreement?.payment === "paid" && agreement.outcome === row.outcome,
      "Saved history differs from the verified settlement archive");
    row.observations = summarizeObservations(agreement);
  }
  if (olderRows.length) await save();
  let lastFailure;
  while (!signal.aborted) {
    try {
      await publish(await advance());
      lastFailure = undefined;
    } catch (error) {
      if (signal.aborted) break;
      // Report a bounded, operator-facing error. The browser receives only the public phase.
      const message = error instanceof Error ? error.message : "Unexpected runner error";
      if (lastFailure !== message) console.error(message);
      lastFailure = message;
      await publish(state.current?.blocked ? "paused" : "retrying");
    }
    await sleep(state.current && !state.current.blocked ? 3000 : 10_000, undefined, { signal }).catch(() => {});
  }
}
