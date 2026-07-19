import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { getEnv } from "./env";

/**
 * Neon Postgres access for the M3 derived retrieval index.
 *
 * `DATABASE_URL` is OPTIONAL (see lib/env.ts): the retrieval layer is additive over Notion, so the app
 * must boot and run without a database. Callers that need the index check `hasDatabase()` first and
 * fall back to Notion-only behavior when it's false; only code that genuinely requires the DB (the
 * ingestion + migration scripts, and the vector store) calls `sql()`, which fails closed with a clear
 * message when the URL is unset.
 *
 * We use the Neon HTTP driver (`neon()`), which runs one SQL statement per round-trip — a good fit for
 * short serverless requests. Multi-statement work (the schema migration) is split by the caller; atomic
 * multi-row writes go through `sql.transaction([...])` in lib/vector-store.ts.
 */

export function hasDatabase(): boolean {
  const url = getEnv().DATABASE_URL;
  return Boolean(url && url.trim());
}

let cached: { url: string; sql: NeonQueryFunction<false, false> } | undefined;

/** The Neon query function for the configured `DATABASE_URL`. Throws (fail closed) when it's unset. */
export function sql(): NeonQueryFunction<false, false> {
  const url = getEnv().DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error(
      "DATABASE_URL is not set — the Neon retrieval index is unavailable. Set it to a Neon Postgres " +
        "connection string, or leave it unset to run Notion-only (retrieval falls back automatically).",
    );
  }
  // Re-create only when the URL changes, so tests can flip env between calls.
  if (!cached || cached.url !== url) cached = { url, sql: neon(url) };
  return cached.sql;
}
