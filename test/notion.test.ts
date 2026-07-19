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
      { id: "AS1", created_time: "2026-07-12T09:00:00.000Z", properties: { Type: { select: { name: "drill" } }, Description: { rich_text: [{ plain_text: "rewrite 5" }] } } },
    ] } as any);
    const { getOpenAssignments } = await import("../lib/notion");
    const rows = await getOpenAssignments();
    expect(rows[0]).toEqual({
      id: "AS1",
      kind: "drill",
      description: "rewrite 5",
      createdTime: "2026-07-12T09:00:00.000Z",
    });
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

  it("listening source offers are logged, read back, and never counted as check results", async () => {
    const { recordListeningOffer, getRecentListeningSourceIds, getListeningStats } = await import("../lib/notion");
    const body = (lines: string[]) => ({
      results: lines.map((l) => ({ type: "paragraph", paragraph: { rich_text: [{ plain_text: l }] } })),
    });

    const before = body([
      'PENDING: {"expected":"跳舞","sentence":"我喜欢＿＿。","ts":"2026-07-15T00:00:00Z"}',
      "--- RESULTS ---",
      "2026-07-18 ✓ 跳舞",
      "2026-07-17 🎧 mandarin-corner",
    ]);
    // ONE read now (it used to read raw, then read again for the results block — a non-atomic
    // read-modify-write). The history must still survive the merge.
    blocks.children.list.mockResolvedValueOnce(before as any);
    blocks.children.append.mockClear();
    await recordListeningOffer(["lazy-chinese", "du-chinese"], "2026-07-19");
    const wrote = blocks.children.append.mock.calls.flatMap((c) => (c[0] as any).children).map((c: any) => c.paragraph.rich_text.map((t: any) => t.text.content).join("")).join("\n");
    expect(wrote).toContain("2026-07-19 🎧 lazy-chinese,du-chinese");
    // An offer must not consume an outstanding cloze check…
    expect(wrote).toContain('PENDING: {"expected":"跳舞"');
    // …nor drop the prior results/offers it was merged into.
    expect(wrote).toContain("2026-07-18 ✓ 跳舞");
    expect(wrote).toContain("2026-07-17 🎧 mandarin-corner");
    // Newest offer leads, so getRecentListeningSourceIds' slice(0, days) reads the right ones.
    expect(wrote.indexOf("2026-07-19 🎧")).toBeLessThan(wrote.indexOf("2026-07-18 ✓"));

    const logged = body([
      "PENDING:",
      "--- RESULTS ---",
      "2026-07-19 🎧 lazy-chinese,du-chinese",
      "2026-07-18 ✓ 跳舞",
    ]);
    blocks.children.list.mockResolvedValueOnce(logged as any);
    expect(await getRecentListeningSourceIds()).toEqual(["lazy-chinese", "du-chinese"]);
    blocks.children.list.mockResolvedValueOnce(logged as any);
    expect(await getListeningStats()).toEqual({ correct: 1, total: 1 });
  });

  /**
   * recordListeningOffer runs from the DAILY cron and rewrites the page by re-appending every prior
   * line, with no cap — unlike prependDoc, which keeps its docs under 12000/20000 chars. Unattended,
   * that grows the listening page forever. It also read the page TWICE per call, so a concurrent
   * write could land between the two reads and be half-preserved.
   */
  it("caps the listening page and reads it exactly once per offer", async () => {
    const { recordListeningOffer } = await import("../lib/notion");
    const history = Array.from({ length: 800 }, (_, i) => `2026-01-01 🎧 source-${i}-${"x".repeat(40)}`);
    const before = {
      results: ["PENDING:", "--- RESULTS ---", ...history].map((l) => ({
        type: "paragraph", paragraph: { rich_text: [{ plain_text: l }] },
      })),
    };
    blocks.children.list.mockResolvedValue(before as any); // allow any number of reads, then count them
    blocks.children.list.mockClear();
    blocks.children.append.mockClear();

    await recordListeningOffer(["lazy-chinese"], "2026-07-19");

    // Exactly two block listings: ONE read of the page, plus writeDoc's own listing of the blocks it
    // must retire. It used to be three — raw, then a second read for the results block.
    expect(blocks.children.list).toHaveBeenCalledTimes(2);
    const lines = blocks.children.append.mock.calls
      .flatMap((c) => (c[0] as any).children)
      .map((c: any) => c.paragraph.rich_text.map((t: any) => t.text.content).join(""))
      .filter((l: string) => !/^[​⁠]+$/.test(l)); // drop the commit sentinel block
    const wrote = lines.join("\n");
    expect(wrote.length).toBeLessThanOrEqual(12000);
    expect(wrote).toContain("2026-07-19 🎧 lazy-chinese"); // today's offer survives the cap
    // The cap must not leave a half-line, which getRecentListeningSourceIds would parse as a source.
    expect(lines.at(-1)).toMatch(/^2026-01-01 🎧 source-\d+-x{40}$/);
  });
});
