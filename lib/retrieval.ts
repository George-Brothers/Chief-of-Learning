import { contentHash } from "../agent/hash";
import { embedTexts, type Embedder } from "./embeddings";
import { hasDatabase } from "./db";
import { getEnv } from "./env";
import {
  neonStore,
  type Hit,
  type VectorStore,
} from "./vector-store";
import {
  readLedger,
  readStudyMap,
  readDailyLog,
  readGradebook,
  readScorecard,
  getRecentLessons,
  readSyllabus,
  getRecentEvidence,
} from "./notion";

/**
 * The M3 retrieval index — Notion → Neon ingestion and top-k retrieval for prompt assembly.
 *
 * Notion stays the source of truth; this is a one-way, idempotent, rebuildable read index. `syncIndex`
 * pulls Notion content (via the repo's existing Notion client), chunks + embeds what changed, and keeps
 * the index consistent (skip-unchanged by hash, delete-removed). `retrieveContext` is ADDITIVE and
 * fail-open: on any problem — no DB, no key, empty index, network error — it returns "" so the caller
 * falls back to today's Notion-only behavior and the bot never breaks.
 */

export type SourceDoc = { id: string; source: string; title: string; text: string };

const DEFAULT_CHUNK_CHARS = 800;
const DEFAULT_TOP_K = 6;
const MAX_CONTEXT_CHARS = 2500;

/**
 * Split text into chunks of at most `maxChars`, breaking on paragraph/line boundaries and packing
 * greedily. A single line longer than `maxChars` is hard-split so no chunk exceeds the budget. Pure and
 * deterministic — the unit tests pin its behavior.
 */
export function chunkText(text: string, maxChars = DEFAULT_CHUNK_CHARS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const rawLine of clean.split("\n")) {
    let line = rawLine;
    while (line.length > maxChars) {
      // A single over-long line: emit whatever's buffered, then hard-split the line.
      flush();
      chunks.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
    if (cur.length + line.length + 1 > maxChars) flush();
    cur = cur ? `${cur}\n${line}` : line;
  }
  flush();
  return chunks;
}

/** Run `fn`, returning [] on any failure so one bad Notion read never aborts the whole collection. */
async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn("collectSources: a source failed and was skipped", err);
    return [];
  }
}

async function doc(id: string, source: string, title: string, read: () => Promise<string>): Promise<SourceDoc[]> {
  try {
    const text = await read();
    return text.trim() ? [{ id, source, title, text }] : [];
  } catch (err) {
    console.warn(`collectSources: ${id} failed and was skipped`, err);
    return [];
  }
}

/**
 * Gather the Notion content worth indexing for retrieval: the four-doc brain, the scorecard, recent
 * lessons, the syllabus, and recent evidence. Each source is read independently and fail-soft, so a
 * transient Notion error on one document degrades to a smaller index rather than aborting the sync.
 */
export async function collectSources(): Promise<SourceDoc[]> {
  const [brain, lessons, syllabus, evidence] = await Promise.all([
    Promise.all([
      doc("doc:ledger", "ledger", "Knowledge Ledger", readLedger),
      doc("doc:studymap", "studymap", "Study Map", readStudyMap),
      doc("doc:dailylog", "dailylog", "Daily Log", readDailyLog),
      doc("doc:gradebook", "gradebook", "Gradebook", readGradebook),
      doc("doc:scorecard", "scorecard", "HSK Scorecard", readScorecard),
    ]).then((parts) => parts.flat()),
    safe(() => getRecentLessons(20)).then((rows) =>
      rows.map((l) => ({
        id: `lesson:${l.id}`,
        source: "lesson",
        title: `Lesson ${l.date}`,
        text: [
          `Lesson ${l.date}`,
          l.summary && `Summary: ${l.summary}`,
          l.weakSignals && `Weak signals: ${l.weakSignals}`,
          l.homework && `Homework: ${l.homework}`,
        ]
          .filter(Boolean)
          .join("\n"),
      })),
    ),
    safe(() => readSyllabus()).then((rows) =>
      rows.map((r, i) => ({
        id: `syllabus:${r.chapter || i}`,
        source: "syllabus",
        title: r.chapter || `Syllabus ${i}`,
        text: [`${r.chapter} / ${r.section}`, r.vocab && `Vocab: ${r.vocab}`, r.grammar && `Grammar: ${r.grammar}`]
          .filter(Boolean)
          .join("\n"),
      })),
    ),
    safe(() => getRecentEvidence()).then((rows) =>
      rows.map((r) => ({
        id: `evidence:${r.id}`,
        source: "evidence",
        title: r.type || "evidence",
        text: `${r.type}: ${r.distilled || r.rawText}`,
      })),
    ),
  ]);
  return [...brain, ...lessons, ...syllabus, ...evidence].filter((d) => d.text.trim());
}

