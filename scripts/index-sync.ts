/**
 * One-way, idempotent Notion → Neon retrieval-index sync.
 *
 * Reads Lucy's Notion content (via the repo's existing Notion client), chunks + embeds what changed,
 * and upserts it into the Neon index — deleting anything that no longer exists in Notion. Notion stays
 * the source of truth; the index is a rebuildable derivative. Re-running with unchanged content is a
 * no-op (0 upserts, 0 embeds).
 *
 * Requires DATABASE_URL (Neon), OPENAI_API_KEY (embeddings), and the NOTION_* vars the app already
 * uses. Run after `scripts/db-migrate.ts` has provisioned the schema:
 *
 *   DATABASE_URL=... OPENAI_API_KEY=... npx tsx --env-file=.env.local scripts/index-sync.ts
 */
import { syncIndex } from "../lib/retrieval";
import { hasDatabase } from "../lib/db";

async function main(): Promise<void> {
  if (!hasDatabase()) throw new Error("Set DATABASE_URL to a Neon Postgres connection string.");
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY for embeddings.");

  console.log("Syncing Notion → Neon retrieval index …");
  const summary = await syncIndex();
  console.log(
    `\n✓ upserted=${summary.upserted} unchanged=${summary.unchanged} deleted=${summary.deleted} ` +
      `chunks=${summary.chunks} embedCalls=${summary.embedCalls}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
