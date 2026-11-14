import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

export async function transaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(db: Pool) {
  const folder = new URL("../migrations/", import.meta.url);
  const files = (await readdir(folder)).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(817420314)");
    await client.query(`CREATE TABLE IF NOT EXISTS sla_master_migrations (
      name text PRIMARY KEY, digest text NOT NULL
    )`);
    for (const name of files) {
      const sql = await readFile(new URL(name, folder), "utf8");
      const digest = createHash("sha256").update(sql).digest("hex");
      const { rows: [previous] } = await client.query("SELECT digest FROM sla_master_migrations WHERE name = $1", [name]);
      if (previous) {
        if (previous.digest !== digest) throw new Error("Applied migration was modified: " + name);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO sla_master_migrations (name, digest) VALUES ($1, $2)", [name, digest]);
    }
  });
}
