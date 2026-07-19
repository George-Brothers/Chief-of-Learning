import { Client } from "@notionhq/client";
import { getEnv } from "./env";

function client(): Client {
  return new Client({ auth: getEnv().NOTION_TOKEN });
}

// ---- helpers -------------------------------------------------------------

/** Split a string into <=1900-char rich_text objects (Notion's per-object limit). */
function toRichText(s: string): Array<{ text: { content: string } }> {
  if (!s) return [];
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 1900) chunks.push(s.slice(i, i + 1900));
  return chunks.map((content) => ({ text: { content } }));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function plainText(prop: any): string {
  const arr = prop?.rich_text ?? prop?.title ?? [];
  return arr.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("");
}

function cjkTokens(s: string): string[] {
  return s.match(/[一-鿿]+/g) ?? [];
}

// ---- Evidence Inbox ------------------------------------------------------

export type EvidenceInput = {
  type: string;
  rawText: string;
  imageUrl?: string;
  source: string;
  distilled?: string;
};

export async function addEvidence(e: EvidenceInput): Promise<string> {
  const props: any = {
    Name: { title: toRichText(e.rawText.slice(0, 80) || e.type) },
    Type: { select: { name: e.type } },
    Raw: { rich_text: toRichText(e.rawText) },
    Source: { select: { name: e.source } },
    Processed: { checkbox: false },
  };
  if (e.imageUrl) props.Image = { url: e.imageUrl };
  if (e.distilled) props.Distilled = { rich_text: toRichText(e.distilled) };

  const page = (await client().pages.create({
    parent: { database_id: getEnv().NOTION_EVIDENCE_DB_ID },
    properties: props,
  })) as { id: string };
  return page.id;
}

export type EvidenceRow = {
  id: string;
  type: string;
  rawText: string;
  imageUrl?: string;
  distilled?: string;
};

function mapEvidence(res: { results: any[] }): EvidenceRow[] {
  return res.results.map((r: any) => ({
    id: r.id,
    type: r.properties?.Type?.select?.name ?? "",
    rawText: plainText(r.properties?.Raw),
    imageUrl: r.properties?.Image?.url ?? undefined,
    distilled: plainText(r.properties?.Distilled) || undefined,
  }));
}

export async function getUnprocessedEvidence(): Promise<EvidenceRow[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_EVIDENCE_DB_ID,
    filter: { property: "Processed", checkbox: { equals: false } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  });
  return mapEvidence(res as any);
}

/** Evidence from roughly the last 8 days — the week's raw material for the Sunday review. */
export async function getRecentEvidence(): Promise<EvidenceRow[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_EVIDENCE_DB_ID,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 60,
  });
  return mapEvidence(res as any);
}

export async function markProcessed(ids: string[]): Promise<void> {
  for (const id of ids) {
    await client().pages.update({ page_id: id, properties: { Processed: { checkbox: true } } });
  }
}

export type ActivityRow = {
  id: string;
  createdTime: string; // ISO timestamp
  type: string;
  summary: string; // distilled one-liner, falling back to raw text
};

/**
 * Recent Evidence rows with their timestamps + a human summary — the raw material for the dashboard's
 * streak and "recent activity" feed. Reuses the Evidence Inbox the Telegram path already writes to.
 */
export async function getRecentActivity(limit = 30): Promise<ActivityRow[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_EVIDENCE_DB_ID,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: Math.min(Math.max(limit, 1), 100),
  });
  return (res.results as any[]).map((r) => {
    let summary = "";
    const distilled = plainText(r.properties?.Distilled);
    if (distilled) {
      try {
        summary = (JSON.parse(distilled) as { summary?: string }).summary ?? "";
      } catch {
        /* fall through to raw */
      }
    }
    if (!summary) summary = plainText(r.properties?.Raw).slice(0, 120);
    return {
      id: r.id,
      createdTime: r.created_time,
      type: r.properties?.Type?.select?.name ?? "",
      summary,
    };
  });
}

