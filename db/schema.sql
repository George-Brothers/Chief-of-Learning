-- Lucy M3 — derived semantic retrieval index (Neon Postgres + pgvector).
--
-- Notion stays the SOURCE OF TRUTH and the captain's read/edit face. This schema is a REBUILDABLE,
-- one-way-derived read index: it is populated only by `scripts/index-sync.ts` from Notion content and
-- can be dropped and rebuilt at any time without data loss. No write path in the app targets it.
--
-- Every statement is idempotent (IF NOT EXISTS), so re-running this file is a no-op on an up-to-date
-- database — see scripts/db-migrate.ts, which splits and runs each statement over the Neon HTTP driver.

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per indexed Notion source (a brain doc, a lesson, a syllabus row, …). `content_hash` is the
-- sha256 of the source's full text: index-sync skips re-embedding a page whose hash is unchanged, and
-- deletes pages that no longer appear in Notion, keeping the index consistent on every re-run.
CREATE TABLE IF NOT EXISTS content_pages (
  id           TEXT PRIMARY KEY,               -- stable source id, e.g. "doc:ledger" or "lesson:<notion-id>"
  source       TEXT NOT NULL,                  -- coarse kind: ledger | studymap | dailylog | gradebook | lesson | syllabus | evidence
  title        TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chunked, embedded content. A page is re-chunked wholesale on change (delete-then-insert inside one
-- transaction), so (page_id, chunk_index) is the natural key. Embeddings are text-embedding-3-small,
-- which is natively 1536-dim — the column width and that model id must stay in lockstep.
CREATE TABLE IF NOT EXISTS content_chunks (
  id          BIGSERIAL PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES content_pages(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536) NOT NULL,
  UNIQUE (page_id, chunk_index)
);

-- HNSW index for cosine-distance (<=>) top-k search. Cosine matches OpenAI embedding conventions.
CREATE INDEX IF NOT EXISTS content_chunks_embedding_idx
  ON content_chunks USING hnsw (embedding vector_cosine_ops);

-- Speeds up per-page chunk deletion during re-sync.
CREATE INDEX IF NOT EXISTS content_chunks_page_idx ON content_chunks (page_id);
