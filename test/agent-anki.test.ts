import { describe, it, expect, vi, beforeEach } from "vitest";
import { addCards } from "../agent/anki";

describe("addCards", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("adds new cards and skips existing ones", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (body.action === "findNotes") {
        // First card exists (non-empty), second doesn't.
        const front = body.params.query.match(/Front:"([^"]+)"/)[1];
        return new Response(JSON.stringify({ result: front === "跳舞" ? [123] : [], error: null }));
      }
      return new Response(JSON.stringify({ result: 999, error: null }));
    }));
    const res = await addCards("http://anki", "Chinese::Lessons", [
      { headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" },
      { headword: "唱歌", pinyin: "chànggē", definition: "sing", example: "我喜欢唱歌。" },
    ]);
    expect(res).toEqual({ added: 1, skipped: 1, failed: [] });
    const addNote = calls.find((c) => c.action === "addNote");
    expect(addNote.params.note.fields.Front).toBe("唱歌");
    expect(addNote.params.note.fields.Back).toContain("chànggē");
    expect(addNote.params.note.deckName).toBe("Chinese::Lessons");
  });

  it("throws when AnkiConnect returns an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ result: null, error: "collection is not available" }))));
    await expect(addCards("http://anki", "D", [
      { headword: "x", pinyin: "x", definition: "x", example: "x" },
    ])).rejects.toThrow(/collection is not available/);
  });
});
