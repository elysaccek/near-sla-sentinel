import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { verifyEvidenceBundle } from "../monitoring/evidence.ts";
import type { EvidenceBundle, EvidenceConfig } from "../monitoring/evidence.ts";
import { collectEvidence } from "../monitoring/monitor.ts";
import { reportVote } from "../oracles/oracle-flow.ts";
import type { Agreement, Snapshot } from "../oracles/oracle-flow.ts";
import { prepareVoteSender } from "../oracles/oracle-signer.ts";

const RPC_URL = "https://test.rpc.fastnear.com";
const TESTNET_ACCOUNT = /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$/;
const U64_MAX = (1n << 64n) - 1n;

function accountId(value: string | undefined): string {
  if (!value || value.length > 64 || !TESTNET_ACCOUNT.test(value)) {
    throw new Error("Use a named .testnet account");
  }
  return value;
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function loadArchive(path: string): Promise<EvidenceBundle | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as EvidenceBundle;
  } catch (error) {
    if (isFileError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function storeArchive(path: string, bundle: EvidenceBundle): Promise<EvidenceBundle> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(bundle, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporaryPath, path);
      return bundle;
    } catch (error) {
      if (!isFileError(error, "EEXIST")) {
        throw error;
      }
      const existing = await loadArchive(path);
      if (!existing) {
        throw new Error("The existing evidence archive disappeared");
      }
      return existing;
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isFileError(error, "ENOENT")) {
        throw error;
      }
    });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    contract: { type: "string" },
    oracle: { type: "string" },
    "sla-id": { type: "string" },
    endpoint: { type: "string" },
    "evidence-dir": { type: "string" },
    "local-demo": { type: "boolean" },
    submit: { type: "boolean" },
  } });
  const contractId = accountId(values.contract);
  const oracle = accountId(values.oracle);
  const slaId = values["sla-id"];
  const endpoint = values.endpoint;
  if (!slaId || !/^(0|[1-9][0-9]{0,19})$/.test(slaId) || BigInt(slaId) > U64_MAX
      || !endpoint || !values["evidence-dir"]) {
    throw new Error("Provide --contract, --oracle, --sla-id, --endpoint, and --evidence-dir");
  }

  const archive = join(resolve(values["evidence-dir"]), `testnet.${contractId}.${slaId}.${oracle}.json`);
  const provider = new JsonRpcProvider({ url: RPC_URL });
  if (await provider.getNetworkId() !== "testnet") {
    throw new Error("RPC endpoint is not on Testnet");
  }

  const sendVote = values.submit
    ? await prepareVoteSender(provider, contractId, oracle, process.env.SLA_ORACLE_PRIVATE_KEY)
    : undefined;

  const config = (agreement: Agreement): EvidenceConfig => ({
    network: "testnet",
    contract: contractId,
    sla_id: slaId,
    oracle,
    endpoint_hash: agreement.endpoint_hash,
    starts_at_ms: agreement.starts_at_ms,
    slot_ms: agreement.slot_ms,
    slot_count: agreement.slot_count,
  });

  const read = async (): Promise<Snapshot> => {
    const block = await provider.viewBlock({ finality: "final" });
    const agreement = await provider.callFunction<Agreement>({
      contractId,
      method: "get_sla",
      args: { sla_id: slaId },
      blockQuery: { blockId: block.header.hash },
    });
    if (!agreement || !Array.isArray(agreement.oracles) || !Array.isArray(agreement.votes)) {
      throw new Error("Agreement not found or unsupported response");
    }
    return { agreement, blockTimeMs: BigInt(block.header.timestamp_nanosec) / 1_000_000n };
  };

  const result = await reportVote({
    oracle,
    submit: values.submit ?? false,
    read,
    load: () => loadArchive(archive),
    store: (bundle: EvidenceBundle) => storeArchive(archive, bundle),
    measure: (agreement) => {
      if (Date.now() >= Number(agreement.ends_at_ms)) {
        throw new Error("Local clock is past the observation window. Restore the original archive");
      }
      return collectEvidence(config(agreement), endpoint, { localDemo: values["local-demo"] });
    },
    verify: (bundle, agreement) => verifyEvidenceBundle(bundle, {
      config: config(agreement),
      contract_vote: bundle.contract_vote,
    }),
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    send: async (vote) => {
      if (!sendVote) {
        throw new Error("Oracle signer unavailable");
      }
      return sendVote(vote);
    },
  });
  console.log(JSON.stringify({ ...result, evidence_path: archive }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Oracle execution failed");
  process.exitCode = 1;
});