/**
 * Evidence created-time timestamps within the last `days` window, following pagination so day-based
 * aggregates (streak, distinct study days) aren't silently capped by a single fetch's row count — an
 * active learner logging several pieces of evidence per day would otherwise truncate a long streak.
 */
export async function getActivityTimestamps(now: Date, days = 400): Promise<string[]> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client().databases.query({
      database_id: getEnv().NOTION_EVIDENCE_DB_ID,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 100,
      start_cursor: cursor,
      filter: { timestamp: "created_time", created_time: { on_or_after: cutoff } },
    });
    for (const r of res.results as any[]) out.push(r.created_time);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

export async function getLastActivityDate(): Promise<Date | null> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_EVIDENCE_DB_ID,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1,
  });
  const row = res.results[0] as any;
  return row ? new Date(row.created_time) : null;
}

// ---- Page documents (the four-doc brain + Today post-it) -----------------

/**
 * A page never legitimately reaches this many block pages: prependDoc caps content at keepChars
 * (≤20k chars), so even a pathological all-one-char-per-line doc stays under 20k blocks, well below
 * MAX_BLOCK_PAGES * 100. If listBlocks still sees `has_more` at the cap the read is being truncated —
 * and a truncated read is exactly the data-loss shape this pagination fixes (readDoc would drop the
 * tail, and prependDoc would then write that truncation back as the whole doc). So we throw rather
 * than return a partial list a caller would silently persist.
 */
const MAX_BLOCK_PAGES = 250;

/**
 * A zero-width, human-invisible commit sentinel appended as the LAST block of every writeDoc. Its
 * presence marks a write as fully committed: readDoc returns only the run of blocks terminated by the
 * last sentinel, so a write that failed partway (its sentinel never landed, even if its rollback also
 * failed to remove the partial blocks) and a stale region left by a failed delete (it sits before the
 * newest sentinel) are both impossible to read back as current content. Docs written before this
 * sentinel existed carry none, so readDoc falls back to reading them whole.
 */
const COMMIT_SENTINEL = "\u200B\u2060\u200B";

const sentinelBlock = () => ({
  object: "block" as const,
  type: "paragraph" as const,
  paragraph: { rich_text: toRichText(COMMIT_SENTINEL) },
});

/** Every child block of a page, following pagination (Notion returns at most 100 children per call). */
async function listBlocks(pageId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BLOCK_PAGES; page++) {
    const res = (await client().blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    })) as any;
    out.push(...((res.results as any[]) ?? []));
    if (!res.has_more || !res.next_cursor) return out;
    cursor = res.next_cursor;
  }
  throw new Error(
    `listBlocks: ${pageId} still paginating after ${MAX_BLOCK_PAGES} pages ` +
      `(${MAX_BLOCK_PAGES * 100} blocks) — refusing to read a truncated doc`,
  );
}

/** A block's rendered text, or null when it carries no rich_text (matches readDoc's line model). */
function blockText(b: any): string | null {
  const rich = b[b.type]?.rich_text;
  return Array.isArray(rich) ? rich.map((t: any) => t.plain_text ?? "").join("") : null;
}

async function readDoc(pageId: string): Promise<string> {
  const lines = (await listBlocks(pageId)).map(blockText);
  // Return only the last fully-committed write: the run of blocks terminated by the last commit
  // sentinel (from just after the second-to-last sentinel up to, but excluding, the last one). A write
  // that failed partway never wrote its sentinel, and a stale region left by a failed delete sits
  // before the newest sentinel, so neither can be mistaken for current content.
  const sentinels: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === COMMIT_SENTINEL) sentinels.push(i);
  if (sentinels.length === 0) {
    return lines.filter((l): l is string => l !== null).join("\n"); // legacy/fresh doc: read whole
  }
  const last = sentinels[sentinels.length - 1];
  const prev = sentinels.length >= 2 ? sentinels[sentinels.length - 2] : -1;
  return lines.slice(prev + 1, last).filter((l): l is string => l !== null).join("\n");
}

