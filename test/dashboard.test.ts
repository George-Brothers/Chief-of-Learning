import { describe, it, expect } from "vitest";
import {
  computeStreak,
  distinctStudyDays,
  computeXp,
  xpToReach,
  levelTitle,
  deriveFocusAreas,
  collectWeakSignals,
  suggestionFor,
} from "../lib/dashboard";

const TZ = "UTC";
const today = new Date("2026-07-15T12:00:00Z");
const iso = (day: string) => `${day}T09:00:00Z`;

describe("computeStreak", () => {
  it("counts consecutive days ending today", () => {
    const streak = computeStreak([iso("2026-07-15"), iso("2026-07-14"), iso("2026-07-13")], today, TZ);
    expect(streak).toBe(3);
  });

  it("grants a grace day: an untouched today doesn't break yesterday's streak", () => {
    const streak = computeStreak([iso("2026-07-14"), iso("2026-07-13")], today, TZ);
    expect(streak).toBe(2);
  });

  it("returns 0 when the most recent activity is older than yesterday", () => {
    expect(computeStreak([iso("2026-07-13")], today, TZ)).toBe(0);
  });

  it("returns 0 for no activity and ignores malformed timestamps", () => {
    expect(computeStreak([], today, TZ)).toBe(0);
    expect(computeStreak(["not-a-date"], today, TZ)).toBe(0);
  });

  it("de-duplicates multiple entries on the same day", () => {
    const streak = computeStreak(
      [iso("2026-07-15"), "2026-07-15T20:00:00Z", iso("2026-07-14")],
      today,
      TZ,
    );
    expect(streak).toBe(2);
  });
});

describe("distinctStudyDays", () => {
  it("counts unique calendar days", () => {
    expect(distinctStudyDays([iso("2026-07-15"), "2026-07-15T20:00:00Z", iso("2026-07-10")], TZ)).toBe(2);
  });
});

describe("computeXp / levels", () => {
  it("xpToReach follows the documented curve", () => {
    expect(xpToReach(1)).toBe(0);
    expect(xpToReach(2)).toBe(100);
    expect(xpToReach(3)).toBe(300);
    expect(xpToReach(4)).toBe(600);
  });

  it("zero activity is level 1 with a full bar ahead", () => {
    const xp = computeXp({ knownWords: 0, studyDays: 0, lessons: 0, streakDays: 0 });
    expect(xp).toMatchObject({ xp: 0, level: 1, intoLevel: 0, forNextLevel: 100 });
    expect(xp.pctToNext).toBe(0);
    expect(xp.title).toContain("新手");
  });

  it("derives level and progress from activity", () => {
    // 25 words*10 = 250 xp → still level 2 (needs 300 for level 3)
    const xp = computeXp({ knownWords: 25, studyDays: 0, lessons: 0, streakDays: 0 });
    expect(xp.xp).toBe(250);
    expect(xp.level).toBe(2);
    expect(xp.intoLevel).toBe(150);
    expect(xp.forNextLevel).toBe(200);
    expect(xp.pctToNext).toBeCloseTo(0.75, 5);
  });

  it("blends all signals into total xp", () => {
    const xp = computeXp({ knownWords: 10, studyDays: 3, lessons: 2, streakDays: 4 });
    expect(xp.xp).toBe(10 * 10 + 3 * 20 + 2 * 50 + 4 * 15); // 100+60+100+60 = 320
    expect(xp.level).toBe(3);
  });

  it("levelTitle climbs with level", () => {
    expect(levelTitle(1)).toContain("新手");
    expect(levelTitle(6)).toContain("书虫");
    expect(levelTitle(20)).toContain("大师");
  });
});

describe("collectWeakSignals", () => {
  it("flattens weakSignals from distilled evidence, skipping malformed", () => {
    const out = collectWeakSignals([
      { distilled: JSON.stringify({ weakSignals: ["listening", "tones"] }) },
      { distilled: "not-json" },
      { distilled: JSON.stringify({ weakSignals: ["是 before verb"] }) },
      {},
    ]);
    expect(out).toEqual(["listening", "tones", "是 before verb"]);
  });
});

describe("suggestionFor", () => {
  it("maps known weak spots to concrete drills", () => {
    expect(suggestionFor("listening is weak")).toMatch(/dictation/i);
    expect(suggestionFor("是 before verb")).toMatch(/是/);
    expect(suggestionFor("tone 3 errors")).toMatch(/tone/i);
    expect(suggestionFor("something else entirely")).toMatch(/drill/i);
  });
});

describe("deriveFocusAreas", () => {
  it("ranks weak signals by frequency and attaches suggestions", () => {
    const areas = deriveFocusAreas({
      weakSignals: ["listening", "是 before verb", "listening", "tones"],
      weekFocus: "",
    });
    expect(areas.length).toBeGreaterThanOrEqual(2);
    expect(areas.length).toBeLessThanOrEqual(4);
    expect(areas[0].area.toLowerCase()).toContain("listening");
    expect(areas[0].hits).toBe(2);
    expect(areas[0].suggestion).toMatch(/dictation/i);
  });

  it("falls back to the week focus when few weak signals exist", () => {
    const areas = deriveFocusAreas({ weakSignals: [], weekFocus: "Protect listening every day" });
    expect(areas).toHaveLength(1);
    expect(areas[0].area).toContain("Protect listening");
  });

  it("always returns something coachable when there is nothing", () => {
    const areas = deriveFocusAreas({ weakSignals: [], weekFocus: "" });
    expect(areas).toHaveLength(1);
    expect(areas[0].area).toMatch(/no weak spots/i);
  });
});
