import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isNetworkAccount, isSandboxNetwork, isU64 } from "../../shared/oracle-protocol.ts";
import { parseFaultWindow } from "../../shared/fault-protocol.ts";
import { uuid } from "./protocol.ts";

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      after: { type: "string" }, ttl: { type: "string" }, contract: { type: "string" },
      "sla-id": { type: "string" }, endpoint: { type: "string" },
      "schedule-file": { type: "string" },
    }, allowPositionals: true,
  });
  const [command, id] = positionals;
  const { SLA_MASTER_URL = "http://127.0.0.1:8789", SLA_MASTER_ADMIN_TOKEN_FILE: file } = process.env;
  const base = new URL(SLA_MASTER_URL);
  const network = process.env.SLA_MASTER_SANDBOX_NETWORK ?? "testnet";
  if (network !== "testnet" && (!isSandboxNetwork(network) || base.protocol !== "http:" || base.hostname !== "127.0.0.1")) {
    throw new Error("Use a loopback URL for local Sandbox administration");
  }
  if (base.username || base.password || (base.protocol !== "https:" &&
      !(base.protocol === "http:" && base.hostname === "127.0.0.1"))) {
    throw new Error("Use HTTPS or http://127.0.0.1 for the local Master");
  }
  if (!file) throw new Error("Set SLA_MASTER_ADMIN_TOKEN_FILE");
  const root = "/admin/oracles";
  const list = new Map([["list", root], ["pending", root + "/pending"], ["invitations", root + "/invitations"]]);
  let method = "GET";
  let path = list.get(command);
  let body: string | undefined;
  if (command === "invite") {
    path = root + "/invitations";
    method = "POST";
    body = JSON.stringify(values.ttl ? { ttl_seconds: Number(values.ttl) } : {});
  } else if (command === "revoke-invite") {
    path = root + "/invitations/" + uuid(id);
    method = "DELETE";
  } else if (command === "node" || command === "heartbeats" || command === "assignments") {
    path = root + "/" + uuid(id) + (command === "node" ? "" : "/" + command);
  } else if (command === "assign") {
    const { contract, "sla-id": slaId, endpoint } = values;
    if (!isNetworkAccount(contract, network) || !isU64(slaId) || !endpoint) {
      throw new Error("Use assign NODE_ID --contract ACCOUNT --sla-id ID --endpoint URL");
    }
    path = root + "/" + uuid(id) + "/assignments";
    method = "POST";
    body = JSON.stringify({ contract, sla_id: slaId, endpoint });
  } else if (["fault-status", "fault-set", "fault-clear"].includes(command)) {
    if (!isSandboxNetwork(network)) throw new Error("Select a local Sandbox to manage demo faults");
    path = root + "/" + uuid(id) + "/fault-schedule";
    if (command === "fault-set") {
      if (!values["schedule-file"]) throw new Error("Use fault-set NODE_ID --schedule-file FILE");
      const schedule = parseFaultWindow(JSON.parse(await readFile(values["schedule-file"], "utf8")));
      method = "POST";
      body = JSON.stringify({ schedule });
    } else if (command === "fault-clear") {
      method = "DELETE";
    }
  } else if (["approve", "reject", "disable", "enable", "revoke"].includes(command)) {
    path = root + "/" + uuid(id) + "/" + command;
    method = "POST";
  }
  if (!path) throw new Error("Use invite, invitations, revoke-invite, list, pending, node, heartbeats, assign, assignments, approve, reject, disable, enable, revoke, fault-status, fault-set, or fault-clear");
  const url = new URL(path, base);
  if (values.after) url.searchParams.set("after", uuid(values.after));
  const token = (await readFile(file, "utf8")).trim();
  const res = await fetch(url, {
    method, body, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  if (res.status === 204) return;
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? "Master request failed");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Master command failed");
  process.exitCode = 1;
});
