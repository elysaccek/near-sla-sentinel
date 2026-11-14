import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { demoPairWindow, demoTargetStatus, demoWindows, nextDemoWindows, previousDemoPayout, testnetDemo } from "../../shared/testnet-demo.ts";
import { assessQuorumWindow } from "../../operator/src/monitoring/evidence.ts";
import { pilotHistory, readTestnetFeed } from "../src/testnet-feed.mjs";

test("A and B share a single scheduled agreement every six hours", () => {
  const minute = 60_000;
  for (let step = 0; step < 30 * 60; step++) {
    const now = step * minute;
    const active = demoWindows(now).filter(window => window.active).map(window => window.id);
    if (step % 360 >= 5 && step % 360 < 8) assert.deepEqual(active, ["oracle-a", "oracle-b"]);
    else assert.ok(active.length <= 1);
    assert.equal(demoPairWindow(now).active, active.length === 2);
  }
  const probes = time => ["oracle-a", "oracle-b", "oracle-c"].map(role => demoTargetStatus(time * minute, role));
  assert.deepEqual(probes(5), [503, 503, 200]);
  assert.deepEqual(probes(8), [200, 200, 200]);
  assert.deepEqual(probes(125), [503, 200, 200]);
  assert.deepEqual(probes(185), [200, 503, 200]);
  assert.deepEqual(probes(35), [503, 503, 503]);
  assert.deepEqual(probes(38), [200, 200, 200]);
  assert.equal(nextDemoWindows(125 * minute).find(window => window.scenario === "oracle-a").start, 245 * minute);
  for (const start of [5, 365, 725, 1085, 1445]) {
    const matching = nextDemoWindows(start * minute - 1).filter(window => window.start === start * minute);
    assert.deepEqual(matching, [{ scenario: "oracle-pair", start: start * minute, end: (start + 3) * minute }]);
  }
  assert.equal(demoPairWindow(1 * minute + 360 * minute).next, 365 * minute);
});

test("the two isolated 503 windows return principal and the shared outage is a breach", () => {
  const minute = 60_000;
  for (const [offset, outcome] of [[125, "healthy"], [185, "healthy"], [5, "breach"], [35, "breach"]]) {
    const votes = ["oracle-a", "oracle-b", "oracle-c"].map(role => {
      let up = 0n;
      let down = 0n;
      for (let slot = 0; slot < 6; slot++) {
        const status = demoTargetStatus(offset * minute + slot * 10_000, role);
        if (status === 503) down |= 1n << BigInt(slot);
        if (status === 200) up |= 1n << BigInt(slot);
      }
      return { up_mask: String(up), down_mask: String(down) };
    });
    const expectedStreak = outcome === "breach" ? 6 : 0;
    assert.deepEqual(assessQuorumWindow(6, 3, 2, votes), { outcome, confirmed: expectedStreak, possible: expectedStreak });
  }
});

test("the feed labels commissioning, stale, missing and wrong-chain activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sla-feed-"));
  try {
    const now = Date.UTC(2026, 10, 14);
    const file = join(directory, "activity.json");
    assert.equal((await readTestnetFeed(file, now)).phase, "offline");
    const sample = pilotHistory[0];
    const observations = {
      slots: 6, required: 3, confirmed: 6, possible: 6,
      oracles: ["oracle-a", "oracle-b", "oracle-c"].map(id => ({ id, submitted: true, up: 0, down: 6, unknown: 0 })),
    };
    const settlement = { scenario: "target", commissioning: true, outcome: "breach", sla: "3", start: now - 90_000,
      settledAt: now, tx: sample.tx, transfer: sample.transfer, callback: sample.callback, amount: previousDemoPayout };
    const data = {
      updatedAt: now, network: "testnet", genesis: testnetDemo.genesis, contract: sample.contract,
      phase: "waiting", reserve: "5000000000000000000000000",
      history: [
        { ...settlement, observations, privateField: "omit" },
        { ...settlement, scenario: "oracle-pair", commissioning: false, amount: testnetDemo.payout },
        { scenario: "target", outcome: "healthy", tx: "not a transaction" },
      ],
    };
    await writeFile(file, JSON.stringify(data));
    const live = await readTestnetFeed(file, now);
    assert.equal(live.phase, "waiting");
    assert.equal(live.history.length, 2);
    assert.deepEqual(live.history.map(row => row.amount), [previousDemoPayout, testnetDemo.payout]);
    assert.equal(live.history[1].scenario, "oracle-pair");
    assert.equal(live.policy.payout, testnetDemo.payout);
    assert.equal(live.history[0].source, "commissioning");
    assert.equal(live.history[0].privateField, undefined);
    assert.deepEqual(live.history[0].observations, observations);
    assert.equal((await readTestnetFeed(file, now + 96_000)).phase, "stale");
    await writeFile(file, JSON.stringify({ ...data, phase: "scheduled" }));
    assert.equal((await readTestnetFeed(file, now)).phase, "scheduled");
    await writeFile(file, JSON.stringify({ ...data, history: [{ ...settlement, observations: {
      ...observations, oracles: observations.oracles.map(report => ({ ...report, unknown: 6 })),
    } }] }));
    assert.equal((await readTestnetFeed(file, now)).history[0].observations, undefined);
    await writeFile(file, JSON.stringify({ ...data, genesis: "different" }));
    assert.deepEqual((await readTestnetFeed(file, now)).history, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
