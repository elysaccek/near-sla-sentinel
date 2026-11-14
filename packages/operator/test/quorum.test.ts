import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assessQuorumWindow, assessWindow } from "../src/monitoring/evidence.ts";

test("matches the same window vectors as Rust", () => {
  const fixtures = readFileSync(new URL("../../../fixtures/quorum-windows.tsv", import.meta.url), "utf8");
  for (const line of fixtures.trimEnd().split("\n").filter((line) => !line.startsWith("#"))) {
    const [name, slots, threshold, quorum, entries, outcome, confirmed, possible] = line.split(/\s+/);
    const votes = entries.split(",").map((entry) => {
      if (entry === "-") return null;
      const [up_mask, down_mask] = entry.split(":");
      return { up_mask, down_mask };
    });
    const expected = { outcome, confirmed: Number(confirmed), possible: Number(possible) };
    assert.deepEqual(assessQuorumWindow(Number(slots), Number(threshold), Number(quorum), votes), expected, name);
    if (votes.length === 3) {
      assert.deepEqual(assessWindow(Number(slots), Number(threshold), votes), expected, name);
    }
  }
});

test("preserves the archived Testnet and Sandbox verdicts", () => {
  for (const path of ["testnet/payment-proof.json", "sandbox/inconclusive-proof.json"]) {
    const { agreement, verdict } = JSON.parse(readFileSync(new URL("../../../examples/" + path, import.meta.url), "utf8"));
    const votes = agreement.votes.map((vote: { submitted: boolean }) => vote.submitted ? vote : null);
    assert.deepEqual(assessWindow(agreement.slot_count, agreement.min_down_slots, votes), verdict);
  }
});

test("rejects invalid windows, quorums, and masks", () => {
  const empty = [null, null, null, null, null];
  assert.throws(() => assessQuorumWindow(65, 2, 3, empty), /window/);
  assert.throws(() => assessQuorumWindow(4, 5, 3, empty), /window/);
  for (const quorum of [2, 3.5, 6]) {
    assert.throws(() => assessQuorumWindow(4, 2, quorum, empty), /quorum/);
  }
  assert.throws(() => assessQuorumWindow(4, 2, 2, [null, null]), /quorum/);
  assert.throws(() => assessWindow(4, 2, empty), /window/);
  for (const invalid of [{ up_mask: "1", down_mask: "1" }, { up_mask: "0", down_mask: "16" }]) {
    assert.throws(() => assessQuorumWindow(4, 2, 2, [invalid, null, null]), /mask/);
  }
});
