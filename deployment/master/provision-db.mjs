import { readFile } from "node:fs/promises";
import pg from "pg";

async function password(path) {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error("Invalid database password file");
  return value;
}

async function provision() {
  const config = { host: "database", database: "sentinel", connectionTimeoutMillis: 5000, statement_timeout: 5000 };
  const appPassword = await password(process.env.SLA_MASTER_DATABASE_PASSWORD_FILE ?? "/run/sla-sentinel/database-password");
  const bootstrapPassword = await password(process.env.SLA_POSTGRES_PASSWORD_FILE ?? "/run/sla-sentinel/postgres-password");
  const admin = new pg.Client({ ...config, user: "postgres", password: bootstrapPassword });
  try {
    await admin.connect();
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock(817420315)");
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'sentinel'");
    if (!role.rowCount) {
      const { rows: [{ statement }] } = await admin.query(
        "SELECT format('CREATE ROLE sentinel LOGIN PASSWORD %L', $1::text) AS statement", [appPassword],
      );
      await admin.query(statement);
    }
    await admin.query("CREATE SCHEMA IF NOT EXISTS sentinel AUTHORIZATION sentinel");
    await admin.query("COMMIT");
  } finally {
    await admin.end();
  }

  const app = new pg.Client({ ...config, user: "sentinel", password: appPassword, options: "--search_path=sentinel" });
  try {
    await app.connect();
    const { rows: [role] } = await app.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication,
      rolbypassrls, current_schema() AS schema, has_schema_privilege('sentinel', 'CREATE') AS can_create
      FROM pg_roles WHERE rolname = current_user`);
    if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication
        || role.rolbypassrls || role.schema !== "sentinel" || !role.can_create) {
      throw new Error("Unexpected database role privileges");
    }
  } finally {
    await app.end();
  }
}

provision().catch(() => {
  console.error("Database provisioning failed. Check PostgreSQL readiness, role permissions and saved credentials.");
  process.exitCode = 1;
});
