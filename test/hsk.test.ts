import { describe, it, expect } from "vitest";
import {
  computeCoverage,
  computePace,
  parseHist,
  observedPerWeek,
  updateHist,
  renderComputedBlock,
  nextWordsHint,
  splitScorecard,
  mergeScorecard,
  SC_COMPUTED,
  SC_CHECKLIST,
} from "../lib/hsk";
import { HSK_WORDS, HSK_CHARS, HSK_TARGET_WORDS, HSK_BANDS } from "../lib/hsk/data";

describe("HSK dataset integrity", () => {
  it("tags every word with exactly one band and no duplicate headwords", () => {
    const seen = new Set<string>();
    for (const w of HSK_WORDS) {
      expect(HSK_BANDS).toContain(w.band);
      expect(seen.has(w.w)).toBe(false); // exclusive banding: each word appears once
      seen.add(w.w);
    }
  });

  it("pins the cumulative target so a bad re-ingest fails loudly", () => {
    // Data-derived, but pinned: if this changes, the dataset was regenerated — update deliberately.
    expect(HSK_TARGET_WORDS).toBe(2193);
    expect(HSK_WORDS.length).toBe(HSK_TARGET_WORDS);
    expect(HSK_CHARS.length).toBe(899);
  });

  it("has non-trivial per-band sizes in the expected shape (500-ish / larger / larger)", () => {
    const size = (b: number) => HSK_WORDS.filter((w) => w.band === b).length;
    expect(size(1)).toBeGreaterThan(450);
    expect(size(2)).toBeGreaterThan(size(1));
    expect(size(3)).toBeGreaterThan(size(2));
  });
});

describe("computeCoverage", () => {
  it("counts exact whole-word membership per band + cumulative", () => {
    // Pick a couple of real words from each band.
    const b1 = HSK_WORDS.filter((w) => w.band === 1).slice(0, 2).map((w) => w.w);
    const b2 = HSK_WORDS.filter((w) => w.band === 2).slice(0, 1).map((w) => w.w);
    const cov = computeCoverage([...b1, ...b2, "   "]);
    const band1 = cov.bands.find((b) => b.band === 1)!;
    const band2 = cov.bands.find((b) => b.band === 2)!;
    expect(band1.known).toBe(2);
    expect(band2.known).toBe(1);
    expect(cov.cumulativeKnown).toBe(3);
    expect(cov.cumulativeTotal).toBe(HSK_TARGET_WORDS);
    expect(cov.gapToTarget).toBe(HSK_TARGET_WORDS - 3);
  });

  it("does not over-credit a substring (电 must not count 电影)", () => {
    // A multi-char headword whose first character is a DIFFERENT headword (so it's not itself counted).
    const headwords = new Set(HSK_WORDS.map((w) => w.w));
    const compound = HSK_WORDS.find((w) => w.w.length >= 2 && headwords.has(w.w[0]) && w.w[0] !== w.w)!;
    // Knowing only the first character credits that single char-word, NOT the compound.
    const cov = computeCoverage([compound.w[0]]);
    const band = cov.bands.find((b) => b.band === compound.band)!;
    // The compound is either uncredited (in missing sample) or simply not counted — never credited.
    const knownWithCharOnly = cov.cumulativeKnown;
    const knownWithCompound = computeCoverage([compound.w]).cumulativeKnown;
    expect(knownWithCompound).toBeGreaterThan(0);
    // Adding the compound as a known word must raise the count beyond knowing just its first char.
    expect(computeCoverage([compound.w[0], compound.w]).cumulativeKnown).toBe(knownWithCharOnly + 1);
    expect(band.total).toBeGreaterThan(0);
  });

  it("caps the missing sample at 15 and excludes known words", () => {
    const b1 = HSK_WORDS.filter((w) => w.band === 1);
    const known = b1.slice(0, 3).map((w) => w.w);
    const cov = computeCoverage(known);
    const band1 = cov.bands.find((b) => b.band === 1)!;
    expect(band1.missing.length).toBeLessThanOrEqual(15);
    for (const k of known) expect(band1.missing).not.toContain(k);
  });

  it("computes character reading coverage from known words", () => {
    const cov = computeCoverage([]);
    expect(cov.charsKnown).toBe(0);
    expect(cov.charsTotal).toBe(HSK_CHARS.length);
    const withChars = computeCoverage([HSK_CHARS[0].c]);
    expect(withChars.charsKnown).toBeGreaterThanOrEqual(1);
  });
});

describe("computePace", () => {
  const today = new Date("2026-07-10T00:00:00Z");
  const deadline = new Date("2027-03-01T00:00:00Z");

  it("computes the words/day + words/week needed", () => {
    const p = computePace({ known: 193, target: 2193, today, deadline });
    expect(p.gap).toBe(2000);
    expect(p.daysLeft).toBe(234);
    expect(p.wordsPerDayNeeded).toBeCloseTo(2000 / 234, 5);
    expect(p.wordsPerWeekNeeded).toBeCloseTo((2000 / 234) * 7, 5);
    expect(p.verdict).toBe("unknown"); // no observed pace
  });

  it("does not divide by zero when the deadline has passed", () => {
    const p = computePace({ known: 100, target: 973, today: new Date("2027-06-01"), deadline });
    expect(p.daysLeft).toBe(0);
    expect(p.wordsPerDayNeeded).toBe(Infinity);
  });

  it("derives an ETA + verdict from observed pace", () => {
    const behind = computePace({ known: 193, target: 2193, today, deadline, observedPerWeek: 10 });
    expect(behind.etaDate).toBeInstanceOf(Date);
    expect(behind.verdict).toBe("behind"); // 2000 words at 10/wk ⇒ ~4 years

    const ahead = computePace({ known: 2150, target: 2193, today, deadline, observedPerWeek: 30 });
    expect(ahead.verdict).toBe("ahead"); // tiny gap, finishes well before deadline
  });

  it("treats zero observed progress with a remaining gap as behind", () => {
    const p = computePace({ known: 100, target: 973, today, deadline, observedPerWeek: 0 });
    expect(p.verdict).toBe("behind");
  });
});

