import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEvidenceBundle, createWorkerEvidenceBundle } from "../../operator/src/monitoring/evidence.ts";
import { exportEvidence } from "../../operator/src/worker/evidence-export.ts";
import { readAgreementEvidence } from "../src/evidence-timeline.mjs";

test("only roster evidence matching the finalized vote is served, including historical bundles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sla-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    network: "test-chain-sla-sentinel", contract: "escrow.test.near", sla_id: "0", oracle: "oracle-1.test.near",
    endpoint_hash: Array(32).fill(1), starts_at_ms: "1000", slot_ms: 1000, slot_count: 3,
  };
  const oracleDir = join(directory, config.oracle);
  await mkdir(oracleDir, { mode: 0o700 });
  const probes = [
    { slot: 0, started_at_ms: 1000, finished_at_ms: 1200, http_status: 503 },
    { slot: 1, started_at_ms: 2000, finished_at_ms: 2200, http_status: null },
  ];
  const evidence = await createWorkerEvidenceBundle(config, probes, [
    { slot: 0, observed_http_status: 503, control_state: "reachable", diagnostic: null },
    { slot: 1, observed_http_status: 503, control_state: "unavailable", diagnostic: "LOCAL_FAULT/CONTROL" },
  ]);
  const vote = { submitted: true, ...evidence.contract_vote };
  const hash = Buffer.from(vote.evidence_hash).toString("hex");
  const file = join(oracleDir, hash + ".json");
  assert.deepEqual(await readAgreementEvidence(directory, config, { ...vote, submitted: false }), { status: "unreported" });
  assert.deepEqual(await readAgreementEvidence(directory, config, vote), { status: "unavailable", hash });
  await symlink("../irrelevant", file);
  assert.deepEqual(await readAgreementEvidence(directory, config, vote), { status: "invalid", hash });
  assert.equal(await exportEvidence(oracleDir, config.oracle, JSON.stringify(evidence)), true);
  assert.deepEqual(await readAgreementEvidence(directory, config, vote), { status: "verified", hash, bundle: evidence });
  assert.deepEqual(await readAgreementEvidence(directory, { ...config, sla_id: "1" }, vote), { status: "invalid", hash });
  assert.deepEqual(await readAgreementEvidence(directory, config, { ...vote, down_mask: "0" }), { status: "invalid", hash });
  const tampered = structuredClone(evidence);
  tampered.evidence.observations[1].observed_http_status = 502;
  await writeFile(file, JSON.stringify(tampered));
  assert.deepEqual(await readAgreementEvidence(directory, config, vote), { status: "invalid", hash });
  assert.equal(await exportEvidence(oracleDir, config.oracle, JSON.stringify(tampered)), false);
  assert.equal(await exportEvidence(oracleDir, config.oracle, JSON.stringify(evidence)), true);
  assert.equal((await readAgreementEvidence(directory, config, vote)).status, "verified");
  const legacy = await createEvidenceBundle(config, probes);
  await exportEvidence(oracleDir, config.oracle, JSON.stringify(legacy));
  const result = await readAgreementEvidence(directory, config, { submitted: true, ...legacy.contract_vote });
  assert.equal(result.status, "verified");
  assert.equal(result.bundle.evidence.domain, "sla-sentinel/evidence/v1");
});
