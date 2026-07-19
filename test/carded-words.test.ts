// A word that went out as a Pleco .txt was archived in the Decks DB, getKnownWords unioned that,
// and /cards filtered against it — so "sent as Pleco" permanently blocked the same word from ever
// becoming an Anki card. Delivery is not knowledge: the Decks DB is a record of what was SENT.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const query = vi.fn();
const listBlocks = vi.fn();

vi.mock("@notionhq/client", () => ({
  Client: class {
    databases = { query };
    blocks = { children: { list: listBlocks, append: vi.fn() } };
    pages = { create: vi.fn(async () => ({ id: "pg1" })), update: vi.fn() };
  },
}));

beforeEach(() => {
  vi.resetModules();
  Object.assign(process.env, FULL_ENV);
  query.mockReset();
  listBlocks.mockReset().mockResolvedValue({ results: [], has_more: false });
});

const syllabusPage = { results: [{ properties: { Vocab: { rich_text: [{ plain_text: "好" }] } } }] };
const decksPage = { results: [{ properties: { Headwords: { rich_text: [{ plain_text: "尴尬" }] } } }] };

/** A page of blocks as readDoc consumes them (no commit sentinel → whole doc is current). */
const doc = (...lines: string[]) => ({
  results: lines.map((l) => ({ type: "paragraph", paragraph: { rich_text: [{ plain_text: l }] } })),
  has_more: false,
});

/** One Action Queue row of the shape enqueueAction writes. */
const cardRow = (status: string, ...headwords: string[]) => ({
  id: `q-${headwords.join("")}`,
  created_time: "2026-07-18T00:00:00.000Z",
  properties: {
    Type: { select: { name: "create_anki_cards" } },
    Status: { select: { name: status } },
    Payload: {
      rich_text: [{
        plain_text: JSON.stringify({
          label: "l", notify: true,
          cards: headwords.map((h) => ({ headword: h, pinyin: "p", definition: "d", example: "" })),
        }),
      }],
    },
  },
});

describe("known-word sets", () => {
  it("getKnownWords (EXPOSED) still counts Pleco decks", async () => {
    query.mockResolvedValueOnce(syllabusPage as any).mockResolvedValueOnce(decksPage as any);
    const { getKnownWords } = await import("../lib/notion");
    expect(await getKnownWords()).toEqual(expect.arrayContaining(["好", "尴尬"]));
  });

  it("getCardedWords excludes the Pleco deck archive, so a sent word can still become a card", async () => {
    query.mockResolvedValueOnce(syllabusPage as any).mockResolvedValueOnce(decksPage as any);
    const { getCardedWords } = await import("../lib/notion");
    const words = await getCardedWords();
    expect(words).toContain("好"); // syllabus vocab is real curriculum — still excluded from new cards
    expect(words).not.toContain("尴尬"); // only ever sent as a Pleco file
  });

  it("getCardedWords does not even read the Decks database", async () => {
    query.mockResolvedValue(syllabusPage as any);
    const { getCardedWords } = await import("../lib/notion");
    await getCardedWords();
    const dbs = query.mock.calls.map((c: any[]) => c[0].database_id);
    expect(dbs).not.toContain(FULL_ENV.NOTION_DECKS_DB_ID);
  });
});

/**
 * The false "already carded". getCardedWords used to scrape the Knowledge Ledger with
 * /[一-鿿]+/g, so ANY hanzi appearing anywhere in ledger PROSE counted as carded. dispatchActions
 * writes lines like "Drill queued: tone pairs for 跳舞" into that same ledger — so a coach note
 * mentioning a word permanently blocked it from ever becoming an Anki card, while the learner was
 * told it was "already carded", which was simply untrue.
 *
 * The record of what was actually carded is the Action Queue (every create_anki_cards row we ever
 * enqueued) plus the retained-words page the local agent syncs from Anki itself. That is what may
 * suppress a new card.
 */
describe("getCardedWords uses the real card record, not ledger prose", () => {
  const ledgerMentions = (...lines: string[]) => {
    listBlocks.mockImplementation(async ({ block_id }: any) =>
      block_id === FULL_ENV.NOTION_LEDGER_PAGE_ID ? doc(...lines) : { results: [], has_more: false },
    );
  };

  it("does NOT treat a word merely mentioned in a ledger coach note as carded", async () => {
    ledgerMentions("Drill queued: tone pairs for 跳舞", "Reading assigned (HSK2): 我的家人");
    query.mockResolvedValue({ results: [] } as any);
    const { getCardedWords } = await import("../lib/notion");
    expect(await getCardedWords()).not.toContain("跳舞");
  });

  it("does not even read the Knowledge Ledger", async () => {
    ledgerMentions("Drill queued: tone pairs for 跳舞");
    query.mockResolvedValue({ results: [] } as any);
    const { getCardedWords } = await import("../lib/notion");
    await getCardedWords();
    const pages = listBlocks.mock.calls.map((c: any[]) => c[0].block_id);
    expect(pages).not.toContain(FULL_ENV.NOTION_LEDGER_PAGE_ID);
  });

  it("DOES treat a word that was really queued as a card as carded — whatever the row's fate", async () => {
    query.mockImplementation(async (q: any) =>
      q.database_id === FULL_ENV.NOTION_ACTIONQUEUE_DB_ID
        ? { results: [cardRow("done", "跳舞"), cardRow("queued", "唱歌"), cardRow("error", "游泳")] }
        : { results: [] },
    );
    const { getCardedWords } = await import("../lib/notion");
    const words = await getCardedWords();
    expect(words).toEqual(expect.arrayContaining(["跳舞", "唱歌", "游泳"]));
  });

  it("DOES treat a word Anki reports as retained as carded", async () => {
    listBlocks.mockImplementation(async ({ block_id }: any) =>
      block_id === FULL_ENV.NOTION_RETAINED_PAGE_ID ? doc("跳舞 唱歌") : { results: [], has_more: false },
    );
    query.mockResolvedValue({ results: [] } as any);
    const { getCardedWords } = await import("../lib/notion");
    expect(await getCardedWords()).toEqual(expect.arrayContaining(["跳舞", "唱歌"]));
  });

  it("getKnownWords (EXPOSED) still counts ledger prose — that set means 'has been shown'", async () => {
    ledgerMentions("Drill queued: tone pairs for 跳舞");
    query.mockResolvedValue({ results: [] } as any);
    const { getKnownWords } = await import("../lib/notion");
    expect(await getKnownWords()).toContain("跳舞");
  });
});