describe("HIST parsing + pace history", () => {
  it("parses and sorts dated known-count samples", () => {
    const doc = "HIST: 2026-07-10=195; 2026-07-03=181";
    expect(parseHist(doc)).toEqual([
      { date: "2026-07-03", known: 181 },
      { date: "2026-07-10", known: 195 },
    ]);
  });

  it("returns undefined observed pace with fewer than 2 samples", () => {
    expect(observedPerWeek("HIST: 2026-07-10=195")).toBeUndefined();
    expect(observedPerWeek("no hist line here")).toBeUndefined();
  });

  it("estimates words/week from oldest→newest samples", () => {
    // +14 words over 7 days ⇒ 14/wk.
    const doc = "HIST: 2026-07-03=181; 2026-07-10=195";
    expect(observedPerWeek(doc)).toBeCloseTo(14, 5);
  });

  it("appends today's count and keeps the last N samples", () => {
    const prev = "HIST: 2026-06-01=10; 2026-06-08=20";
    const updated = updateHist(prev, new Date("2026-06-15T00:00:00Z"), 30, 8);
    expect(updated).toBe("2026-06-01=10; 2026-06-08=20; 2026-06-15=30");
    // Same-day re-run replaces rather than duplicates.
    const rerun = updateHist(`HIST: ${updated}`, new Date("2026-06-15T00:00:00Z"), 33, 8);
    expect(rerun.endsWith("2026-06-15=33")).toBe(true);
    expect(rerun.split(";").length).toBe(3);
  });
});

describe("scorecard split/merge", () => {
  it("round-trips computed + checklist regions", () => {
    const computed = `${SC_COMPUTED}\nVocab: HSK1 5/500`;
    const checklist = `${SC_CHECKLIST}\n## Grammar\n[x] 是 A是B`;
    const merged = mergeScorecard(computed, checklist);
    const parts = splitScorecard(merged);
    expect(parts.computed).toContain("Vocab: HSK1 5/500");
    expect(parts.checklist).toContain("[x] 是 A是B");
  });

  it("refreshing the computed block preserves the checklist", () => {
    const doc = mergeScorecard(`${SC_COMPUTED}\nold`, `${SC_CHECKLIST}\nkeep me`);
    const { checklist } = splitScorecard(doc);
    const refreshed = mergeScorecard(`${SC_COMPUTED}\nnew`, checklist);
    expect(refreshed).toContain("new");
    expect(refreshed).toContain("keep me");
    expect(refreshed).not.toContain("old");
  });

  it("never throws on missing markers → empty halves", () => {
    expect(splitScorecard("")).toEqual({ computed: "", checklist: "" });
    expect(splitScorecard("garbage with no markers")).toEqual({ computed: "", checklist: "" });
    const merged = mergeScorecard("", "");
    expect(merged).toContain(SC_CHECKLIST);
  });
});

describe("renderComputedBlock + nextWordsHint", () => {
  it("renders a compact block with the marker, target, and verdict", () => {
    const cov = computeCoverage([]);
    const pace = computePace({
      known: cov.cumulativeKnown,
      target: cov.cumulativeTotal,
      today: new Date("2026-07-10T00:00:00Z"),
      deadline: new Date("2027-03-01T00:00:00Z"),
    });
    const block = renderComputedBlock(cov, pace, "2026-07-10=0");
    expect(block).toContain(SC_COMPUTED);
    expect(block).toContain("Target: HSK 3.0");
    expect(block).toContain("Cumulative retained: 0/2193");
    expect(block).toContain("HIST: 2026-07-10=0");
  });

  it("renderComputedBlock adds exposed line + low-confidence caveat", () => {
    const cov = computeCoverage(["我"]); // 1 retained
    const pace = computePace({ known: cov.cumulativeKnown, target: cov.cumulativeTotal, today: new Date("2026-07-15") });
    const out = renderComputedBlock(cov, pace, "", 200); // 200 exposed
    expect(out).toMatch(/Exposed: 200 words shown/);
    expect(out).toMatch(/low confidence/i);
  });

  it("points the next-words hint at the lowest-coverage incomplete band", () => {
    const cov = computeCoverage([]);
    const hint = nextWordsHint(cov);
    expect(hint).toContain("Next HSK1 words"); // nothing known ⇒ band 1 is lowest-coverage
  });

  it("advances bands sequentially, not by lowest percentage", () => {
    // Know MOST of band 1 (but not near-complete) — band 3 still has far lower %, yet the hint
    // must stay on band 1 because bands are sequential.
    const b1 = HSK_WORDS.filter((w) => w.band === 1);
    const knowMostOfBand1 = b1.slice(0, Math.floor(b1.length * 0.5)).map((w) => w.w);
    const cov = computeCoverage(knowMostOfBand1);
    expect(cov.bands.find((b) => b.band === 3)!.pct).toBeLessThan(
      cov.bands.find((b) => b.band === 1)!.pct
    );
    expect(nextWordsHint(cov)).toContain("Next HSK1 words");
  });
});
