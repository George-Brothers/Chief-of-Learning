// The Action Queue has never held a single row: the learner's main vocab source — tutor slides and
// homework photos — only ever produced a Pleco .txt. `enqueueCards` is the one shared producer all
// paths now use, so the filtering (and the `example` fallback that used to write the literal string
// "undefined" onto a card back) lives in exactly one place.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const enqueueAction = vi.fn(async () => "pg1");
const appendLedgerNotes = vi.fn();
const addAssignment = vi.fn();
const getCardedWords = vi.fn(async () => [] as string[]);
const sendMessage = vi.fn();

vi.mock("../lib/notion", () => ({ enqueueAction, appendLedgerNotes, addAssignment, getCardedWords }));
vi.mock("../lib/telegram", () => ({ sendMessage }));

const v = (headword: string, example?: string) => ({ headword, pinyin: "p", definition: "d", example });

beforeEach(() => {
  Object.assign(process.env, FULL_ENV);
  for (const f of [enqueueAction, getCardedWords, sendMessage, appendLedgerNotes, addAssignment]) f.mockReset();
  enqueueAction.mockResolvedValue("pg1");
  getCardedWords.mockResolvedValue([]);
});

const payloadOf = () => JSON.parse(enqueueAction.mock.calls[0][0].payload);

describe("enqueueCards", () => {
  it("enqueues a create_anki_cards task with notify and the label", async () => {
    const { enqueueCards } = await import("../lib/actions");
    expect(await enqueueCards([v("跳舞", "我喜欢跳舞。")], "tutor 2026-07-19")).toBe(1);
    expect(enqueueAction).toHaveBeenCalledOnce();
    expect(enqueueAction.mock.calls[0][0].type).toBe("create_anki_cards");
    expect(payloadOf()).toMatchObject({ notify: true, label: "tutor 2026-07-19" });
  });

  it("substitutes an empty example rather than the string \"undefined\"", async () => {
    // VocabSchema had no `example` at all, so wiring the photo path naively produced card backs
    // reading "pinyin — definition\n\nundefined".
    const { enqueueCards } = await import("../lib/actions");
    await enqueueCards([v("跳舞")], "tutor");
    const [card] = payloadOf().cards;
    expect(card.example).toBe("");
    expect(JSON.stringify(card)).not.toContain("undefined");
  });

  it("drops words already carded and de-dupes within the batch", async () => {
    getCardedWords.mockResolvedValue(["跳 舞"]); // whitespace-insensitive match
    const { enqueueCards } = await import("../lib/actions");
    expect(await enqueueCards([v("跳舞"), v("唱歌"), v("唱歌")], "tutor")).toBe(1);
    expect(payloadOf().cards.map((c: any) => c.headword)).toEqual(["唱歌"]);
  });

  it("enqueues nothing at all when every word is already carded", async () => {
    getCardedWords.mockResolvedValue(["跳舞"]);
    const { enqueueCards } = await import("../lib/actions");
    expect(await enqueueCards([v("跳舞")], "tutor")).toBe(0);
    expect(enqueueAction).not.toHaveBeenCalled();
  });

  it("accepts a pre-fetched known list instead of re-reading Notion", async () => {
    const { enqueueCards } = await import("../lib/actions");
    expect(await enqueueCards([v("跳舞")], "tutor", { known: ["跳舞"] })).toBe(0);
    expect(getCardedWords).not.toHaveBeenCalled();
  });

  it("still queues the cards when the known-word lookup fails", async () => {
    // Fail-open: a Notion hiccup must not silently swallow the learner's vocab.
    getCardedWords.mockRejectedValue(new Error("notion 502"));
    const { enqueueCards } = await import("../lib/actions");
    expect(await enqueueCards([v("跳舞")], "tutor")).toBe(1);
  });
});

describe("dispatchActions", () => {
  it("routes create_anki_cards through enqueueCards so its cards get notify + a label", async () => {
    const { dispatchActions } = await import("../lib/actions");
    await dispatchActions([{ type: "create_anki_cards", cards: [v("跳舞", "我喜欢跳舞。")] }], "42");
    expect(payloadOf()).toMatchObject({ notify: true });
    expect(payloadOf().label).toBeTruthy();
  });
});
