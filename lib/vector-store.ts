import { sql } from "./db";

/**
 * The storage seam behind the M3 retrieval index. `syncIndex` and `retrieveContext` (lib/retrieval.ts)
 * talk only to this interface, so the ingestion/retrieval logic is exercised in tests against an
 * in-memory implementation (`memoryStore`) while production uses Neon (`neonStore`). Both compute
 * cosine ranking — Postgres via the HNSW `<=>` operator, the in-memory store via `cosineDistance` —
 * so the ranking tests over `memoryStore` verify the same ordering the app relies on.
 */

export type IndexedChunk = { content: string; embedding: number[] };

export type PageInput = {
  id: string;
  source: string;
  title: string;
  hash: string;
  chunks: IndexedChunk[];
};

export type PageMeta = { id: string; hash: string };

export type Hit = { pageId: string; source: string; title: string; content: string; distance: number };

export interface VectorStore {
  /** Every indexed page's id + content hash — the basis for skip-unchanged and delete-removed. */
  listPages(): Promise<PageMeta[]>;
  /** Insert-or-replace a page and all of its chunks (wholesale re-chunk on change). */
  upsertPage(page: PageInput): Promise<void>;
  /** Remove pages (and, by cascade, their chunks) that no longer exist in the source. */
  deletePages(ids: string[]): Promise<void>;
  /** Top-k chunks nearest the query embedding by cosine distance (smaller = closer). */
  search(embedding: number[], k: number): Promise<Hit[]>;
}

// ---- pure helpers ----------------------------------------------------------

/**
 * Cosine distance in [0, 2]: 0 when the vectors point the same way, 1 when orthogonal, 2 when opposite.
 * Matches pgvector's `<=>` operator so the in-memory store ranks identically to the Neon HNSW index.
 * A zero-magnitude vector has no direction, so it is treated as maximally distant (2).
 */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  if (ma === 0 || mb === 0) return 2;
  return 1 - dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

/** Render a JS number[] as a pgvector text literal, e.g. `[0.1,0.2,0.3]`, for `$n::vector` params. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ---- in-memory store (tests + a safe default when no DB is configured) -----

/** A dependency-free VectorStore backed by a Map. Used by tests and as a drop-in for local runs. */
export function memoryStore(): VectorStore {
  const pages = new Map<string, { meta: PageMeta; source: string; title: string; chunks: IndexedChunk[] }>();
  return {
    async listPages() {
      return [...pages.values()].map((p) => ({ ...p.meta }));
    },
    async upsertPage(page) {
      pages.set(page.id, {
        meta: { id: page.id, hash: page.hash },
        source: page.source,
        title: page.title,
        chunks: page.chunks,
      });
    },
    async deletePages(ids) {
      for (const id of ids) pages.delete(id);
    },
    async search(embedding, k) {
      const hits: Hit[] = [];
      for (const p of pages.values()) {
        for (const c of p.chunks) {
          hits.push({
            pageId: p.meta.id,
            source: p.source,
            title: p.title,
            content: c.content,
            distance: cosineDistance(embedding, c.embedding),
          });
        }
      }
      hits.sort((x, y) => x.distance - y.distance);
      return hits.slice(0, Math.max(0, k));
    },
  };
}

// ---- Neon store (production) -----------------------------------------------

/**
 * The Postgres-backed VectorStore. Reads/writes go through the Neon HTTP driver (lib/db.ts); `sql()`
 * throws if DATABASE_URL is unset, so callers gate on `hasDatabase()` before constructing this.
 */
export function neonStore(): VectorStore {
  return {
    async listPages() {
      const rows = (await sql().query("SELECT id, content_hash FROM content_pages")) as Array<{
        id: string;
        content_hash: string;
      }>;
      return rows.map((r) => ({ id: r.id, hash: r.content_hash }));
    },

    async upsertPage(page) {
      // One transaction: replace the page row, drop its old chunks, insert the new ones. Atomic so a
      // partial write can never leave the page's hash marked current while its chunks are missing.
      await sql().transaction((txn) => {
        const qs = [
          txn.query(
            `INSERT INTO content_pages (id, source, title, content_hash, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (id) DO UPDATE SET
               source = EXCLUDED.source,
               title = EXCLUDED.title,
               content_hash = EXCLUDED.content_hash,
               updated_at = now()`,
            [page.id, page.source, page.title, page.hash],
          ),
          txn.query(`DELETE FROM content_chunks WHERE page_id = $1`, [page.id]),
        ];
        page.chunks.forEach((c, i) => {
          qs.push(
            txn.query(
              `INSERT INTO content_chunks (page_id, chunk_index, content, embedding)
               VALUES ($1, $2, $3, $4::vector)`,
              [page.id, i, c.content, toVectorLiteral(c.embedding)],
            ),
          );
        });
        return qs;
      });
    },

    async deletePages(ids) {
      if (ids.length === 0) return;
      // ON DELETE CASCADE clears the chunks.
      await sql().query(`DELETE FROM content_pages WHERE id = ANY($1)`, [ids]);
    },

    async search(embedding, k) {
      const rows = (await sql().query(
        `SELECT p.id AS page_id, p.source, p.title, c.content,
                (c.embedding <=> $1::vector) AS distance
           FROM content_chunks c
           JOIN content_pages p ON p.id = c.page_id
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2`,
        [toVectorLiteral(embedding), k],
      )) as Array<{ page_id: string; source: string; title: string; content: string; distance: number }>;
      return rows.map((r) => ({
        pageId: r.page_id,
        source: r.source,
        title: r.title,
        content: r.content,
        distance: Number(r.distance),
      }));
    },
  };
}
