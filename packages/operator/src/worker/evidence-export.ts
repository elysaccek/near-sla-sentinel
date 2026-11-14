import { join } from "node:path";
import { verifyEvidenceBundle } from "../monitoring/evidence.ts";
import { readWorkerFile, writePrivateFile } from "./identity.ts";

export async function exportEvidence(directory: string, oracle: string, data: string) {
  let bundle;
  try { bundle = JSON.parse(data); } catch { return false; }
  if (!await verifyEvidenceBundle(bundle) || bundle.evidence.oracle !== oracle) return false;
  const path = join(directory, Buffer.from(bundle.contract_vote.evidence_hash).toString("hex") + ".json");
  const existing = await readWorkerFile(path, 32_768).catch(() => null);
  if (existing?.toString("utf8") !== data) await writePrivateFile(path, data, "replace");
  return true;
}
