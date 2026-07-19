/**
 * Apply the Neon retrieval-index schema (db/schema.sql) to DATABASE_URL.
 *
 * The repo has no ORM, so this is a minimal raw-SQL migration: every statement in db/schema.sql is
 * idempotent (CREATE ... IF NOT EXISTS / CREATE EXTENSION IF NOT EXISTS), so re-running is safe. The
 * Neon HTTP driver runs one statement per round-trip, so we split the file on `;` boundaries. Notion
 * remains the source of truth — this only provisions the derived read index.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/db-migrate.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "../lib/db";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL to a Neon Postgres connection string to run the migration.");
  }
  const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
  const raw = readFileSync(schemaPath, "utf8");
  // Strip line comments, then split into statements. The schema deliberately contains no `;` inside
  // any literal or function body, so a naive split is correct here.
  const statements = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const db = sql();
  for (const stmt of statements) {
    const label = stmt.replace(/\s+/g, " ").slice(0, 70);
    process.stdout.write(`  ${label} … `);
    await db.query(stmt);
    console.log("✓");
  }
  console.log(`\n✓ Applied ${statements.length} statement(s) to the Neon retrieval index.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
