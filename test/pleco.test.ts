import { describe, it, expect } from "vitest";
import { formatPlecoDeck } from "../lib/pleco";

describe("formatPlecoDeck", () => {
  it("emits a category header then tab-delimited cards", () => {
    const out = formatPlecoDeck("Tutor 2026-07-08", [
      { headword: "尴尬", pinyin: "gān gà", definition: "awkward; embarrassed" },
    ]);
    expect(out).toBe("//Tutor 2026-07-08\n尴尬\tgān gà\tawkward; embarrassed\n");
  });

  it("encodes traditional as simp[trad] when different", () => {
    const out = formatPlecoDeck("X", [
      { headword: "网络", traditional: "網絡", pinyin: "wǎng luò", definition: "network" },
    ]);
    expect(out).toContain("网络[網絡]\twǎng luò\tnetwork\n");
  });

  it("strips tabs/newlines inside fields so rows never break", () => {
    const out = formatPlecoDeck("X", [
      { headword: "好", pinyin: "hǎo", definition: "good\tvery\nfine" },
    ]);
    expect(out).toBe("//X\n好\thǎo\tgood very fine\n");
  });

  it("throws on empty card list", () => {
    expect(() => formatPlecoDeck("X", [])).toThrow(/no cards/i);
  });
});
