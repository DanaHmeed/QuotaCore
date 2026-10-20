// Prepares the database: waits for PostgreSQL, applies every SQL file in
// migrations/ that has not been applied yet (in filename order), then makes
// sure the predefined plans exist.
//
// Safe to run on every start: applied migrations are recorded in
// schema_migrations and skipped, and plans are only inserted when missing.
// An advisory lock makes two instances starting at once take turns.
//
// Usage: npm run db:setup      (also runs automatically in the api container)

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/config/database.js";

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");

// Any number works, as long as only this script uses it.
const ADVISORY_LOCK_ID = 727274;

const PREDEFINED_PLANS = [
  { name: "Starter", planType: "account", monthlyAllowance: 1_000, maxUnitsPerRequest: 100 },
  { name: "Pro", planType: "account", monthlyAllowance: 10_000, maxUnitsPerRequest: 500 },
  { name: "Basic", planType: "user", monthlyAllowance: 100, maxUnitsPerRequest: 20 },
  { name: "Premium", planType: "user", monthlyAllowance: 1_000, maxUnitsPerRequest: 100 },
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDatabase(attempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      if (attempt === 1) console.log("Waiting for the database ...");
      await sleep(1000);
    }
  }

  throw new Error("The database did not become reachable");
}

async function main(): Promise<void> {
  await waitForDatabase();

  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedRows = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const applied = new Set(appliedRows.rows.map((row) => row.filename));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    let appliedNow = 0;

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        appliedNow++;
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file} failed: ${reason}`);
      }
    }

    if (appliedNow === 0) console.log("Migrations: already up to date.");

    for (const plan of PREDEFINED_PLANS) {
      const result = await client.query(
        `
        INSERT INTO plans (
          name, plan_type, monthly_allowance, max_units_per_request,
          owner_account_id, is_predefined
        )
        SELECT $1::text, $2::text, $3::bigint, $4::bigint, NULL, TRUE
        WHERE NOT EXISTS (
          SELECT 1 FROM plans
          WHERE is_predefined = TRUE
            AND name = $1::text
            AND plan_type = $2::text
        )
        `,
        [
          plan.name,
          plan.planType,
          plan.monthlyAllowance,
          plan.maxUnitsPerRequest,
        ]
      );

      if (result.rowCount) {
        console.log(`Seeded predefined ${plan.planType} plan "${plan.name}"`);
      }
    }

    console.log("Database ready.");
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });