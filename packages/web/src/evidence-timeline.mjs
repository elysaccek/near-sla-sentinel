import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { validateEvidenceConfig, verifyEvidenceBundle } from "../../operator/src/monitoring/evidence.ts";
import { isU64 } from "../../shared/oracle-protocol.ts";

const maxBytes = 32_768;

export async function readAgreementEvidence(directory, config, vote) {
  validateEvidenceConfig(config);
  if (typeof vote?.submitted !== "boolean" || !isU64(vote.up_mask) || !isU64(vote.down_mask)
      || !Array.isArray(vote.evidence_hash) || vote.evidence_hash.length !== 32
      || !vote.evidence_hash.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("Invalid finalized oracle report");
  }
  if (!vote.submitted) return { status: "unreported" };
  const { evidence_hash, up_mask, down_mask } = vote;
  const hash = Buffer.from(evidence_hash).toString("hex");
  let file;
  try {
    file = await open(join(directory, config.oracle, hash + ".json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (stat.isFile() && stat.size > 0 && stat.size <= maxBytes) {
      const data = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      if (bytesRead === stat.size) {
        const bundle = JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
        const expected = { config, contract_vote: { sla_id: config.sla_id, evidence_hash, up_mask, down_mask } };
        if (await verifyEvidenceBundle(bundle, expected)) return { status: "verified", hash, bundle };
      }
    }
  } catch (error) {
    if (error.code === "ENOENT") return { status: "unavailable", hash };
  } finally { await file?.close(); }
  return { status: "invalid", hash };
}
