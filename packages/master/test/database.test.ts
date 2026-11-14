import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import pg from "pg";
import { migrate } from "../src/database.ts";

const database = process.env.SLA_MASTER_TEST_DATABASE_URL;
const skip = !database && "Set SLA_MASTER_TEST_DATABASE_URL";
const migrations = new URL("../migrations/", import.meta.url);

async function isolatedDatabase(t: TestContext) {
  const schema = `migration_test_${randomBytes(8).toString("hex")}`;
  const options = { connectionString: database, connectionTimeoutMillis: 5000, statement_timeout: 5000 };
  const maintenance = new pg.Pool(options);
  const poolOptions = {
    ...options,
    onConnect: (client: pg.Client) => client.query(`SET search_path TO "${schema}"`),
  };
  const db = new pg.Pool(poolOptions);
  let created = false;
  t.after(async () => {
    try {
      await db.end();
      if (created) await maintenance.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await maintenance.end();
    }
  });
  await maintenance.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  return db;
}

async function assertMigrationHistory(db: pg.Pool) {
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  const expected = await Promise.all(files.map(async (name) => ({
    name,
    digest: createHash("sha256").update(await readFile(new URL(name, migrations))).digest("hex"),
  })));
  const { rows } = await db.query("SELECT name, digest FROM sla_master_migrations ORDER BY name");
  assert.deepEqual(rows, expected);
}

test("concurrent Master startups upgrade an existing registry without losing records", { skip }, async (t) => {
  const db = await isolatedDatabase(t);
  const firstMigration = "001_registry.sql";
  const sql = await readFile(new URL(firstMigration, migrations), "utf8");
  const digest = createHash("sha256").update(sql).digest("hex");
  await db.query(sql);
  await db.query("CREATE TABLE sla_master_migrations (name text PRIMARY KEY, digest text NOT NULL)");
  await db.query("INSERT INTO sla_master_migrations VALUES ($1, $2)", [firstMigration, digest]);
  const invite = randomUUID();
  const node = randomUUID();
  await db.query(`INSERT INTO oracle_invitations (id, digest, expires_at, consumed_at)
    VALUES ($1, $2, clock_timestamp(), clock_timestamp())`, [invite, randomBytes(32)]);
  await db.query(`INSERT INTO oracle_nodes (id, identity_key, near_account, invitation_id, metadata, status)
    VALUES ($1, 'legacy-key', 'legacy.testnet', $2, $3, 'ACTIVE')`, [node, invite, { version: "legacy" }]);

  await Promise.all([migrate(db), migrate(db)]);
  await assertMigrationHistory(db);
  const { rows } = await db.query("SELECT id, invitation_id, metadata, status, near_public_key FROM oracle_nodes");
  assert.deepEqual(rows, [{
    id: node, invitation_id: invite, metadata: { version: "legacy" }, status: "ACTIVE", near_public_key: null,
  }]);
});

test("a failed migration rolls back earlier changes and can be retried", { skip }, async (t) => {
  const db = await isolatedDatabase(t);
  await db.query("CREATE TABLE oracle_assignments (marker text)");
  await db.query("INSERT INTO oracle_assignments VALUES ('pre-existing row')");

  await assert.rejects(migrate(db), { code: "42P07" });
  const { rows } = await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() ORDER BY table_name`);
  assert.deepEqual(rows, [{ table_name: "oracle_assignments" }]);
  assert.deepEqual((await db.query("SELECT marker FROM oracle_assignments")).rows, [{ marker: "pre-existing row" }]);

  await db.query("DROP TABLE oracle_assignments");
  await migrate(db);
  await assertMigrationHistory(db);
});
