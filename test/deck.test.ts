import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const getKnownWords = vi.fn(async () => [] as string[]);
const archiveDeck = vi.fn(async () => {});
const sendDocument = vi.fn(async () => {});

vi.mock("../lib/notion", () => ({ getKnownWords, archiveDeck }));
vi.mock("../lib/telegram", () => ({ sendDocument }));

beforeEach(() => {
  Object.assign(process.env, FULL_ENV);
  getKnownWords.mockReset().mockResolvedValue([]);
  archiveDeck.mockReset().mockResolvedValue(undefined as any);
  sendDocument.mockReset().mockResolvedValue(undefined as any);
});

describe("makeDeckFromVocab", () => {
  it("sends only the fresh words and archives them", async () => {
    getKnownWords.mockResolvedValue(["好"]);
    const { makeDeckFromVocab } = await import("../lib/deck");
    const res = await makeDeckFromVocab(
      "Tutor 2026-07-08",
      [
        { headword: "好", pinyin: "hǎo", definition: "good" },
        { headword: "尴尬", pinyin: "gāngà", definition: "awkward" },
      ],
      "42"
    );
    expect(res).toEqual({ sent: true, count: 1 });
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(archiveDeck).toHaveBeenCalledOnce();
    expect(archiveDeck.mock.calls[0][0]).toMatchObject({ count: 1, headwords: "尴尬" });
  });

  it("sends nothing when all words are already known", async () => {
    getKnownWords.mockResolvedValue(["好", "尴尬"]);
    const { makeDeckFromVocab } = await import("../lib/deck");
    const res = await makeDeckFromVocab(
      "X",
      [{ headword: "好", pinyin: "hǎo", definition: "good" }],
      "42"
    );
    expect(res).toEqual({ sent: false, count: 0 });
    expect(sendDocument).not.toHaveBeenCalled();
  });
});
