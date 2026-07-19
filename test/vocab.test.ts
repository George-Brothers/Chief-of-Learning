import { describe, it, expect } from "vitest";
import { dedupeVocab } from "../lib/vocab";

describe("dedupeVocab", () => {
  it("removes words already known", () => {
    const out = dedupeVocab(
      [
        { headword: "好", pinyin: "hǎo", definition: "good" },
        { headword: "尴尬", pinyin: "gāngà", definition: "awkward" },
      ],
      ["好"]
    );
    expect(out.map((c) => c.headword)).toEqual(["尴尬"]);
  });

  it("removes duplicates within candidates keeping first", () => {
    const out = dedupeVocab(
      [
        { headword: "书", pinyin: "shū", definition: "book" },
        { headword: "书", pinyin: "shū", definition: "written work" },
      ],
      []
    );
    expect(out).toHaveLength(1);
    expect(out[0].definition).toBe("book");
  });
});
