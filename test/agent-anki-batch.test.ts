// addCards used to abort the whole task on the first note Anki refused, so a 30-card lesson with one
// malformed entry lost all 30. And its de-dupe was scoped to the destination deck only, which cannot
// see the learner's existing `Chinese::Lesson 1 – Greetings::…` decks — every one of the 300+ words
// they already have would have been re-added as a duplicate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { addCards, dedupeQuery, cardBack, ankiTags } from "../agent/anki";

type Body = { action: string; params: any };

/** A fake AnkiConnect. `reject` maps a headword to the error AnkiConnect returns for its addNote. */
function stubAnki(opts: { existing?: string[]; reject?: Record<string, string>; httpFail?: number } = {}) {
  const calls: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body) as Body;
    calls.push(body);
    if (opts.httpFail) return new Response("", { status: opts.httpFail });
    if (body.action === "findNotes") {
      const front = /Front:"([^"]+)"/.exec(body.params.query)?.[1] ?? "";
      return new Response(JSON.stringify({ result: (opts.existing ?? []).includes(front) ? [1] : [], error: null }));
    }
    const front = body.params.note.fields.Front;
    const err = opts.reject?.[front];
    return new Response(JSON.stringify(err ? { result: null, error: err } : { result: 7, error: null }));
  }));
  return calls;
}

const card = (h: string, example = "") => ({ headword: h, pinyin: "p", definition: "d", example });

beforeEach(() => vi.restoreAllMocks());

describe("dedupeQuery", () => {
  it("scopes the whole Chinese::* tree, not just the destination deck", () => {
    const q = dedupeQuery("Chinese::Lucy", "跳舞");
    // Must match the learner's pre-existing sibling decks, e.g. Chinese::Lesson 1 – Greetings::Dialogue 1.
    expect(q).toContain('deck:"Chinese::*"');
    expect(q).toContain('deck:"Chinese"');
    expect(q).toContain('Front:"跳舞"');
    // The old scope — matching ONLY the destination deck — is exactly the duplicate bug.
    expect(q).not.toMatch(/deck:"Chinese::Lucy"\s+Front/);
  });

  it("uses the top-level deck as the scope root for any nested deck", () => {
    expect(dedupeQuery("Chinese::Lucy::Auto", "好")).toContain('deck:"Chinese::*"');
    expect(dedupeQuery("Flat", "好")).toContain('deck:"Flat"');
  });

  it("escapes Anki search metacharacters in the headword", () => {
    const q = dedupeQuery("Chinese::Lucy", 'a"b*c_d');
    expect(q).toContain('\\"');
    expect(q).toContain("\\*");
    expect(q).toContain("\\_");
  });
});

describe("cardBack", () => {
  it("omits the example rather than printing the string undefined", () => {
    expect(cardBack({ headword: "好", pinyin: "hǎo", definition: "good", example: "" }))
      .toBe("hǎo — good");
    expect(cardBack({ headword: "好", pinyin: "hǎo", definition: "good" } as any))
      .toBe("hǎo — good");
    expect(cardBack({ headword: "好", pinyin: "hǎo", definition: "good", example: "你好。" }))
      .toBe("hǎo — good\n\n你好。");
  });
});

describe("ankiTags", () => {
  it("carries the payload label through as a tag alongside the standing ones", () => {
    expect(ankiTags("tutor 2026-07-19")).toEqual(["lucy", "lesson", "tutor-2026-07-19"]);
  });
  it("drops an absent or blank label and never emits a duplicate tag", () => {
    expect(ankiTags()).toEqual(["lucy", "lesson"]);
    expect(ankiTags("   ")).toEqual(["lucy", "lesson"]);
    expect(ankiTags("lucy")).toEqual(["lucy", "lesson"]);
  });
});

describe("addCards fault isolation", () => {
  it("quarantines the one note Anki refuses and still adds the rest", async () => {
    stubAnki({ reject: { "": "cannot create note because it is empty" } });
    const res = await addCards("http://anki", "Chinese::Lucy", [
      card("跳舞"), card(""), card("唱歌"),
    ]);
    expect(res.added).toBe(2);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].card.headword).toBe("");
  });

  it("reports partial success honestly", async () => {
    stubAnki({ existing: ["好"], reject: { 坏: "cannot create note because it is a duplicate" } });
    const res = await addCards("http://anki", "Chinese::Lucy", [card("好"), card("坏"), card("书")]);
    expect(res).toMatchObject({ added: 1, skipped: 1 });
    expect(res.failed).toHaveLength(1);
  });

  it("still aborts the batch on a transport failure, so the task can be retried whole", async () => {
    stubAnki({ httpFail: 404 });
    await expect(addCards("http://anki", "Chinese::Lucy", [card("好"), card("书")]))
      .rejects.toThrow(/404/);
  });

  it("tags every note with the batch label", async () => {
    const calls = stubAnki();
    await addCards("http://anki", "Chinese::Lucy", [card("跳舞")], "tutor 2026-07-19");
    const add = calls.find((c) => c.action === "addNote")!;
    expect(add.params.note.tags).toEqual(["lucy", "lesson", "tutor-2026-07-19"]);
  });
});
