import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const pages = { create: vi.fn(async () => ({ id: "pg1" })), update: vi.fn(async () => ({})) };
const databases = { query: vi.fn(async () => ({ results: [] })) };
const blocks = {
  children: { list: vi.fn(async () => ({ results: [] })), append: vi.fn(async () => ({})) },
  delete: vi.fn(async () => ({})),
};

vi.mock("@notionhq/client", () => ({ Client: vi.fn(() => ({ pages, databases, blocks })) }));

beforeEach(() => {
  Object.assign(process.env, FULL_ENV);
  pages.create.mockClear();
  databases.query.mockClear();
  blocks.children.list.mockClear();
});

describe("notion store", () => {
  it("addEvidence creates a page and returns its id", async () => {
    const { addEvidence } = await import("../lib/notion");
    const id = await addEvidence({ type: "check-in", rawText: "did 30m", source: "telegram" });
    expect(id).toBe("pg1");
    expect(pages.create).toHaveBeenCalledOnce();
  });

  it("getKnownWords extracts CJK tokens from syllabus + decks", async () => {
    databases.query
      .mockResolvedValueOnce({ results: [{ properties: { Vocab: { rich_text: [{ plain_text: "好 书" }] } } }] } as any)
      .mockResolvedValueOnce({ results: [{ properties: { Headwords: { rich_text: [{ plain_text: "尴尬" }] } } }] } as any);
    const { getKnownWords } = await import("../lib/notion");
    const words = await getKnownWords();
    expect(words).toEqual(expect.arrayContaining(["好", "书", "尴尬"]));
  });

  it("getLastActivityDate returns the newest created_time or null", async () => {
    databases.query.mockResolvedValueOnce({ results: [] } as any);
    const { getLastActivityDate } = await import("../lib/notion");
    expect(await getLastActivityDate()).toBeNull();
  });

  it("lessonExists queries by hash and reports presence", async () => {
    databases.query.mockResolvedValueOnce({ results: [{ id: "L1" }] } as any);
    const { lessonExists } = await import("../lib/notion");
    expect(await lessonExists("abc123")).toBe(true);
    expect(databases.query).toHaveBeenCalledWith(
      expect.objectContaining({ database_id: "lessons-db" }),
    );
  });

  it("enqueueAction creates a queued row and returns its id", async () => {
    pages.create.mockResolvedValueOnce({ id: "A1" } as any);
    const { enqueueAction } = await import("../lib/notion");
    const id = await enqueueAction({ type: "create_anki_cards", payload: '{"cards":[]}' });
    expect(id).toBe("A1");
    const arg = pages.create.mock.calls.at(-1)![0] as any;
    expect(arg.parent.database_id).toBe("queue-db");
    expect(arg.properties.Status.select.name).toBe("queued");
  });

  it("getRecentLessons queries newest-first and maps rows", async () => {
    databases.query.mockResolvedValueOnce({
      results: [{ id: "L9", properties: { Date: { rich_text: [{ plain_text: "2026-07-14" }] }, VocabCount: { number: 3 }, Note: { rich_text: [{ plain_text: "{}" }] } } }],
    } as any);
    const { getRecentLessons } = await import("../lib/notion");
    const rows = await getRecentLessons(3);
    expect(rows[0].id).toBe("L9");
    const arg = databases.query.mock.calls.at(-1)![0] as any;
    expect(arg.database_id).toBe("lessons-db");
    expect(arg.page_size).toBe(3);
    expect(arg.sorts[0].direction).toBe("descending");
  });

  it("getAction retrieves a single action's payload and status", async () => {
    pages.retrieve = vi.fn(async () => ({
      properties: { Type: { select: { name: "create_anki_cards" } }, Payload: { rich_text: [{ plain_text: '{"notify":true}' }] }, Status: { select: { name: "done" } } },
    })) as any;
    const { getAction } = await import("../lib/notion");
    const a = await getAction("A1");
    expect(a?.type).toBe("create_anki_cards");
    expect(a?.payload).toBe('{"notify":true}');
    expect(a?.status).toBe("done");
  });

  it("readSyllabus maps chapter rows", async () => {
    databases.query.mockResolvedValueOnce({
      results: [{ properties: { Chapter: { title: [{ plain_text: "IC L5" }] }, Section: { select: { name: "textbook" } }, Vocab: { rich_text: [{ plain_text: "跳舞 唱歌" }] }, Grammar: { rich_text: [{ plain_text: "喜欢+V" }] } } }],
    } as any);
    const { readSyllabus } = await import("../lib/notion");
    const rows = await readSyllabus();
    expect(rows[0]).toEqual({ chapter: "IC L5", section: "textbook", vocab: "跳舞 唱歌", grammar: "喜欢+V" });
  });

  it("getRetainedWords tokenizes the retained page", async () => {
    blocks.children.list.mockResolvedValueOnce({
      results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "跳舞 唱歌" }] } }],
    } as any);
    const { getRetainedWords } = await import("../lib/notion");
    expect(await getRetainedWords()).toEqual(["跳舞", "唱歌"]);
  });

  it("addAssignment creates an open row", async () => {
    pages.create.mockResolvedValueOnce({ id: "AS1" } as any);
    const { addAssignment } = await import("../lib/notion");
    const id = await addAssignment({ kind: "reading", description: "Du Chinese HSK1 story", date: "2026-07-15" });
    expect(id).toBe("AS1");
    const arg = pages.create.mock.calls.at(-1)![0] as any;
    expect(arg.parent.database_id).toBe("assignments-db");
    expect(arg.properties.Status.select.name).toBe("open");
    expect(arg.properties.Type.select.name).toBe("reading");
  });
  it("getOpenAssignments filters open + maps rows", async () => {
    databases.query.mockResolvedValueOnce({ results: [
      { id: "AS1", properties: { Type: { select: { name: "drill" } }, Description: { rich_text: [{ plain_text: "rewrite 5" }] } } },
    ] } as any);
    const { getOpenAssignments } = await import("../lib/notion");
    const rows = await getOpenAssignments();
    expect(rows[0]).toEqual({ id: "AS1", kind: "drill", description: "rewrite 5" });
    const q = databases.query.mock.calls.at(-1)![0] as any;
    expect(q.filter.property).toBe("Status");
  });

  it("listening pending round-trips and stats count results", async () => {
    const { writeListeningPending, readListeningPending, recordListeningResult, getListeningStats } = await import("../lib/notion");
    // write pending → page rendered with PENDING json
    await writeListeningPending({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: "2026-07-15T00:00:00Z" });
    const wrote = blocks.children.append.mock.calls.flatMap((c) => (c[0] as any).children).map((c: any) => c.paragraph.rich_text.map((t: any) => t.text.content).join("")).join("\n");
    expect(wrote).toContain('PENDING: {"expected":"跳舞"');
    // reading pending: stub the page body
    blocks.children.list.mockResolvedValueOnce({ results: [
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: 'PENDING: {"expected":"跳舞","sentence":"我喜欢＿＿。","ts":"2026-07-15T00:00:00Z"}' }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "--- RESULTS ---" }] } },
    ] } as any);
    const p = await readListeningPending();
    expect(p?.expected).toBe("跳舞");
    // stats over a results log
    blocks.children.list.mockResolvedValueOnce({ results: [
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "PENDING:" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "--- RESULTS ---" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "2026-07-15 ✓ 跳舞" }] } },
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "2026-07-15 ✗ 唱歌" }] } },
    ] } as any);
    expect(await getListeningStats()).toEqual({ correct: 1, total: 2 });
  });
});