/** Delete blocks, tolerating individual failures. Returns how many refused to go. */
async function deleteBlocks(ids: string[]): Promise<number> {
  let failed = 0;
  for (const id of ids) {
    try {
      await client().blocks.delete({ block_id: id });
    } catch {
      failed++;
    }
  }
  return failed;
}

/**
 * Replace a doc's contents. Append-then-delete, never delete-then-append: these docs are the brain's
 * only copy of their state, so a 429 or a network blip mid-write must leave the old text standing
 * rather than a blank or half-written page. The write is committed only when its trailing sentinel
 * lands (see COMMIT_SENTINEL). The two failure modes:
 *
 *   - append fails: roll back the blocks we added. The sentinel is the final append, so a partial
 *     write never has one; even if the rollback deletes also fail, readDoc ignores the un-terminated
 *     partial blocks and still returns the previous committed content.
 *   - delete fails: the doc holds the old committed unit before the new one. Stale, but never lost. We
 *     throw so the owner hears about it, readDoc returns only the new unit (so a prepend can't
 *     re-capture the leftover), and the next write snapshots the whole page and clears it. readDoc
 *     brackets the current unit between the last TWO sentinels, so that "only the new unit" guarantee
 *     holds only while the old trailing sentinel outlives any surviving old content. We therefore
 *     retire the stale CONTENT first and delete the old sentinel(s) ONLY once every stale content
 *     block is confirmed gone — a 429 on old content must never leave stale content in front of a lone
 *     sentinel, which readDoc would merge into the new unit.
 */
async function writeDoc(pageId: string, text: string): Promise<void> {
  const staleContent: string[] = [];
  const staleSentinels: string[] = [];
  for (const b of await listBlocks(pageId)) {
    (blockText(b) === COMMIT_SENTINEL ? staleSentinels : staleContent).push(b.id);
  }
  const content = text.split("\n").map((line) => ({
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: toRichText(line) },
  }));

  // 1. Land the new content, then a single trailing commit sentinel as the FINAL append. Its presence
  //    is what marks the write committed, so a write that fails partway can never be read back.
  const appended: string[] = [];
  try {
    // Notion caps appends at 100 blocks; keep docs comfortably under that.
    for (let i = 0; i < content.length; i += 90) {
      const res = (await client().blocks.children.append({
        block_id: pageId,
        children: content.slice(i, i + 90),
      })) as any;
      for (const b of ((res?.results as any[]) ?? [])) appended.push(b.id);
    }
    const res = (await client().blocks.children.append({
      block_id: pageId,
      children: [sentinelBlock()],
    })) as any;
    for (const b of ((res?.results as any[]) ?? [])) appended.push(b.id);
  } catch (e) {
    await deleteBlocks(appended);
    throw e;
  }

  // 2. Only once the new write is committed (sentinel landed), retire the old region — content first,
  //    then the old sentinel(s) LAST and only if every stale content block is gone. Leaving the old
  //    sentinel whenever any old content survives keeps that content bracketed out of the new unit.
  const failedContent = await deleteBlocks(staleContent);
  const failedSentinels =
    failedContent === 0 ? await deleteBlocks(staleSentinels) : staleSentinels.length;
  const failed = failedContent + failedSentinels;
  if (failed > 0) {
    throw new Error(
      `writeDoc: wrote ${pageId} but ${failed} stale block(s) would not delete — the doc now holds ` +
        `the old committed unit before the new one; readDoc ignores it and the next write clears it.`,
    );
  }
}

/** Put `text` at the TOP of a doc (newest-first log style). */
async function prependDoc(pageId: string, text: string, keepChars = 12000): Promise<void> {
  const existing = await readDoc(pageId);
  await writeDoc(pageId, `${text}\n\n${existing}`.slice(0, keepChars));
}

const env = () => getEnv();

export const readLedger = () => readDoc(env().NOTION_LEDGER_PAGE_ID);
export const readStudyMap = () => readDoc(env().NOTION_STUDYMAP_PAGE_ID);
export const readDailyLog = () => readDoc(env().NOTION_DAILYLOG_PAGE_ID);
export const readGradebook = () => readDoc(env().NOTION_GRADEBOOK_PAGE_ID);

