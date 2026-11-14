import type { Pool, PoolClient } from "pg";
import { faultScheduleMessage, parseFaultWindow } from "../../shared/fault-protocol.ts";
import type { FaultSchedule } from "../../shared/fault-protocol.ts";
import { isSandboxNetwork } from "../../shared/oracle-protocol.ts";
import { transaction } from "./database.ts";
import { object, RequestError } from "./protocol.ts";

export function faultService(db: Pool, audience: string, network: string, sign?: (message: string) => string) {
  async function latest(client: Pool | PoolClient, nodeId: string) {
    const { rows: [row] } = await client.query(`SELECT revision, schedule, signature FROM oracle_fault_schedules
      WHERE node_id=$1 AND network=$2 ORDER BY revision DESC LIMIT 1`, [nodeId, network]);
    return row ? { plan: { revision: row.revision, schedule: row.schedule }, signature: row.signature } : null;
  }

  return {
    async update(adminId: string, nodeId: string, input: unknown) {
      if (!sign || !isSandboxNetwork(network)) throw new RequestError(404, "Sandbox fault management is disabled");
      const { schedule } = object(input, ["schedule"]);
      let window: FaultSchedule["schedule"];
      try { window = schedule === null ? null : parseFaultWindow(schedule); }
      catch { throw new RequestError(400, "Invalid demo fault schedule"); }
      const now = Date.now();
      if (window && (window.expires_at_ms <= now || window.starts_at_ms > now + 604_800_000)) {
        throw new RequestError(400, "Schedule must be unexpired and start within seven days");
      }
      return transaction(db, async (client) => {
        const { rows: [node] } = await client.query("SELECT status FROM oracle_nodes WHERE id=$1 FOR UPDATE", [nodeId]);
        if (!node || (window && node.status !== "ACTIVE")) throw new RequestError(409, "Node must be active to receive a schedule");
        const previous = await latest(client, nodeId);
        const plan = { revision: (previous?.plan.revision ?? 0) + 1, schedule: window };
        const signature = sign(faultScheduleMessage(audience, network, nodeId, plan));
        await client.query("INSERT INTO oracle_fault_schedules (node_id, network, revision, schedule, signature) VALUES ($1, $2, $3, $4, $5)",
          [nodeId, network, plan.revision, window, signature]);
        await client.query("INSERT INTO oracle_audit_log (actor, action, subject) VALUES ($1, $2, $3)",
          [adminId, window ? "fault_schedule_set" : "fault_schedule_cleared", nodeId]);
        return plan;
      });
    },
    async read(client: Pool | PoolClient, nodeId: string) {
      if (!sign || !isSandboxNetwork(network)) throw new RequestError(404, "Sandbox fault management is disabled");
      return latest(client, nodeId);
    },
  };
}