export type SyncSummary = {
  upserted: number;
  unchanged: number;
  deleted: number;
  chunks: number;
  embedCalls: number;
};

/**
 * One-way, idempotent Notion → index sync. For each collected source: skip when its content hash is
 * unchanged, otherwise re-chunk + re-embed and upsert. Any indexed page whose source has disappeared is
 * deleted. Re-running with unchanged Notion content is a no-op (0 upserts, 0 embeds, 0 deletes) — the
 * property the idempotency test asserts. Store and embedder are injectable for testing.
 */
export async function syncIndex(opts?: {
  store?: VectorStore;
  embed?: Embedder;
  sources?: SourceDoc[];
  chunkChars?: number;
}): Promise<SyncSummary> {
  const store = opts?.store ?? neonStore();
  const embed = opts?.embed ?? embedTexts;
  const sources = opts?.sources ?? (await collectSources());
  const chunkChars = opts?.chunkChars ?? DEFAULT_CHUNK_CHARS;

  const existing = new Map((await store.listPages()).map((p) => [p.id, p.hash]));
  const seen = new Set<string>();
  const summary: SyncSummary = { upserted: 0, unchanged: 0, deleted: 0, chunks: 0, embedCalls: 0 };

  for (const src of sources) {
    seen.add(src.id);
    const hash = contentHash(`${src.source}\n${src.title}\n${src.text}`);
    if (existing.get(src.id) === hash) {
      summary.unchanged++;
      continue;
    }
    const parts = chunkText(src.text, chunkChars);
    if (parts.length === 0) continue;
    const vectors = await embed(parts);
    summary.embedCalls++;
    await store.upsertPage({
      id: src.id,
      source: src.source,
      title: src.title,
      hash,
      chunks: parts.map((content, i) => ({ content, embedding: vectors[i] })),
    });
    summary.upserted++;
    summary.chunks += parts.length;
  }

  const stale = [...existing.keys()].filter((id) => !seen.has(id));
  if (stale.length) {
    await store.deletePages(stale);
    summary.deleted = stale.length;
  }
  return summary;
}

/** Render hits into a compact, source-labeled block for the prompt. */
export function formatHits(hits: Hit[]): string {
  return hits
    .map((h) => `- [${h.source}] ${h.content.replace(/\s+/g, " ").trim()}`)
    .join("\n")
    .slice(0, MAX_CONTEXT_CHARS);
}

/**
 * Retrieve the most relevant indexed content for a query. ADDITIVE + fail-open: returns "" whenever the
 * index can't help (no DATABASE_URL, no OPENAI_API_KEY, empty index, or any error), so the caller keeps
 * today's Notion-only behavior. Never throws.
 */
export async function retrieveContext(
  query: string,
  opts?: { store?: VectorStore; embed?: Embedder; k?: number },
): Promise<string> {
  try {
    const q = query.trim();
    if (!q) return "";
    // Without an injected store, we need a real DB + embedding key; otherwise there's nothing to hit.
    if (!opts?.store) {
      if (!hasDatabase()) return "";
      const key = getEnv().OPENAI_API_KEY;
      if (!key || !key.trim()) return "";
    }
    const store = opts?.store ?? neonStore();
    const embed = opts?.embed ?? embedTexts;
    const [qv] = await embed([q]);
    if (!qv) return "";
    const hits = await store.search(qv, opts?.k ?? DEFAULT_TOP_K);
    if (!hits.length) return "";
    return formatHits(hits);
  } catch (err) {
    console.warn("retrieveContext failed — falling back to Notion-only context", err);
    return "";
  }
}