export const readScorecard = () => readDoc(env().NOTION_SCORECARD_PAGE_ID);
export const writeScorecard = (text: string) => writeDoc(env().NOTION_SCORECARD_PAGE_ID, text);

export const readRetained = () => readDoc(env().NOTION_RETAINED_PAGE_ID);
export const writeRetained = (text: string) => writeDoc(env().NOTION_RETAINED_PAGE_ID, text);

export type ListeningPending = { expected: string; sentence: string; ts: string };
const LISTEN_SEP = "--- RESULTS ---";
const readListeningRaw = () => readDoc(env().NOTION_LISTENING_PAGE_ID);

export async function readListeningPending(): Promise<ListeningPending | null> {
  const raw = await readListeningRaw();
  const first = raw.split("\n")[0] ?? "";
  const json = first.startsWith("PENDING:") ? first.slice("PENDING:".length).trim() : "";
  if (!json) return null;
  try { return JSON.parse(json) as ListeningPending; } catch { return null; }
}

export async function writeListeningPending(p: ListeningPending): Promise<void> {
  const raw = await readListeningRaw();
  const i = raw.indexOf(LISTEN_SEP);
  const results = i >= 0 ? raw.slice(i + LISTEN_SEP.length).trim() : "";
  await writeDoc(env().NOTION_LISTENING_PAGE_ID, `PENDING: ${JSON.stringify(p)}\n${LISTEN_SEP}${results ? "\n" + results : ""}`);
}

export async function recordListeningResult(ok: boolean, word: string, date: string): Promise<void> {
  const raw = await readListeningRaw();
  const i = raw.indexOf(LISTEN_SEP);
  const results = i >= 0 ? raw.slice(i + LISTEN_SEP.length).trim() : "";
  const line = `${date} ${ok ? "✓" : "✗"} ${word}`;
  await writeDoc(env().NOTION_LISTENING_PAGE_ID, `PENDING:\n${LISTEN_SEP}\n${line}${results ? "\n" + results : ""}`);
}

export async function getListeningStats(): Promise<{ correct: number; total: number }> {
  const raw = await readListeningRaw();
  const i = raw.indexOf(LISTEN_SEP);
  const lines = (i >= 0 ? raw.slice(i + LISTEN_SEP.length).trim() : "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20);
  return { correct: lines.filter((l) => l.includes("✓")).length, total: lines.length };
}

/** SRS-confirmed words (Anki mature cards), synced by the local agent. Distinct from the
 *  EXPOSED set in getKnownWords() — this is what coverage/pace should be computed on. */
export async function getRetainedWords(): Promise<string[]> {
  const words = new Set<string>();
  for (const w of cjkTokens(await readRetained())) words.add(w);
  return [...words];
}

export type Assignment = { id: string; kind: string; description: string };

export async function addAssignment(a: { kind: string; description: string; date: string }): Promise<string> {
  const page = (await client().pages.create({
    parent: { database_id: getEnv().NOTION_ASSIGNMENTS_DB_ID },
    properties: {
      Name: { title: toRichText(`${a.kind}: ${a.description}`.slice(0, 90)) },
      Type: { select: { name: a.kind } },
      Description: { rich_text: toRichText(a.description) },
      Status: { select: { name: "open" } },
      Created: { rich_text: toRichText(a.date) },
    },
  })) as { id: string };
  return page.id;
}

export async function getOpenAssignments(): Promise<Assignment[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_ASSIGNMENTS_DB_ID,
    filter: { property: "Status", select: { equals: "open" } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  });
  return (res.results as any[]).map((r) => ({
    id: r.id,
    kind: r.properties?.Type?.select?.name ?? "",
    description: plainText(r.properties?.Description),
  }));
}

export async function markAssignmentDone(id: string): Promise<void> {
  await client().pages.update({ page_id: id, properties: { Status: { select: { name: "done" } } } });
}

export const writeToday = (text: string) => writeDoc(env().NOTION_TODAY_PAGE_ID, text);
export const prependDailyLog = (entry: string) => prependDoc(env().NOTION_DAILYLOG_PAGE_ID, entry);
export const appendLedgerNotes = (notes: string) =>
  prependDoc(env().NOTION_LEDGER_PAGE_ID, notes, 20000);
export const writeGradebook = (text: string) => writeDoc(env().NOTION_GRADEBOOK_PAGE_ID, text);

/** The head teacher's one-line focus for the week, stored on line 1 of the Gradebook. */
export async function getWeekFocus(): Promise<string> {
  const gb = await readGradebook();
  const line = gb.split("\n").find((l) => l.trim().toUpperCase().startsWith("WEEK FOCUS:"));
  return line ? line.replace(/^\s*week focus:\s*/i, "").trim() : "";
}

// ---- Known words (drives Pleco de-dupe + calibration) --------------------

export async function getKnownWords(): Promise<string[]> {
  const words = new Set<string>();

  // 1. Everything in the Knowledge Ledger.
  for (const w of cjkTokens(await readLedger())) words.add(w);

  // 2. Syllabus Index vocab.
  const syl = await client().databases.query({
    database_id: env().NOTION_SYLLABUS_DB_ID,
    page_size: 100,
  });
  for (const r of syl.results as any[]) for (const w of cjkTokens(plainText(r.properties?.Vocab))) words.add(w);

  // 3. Words in decks already generated.
  const decks = await client().databases.query({
    database_id: env().NOTION_DECKS_DB_ID,
    page_size: 100,
  });
  for (const r of decks.results as any[]) for (const w of cjkTokens(plainText(r.properties?.Headwords))) words.add(w);

  return [...words];
}

// ---- Decks + Syllabus (also used by the seed script) ---------------------

export type DeckArchive = {
  name: string;
  source: string;
  headwords: string;
  count: number;
  deckText: string;
};

export async function archiveDeck(d: DeckArchive): Promise<void> {
  await client().pages.create({
    parent: { database_id: env().NOTION_DECKS_DB_ID },
    properties: {
      Name: { title: toRichText(d.name) },
      Source: { select: { name: d.source } },
      Count: { number: d.count },
      Headwords: { rich_text: toRichText(d.headwords) },
      Deck: { rich_text: toRichText(d.deckText) },
    } as any,
  });
}

export async function addSyllabusRow(r: {
  chapter: string;
  section: string;
  vocab: string;
  grammar: string;
}): Promise<void> {
  await client().pages.create({
    parent: { database_id: env().NOTION_SYLLABUS_DB_ID },
    properties: {
      Chapter: { title: toRichText(r.chapter) },
      Section: { select: { name: r.section } },
      Vocab: { rich_text: toRichText(r.vocab) },
      Grammar: { rich_text: toRichText(r.grammar) },
    } as any,
  });
}

// ---- Lessons ---------------------------------------------------------------

export type LessonRow = {
  id: string;
  date: string;
  summary: string;
  weakSignals: string;
  homework: string;
  vocabCount: number;
  noteJson: string;
};

export async function lessonExists(hash: string): Promise<boolean> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_LESSONS_DB_ID,
    filter: { property: "Hash", rich_text: { equals: hash } },
    page_size: 1,
  });
  return res.results.length > 0;
}

export async function addLesson(l: {
  date: string;
  hash: string;
  summary: string;
  weakSignals: string;
  homework: string;
  vocabCount: number;
  noteJson: string;
  transcript: string;
}): Promise<string> {
  const page = (await client().pages.create({
    parent: { database_id: getEnv().NOTION_LESSONS_DB_ID },
    properties: {
      Name: { title: toRichText(`Lesson ${l.date}`) },
      Date: { rich_text: toRichText(l.date) },
      Hash: { rich_text: toRichText(l.hash) },
      Summary: { rich_text: toRichText(l.summary) },
      WeakSignals: { rich_text: toRichText(l.weakSignals) },
      Homework: { rich_text: toRichText(l.homework) },
      VocabCount: { number: l.vocabCount },
      Note: { rich_text: toRichText(l.noteJson) },
      Processed: { checkbox: false },
    },
  })) as { id: string };
  // Archive the raw transcript in the page body, chunked into ≤90-block batches.
  const paras = l.transcript.split("\n").filter((s) => s.length > 0);
  for (let i = 0; i < paras.length; i += 90) {
    await client().blocks.children.append({
      block_id: page.id,
      children: paras.slice(i, i + 90).map((line) => ({
        object: "block" as const,
        type: "paragraph" as const,
        paragraph: { rich_text: toRichText(line) },
      })),
    });
  }
  return page.id;
}

export async function getUnprocessedLessons(): Promise<LessonRow[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_LESSONS_DB_ID,
    filter: { property: "Processed", checkbox: { equals: false } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  });
  return (res.results as any[]).map((r) => ({
    id: r.id,
    date: plainText(r.properties?.Date),
    summary: plainText(r.properties?.Summary),
    weakSignals: plainText(r.properties?.WeakSignals),
    homework: plainText(r.properties?.Homework),
    vocabCount: r.properties?.VocabCount?.number ?? 0,
    noteJson: plainText(r.properties?.Note),
  }));
}

export async function markLessonsProcessed(ids: string[]): Promise<void> {
  for (const id of ids) {
    await client().pages.update({ page_id: id, properties: { Processed: { checkbox: true } } });
  }
}

// ---- Action Queue -----------------------------------------------------------

export type QueuedAction = { id: string; type: string; payload: string };

export async function enqueueAction(a: { type: string; payload: string }): Promise<string> {
  const page = (await client().pages.create({
    parent: { database_id: getEnv().NOTION_ACTIONQUEUE_DB_ID },
    properties: {
      Name: { title: toRichText(a.type) },
      Type: { select: { name: a.type } },
      Payload: { rich_text: toRichText(a.payload) },
      Status: { select: { name: "queued" } },
    },
  })) as { id: string };
  return page.id;
}

export async function getQueuedActions(): Promise<QueuedAction[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_ACTIONQUEUE_DB_ID,
    filter: { property: "Status", select: { equals: "queued" } },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  });
  return (res.results as any[]).map((r) => ({
    id: r.id,
    type: r.properties?.Type?.select?.name ?? "",
    payload: plainText(r.properties?.Payload),
  }));
}

export async function markActionDone(id: string, result: string, ok: boolean): Promise<void> {
  await client().pages.update({
    page_id: id,
    properties: {
      Status: { select: { name: ok ? "done" : "error" } },
      Result: { rich_text: toRichText(result.slice(0, 1900)) },
    },
  });
}

export async function getAction(id: string): Promise<{ type: string; payload: string; status: string } | null> {
  try {
    const page = (await client().pages.retrieve({ page_id: id })) as any;
    return {
      type: page.properties?.Type?.select?.name ?? "",
      payload: plainText(page.properties?.Payload),
      status: page.properties?.Status?.select?.name ?? "",
    };
  } catch {
    return null;
  }
}

export type SyllabusRow = { chapter: string; section: string; vocab: string; grammar: string };

export async function readSyllabus(): Promise<SyllabusRow[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_SYLLABUS_DB_ID,
    page_size: 100,
  });
  return (res.results as any[]).map((r) => ({
    chapter: plainText(r.properties?.Chapter),
    section: r.properties?.Section?.select?.name ?? "",
    vocab: plainText(r.properties?.Vocab),
    grammar: plainText(r.properties?.Grammar),
  }));
}

export async function getRecentLessons(limit: number): Promise<LessonRow[]> {
  const res = await client().databases.query({
    database_id: getEnv().NOTION_LESSONS_DB_ID,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: limit,
  });
  return (res.results as any[]).map((r) => ({
    id: r.id,
    date: plainText(r.properties?.Date),
    summary: plainText(r.properties?.Summary),
    weakSignals: plainText(r.properties?.WeakSignals),
    homework: plainText(r.properties?.Homework),
    vocabCount: r.properties?.VocabCount?.number ?? 0,
    noteJson: plainText(r.properties?.Note),
  }));
}
