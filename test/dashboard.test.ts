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
  parseTodayPlan,
  parseDurationMinutes,
  daysCarried,
  parseListeningLog,
  listeningWeekCount,
  buildListeningTracker,
  parseLessonHistory,
  completedPlanBlockIds,
  planBlockLabel,
  planBlockIdFromLabel,
  planBlockId,
  PLAN_DONE_SUMMARY_PREFIX,
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
    expect(suggestionFor("listening is weak")).toMatch(/Lucy offered/i);
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
    expect(areas[0].suggestion).toMatch(/Lucy offered/i);
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

describe("parseTodayPlan", () => {
  it("splits a post-it into checkable blocks with durations", () => {
    const plan = parseTodayPlan(
      [
        "1. Rewrite 8 sentences dropping 是 before plain verbs — 25 min",
        "- Listen to Lazy Chinese (10 min) and tell me one thing you caught",
        "加油！(jiāyóu)",
      ].join("\n"),
    );
    expect(plan.structured).toBe(true);
    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks[0].text).toBe("Rewrite 8 sentences dropping 是 before plain verbs");
    expect(plan.blocks[0].minutes).toBe(25);
    expect(plan.blocks[1].minutes).toBe(10);
    // The sign-off is not a task and must never become a checkbox.
    expect(plan.blocks.map((b) => b.text).join(" ")).not.toContain("jiāyóu");
  });

  it("keeps the raw post-it alongside the blocks", () => {
    const raw = "Do the thing today for real — 30 min";
    expect(parseTodayPlan(raw).raw).toBe(raw);
  });

  it("converts hours and ignores non-durations", () => {
    expect(parseDurationMinutes("Read for 1.5h today")).toBe(90);
    expect(parseDurationMinutes("2 hours of listening")).toBe(120);
    expect(parseDurationMinutes("Work HSK 3 band vocabulary")).toBeNull();
    expect(parseDurationMinutes("write 5 more sentences")).toBeNull();
  });

  it("falls back to raw lines when nothing looks like a step", () => {
    const plan = parseTodayPlan("Rest day\n加油！");
    expect(plan.structured).toBe(false);
    expect(plan.blocks.map((b) => b.text)).toEqual(["Rest day", "加油！"]);
  });

  it("gives the same line the same stable id and de-dupes repeats", () => {
    const a = parseTodayPlan("Rewrite 8 sentences dropping 是 — 25 min");
    const b = parseTodayPlan("- Rewrite 8 sentences dropping 是 — 25 min");
    expect(a.blocks[0].id).toBe(b.blocks[0].id);
    const dup = parseTodayPlan("Do the drill twice today\nDo the drill twice today");
    expect(dup.blocks).toHaveLength(1);
  });

  it("returns no blocks for an empty page", () => {
    expect(parseTodayPlan("").blocks).toEqual([]);
  });
});

describe("daysCarried", () => {
  it("counts whole days since the assignment was set", () => {
    expect(daysCarried("2026-07-12T09:00:00Z", today)).toBe(3);
    expect(daysCarried("2026-07-15T09:00:00Z", today)).toBe(0);
  });

  it("is 0 for a missing or unparseable timestamp", () => {
    expect(daysCarried("", today)).toBe(0);
    expect(daysCarried("whenever", today)).toBe(0);
  });
});

describe("listening tracker", () => {
  const lines = [
    "2026-07-15 🎧 lazy-chinese,du-chinese",
    "2026-07-15 ✓ 跳舞",
    "2026-07-14 ✗ 唱歌",
    "2026-07-01 ✓ голос",
    "noise that means nothing",
  ];

  it("parses cloze checks and source offers out of the shared log", () => {
    const { checks, offers } = parseListeningLog(lines);
    expect(checks).toEqual([
      { date: "2026-07-15", ok: true, word: "跳舞" },
      { date: "2026-07-14", ok: false, word: "唱歌" },
      { date: "2026-07-01", ok: true, word: "голос" },
    ]);
    expect(offers).toEqual([{ date: "2026-07-15", ids: ["lazy-chinese", "du-chinese"] }]);
  });

  it("counts only the last 7 days for the week count", () => {
    const { checks } = parseListeningLog(lines);
    expect(listeningWeekCount(checks, today, TZ)).toBe(2);
  });

  it("lists inventory sources that have not been offered lately", () => {
    const tracker = buildListeningTracker(lines, today, TZ);
    const unused = tracker.unusedSources.map((s) => s.id);
    expect(unused).not.toContain("lazy-chinese");
    expect(unused).not.toContain("du-chinese");
    expect(unused).toContain("mandarin-corner");
  });

  it("resolves offered ids to real source names and scores the checks", () => {
    const tracker = buildListeningTracker(lines, today, TZ);
    expect(tracker.offers[0].sources).toContain("Lazy Chinese");
    expect(tracker.correct).toBe(2);
    expect(tracker.total).toBe(3);
  });

  it("degrades to an empty tracker with no log at all", () => {
    const tracker = buildListeningTracker([], today, TZ);
    expect(tracker.checks).toEqual([]);
    expect(tracker.weekCount).toBe(0);
    expect(tracker.unusedSources.length).toBeGreaterThan(0);
  });
});

describe("parseLessonHistory", () => {
  const row = {
    id: "L1",
    date: "2026-07-13",
    summary: "IC L4 dialogue",
    weakSignals: "3rd tone",
    homework: "workbook p.42",
    noteJson: JSON.stringify({
      summary: "IC L4",
      vocabIntroduced: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "to dance", example: "" }],
      errors: [{ quote: "我是去", kind: "grammar", correction: "我去" }],
      grammarPoints: ["是 only before nouns"],
      couldNotSay: ["I'd rather stay home", "next weekend"],
      homeworkAssigned: "workbook p.42",
      durationMinutes: 60,
    }),
  };

  it("surfaces vocabIntroduced, errors and couldNotSay from the note", () => {
    const [e] = parseLessonHistory([row]);
    expect(e.vocabIntroduced).toEqual([{ headword: "跳舞", pinyin: "tiàowǔ", definition: "to dance" }]);
    expect(e.errors).toEqual([{ quote: "我是去", kind: "grammar", correction: "我去" }]);
    expect(e.couldNotSay).toEqual(["I'd rather stay home", "next weekend"]);
    expect(e.durationMinutes).toBe(60);
  });

  it("keeps the row's own fields when the note JSON is malformed", () => {
    const [e] = parseLessonHistory([{ ...row, noteJson: "{not json" }]);
    expect(e.summary).toBe("IC L4 dialogue");
    expect(e.homework).toBe("workbook p.42");
    expect(e.couldNotSay).toEqual([]);
    expect(e.vocabIntroduced).toEqual([]);
    expect(e.durationMinutes).toBeNull();
  });

  it("drops junk entries inside an otherwise valid note", () => {
    const [e] = parseLessonHistory([
      { ...row, noteJson: JSON.stringify({ vocabIntroduced: [{ pinyin: "x" }], couldNotSay: ["ok", 7], errors: "nope" }) },
    ]);
    expect(e.vocabIntroduced).toEqual([]);
    expect(e.errors).toEqual([]);
    expect(e.couldNotSay).toEqual(["ok"]);
  });
});

/**
 * The round-trip that makes a tick durable. Every assertion here FAILS against the pre-fix module,
 * which exported none of these — the "done" state lived only in React state and died on reload.
 */
describe("completedPlanBlockIds", () => {
  const label = (b: { text: string; minutes: number | null }) => planBlockLabel(b);
  const row = (summary: string, at: string) => ({ createdTime: at, summary });

  it("round-trips a block through the label it is logged under", () => {
    const block = { text: "Rewrite 8 sentences dropping 是", minutes: 25 };
    expect(label(block)).toBe("Rewrite 8 sentences dropping 是 (25 min)");
    expect(planBlockIdFromLabel(label(block))).toBe(planBlockId(block.text));
  });

  it("round-trips a block that names no duration", () => {
    const block = { text: "Shadow the dialogue", minutes: null };
    expect(planBlockIdFromLabel(label(block))).toBe(planBlockId("Shadow the dialogue"));
  });

  it("returns the ids ticked today and ignores other evidence", () => {
    const ids = completedPlanBlockIds(
      [
        row(`${PLAN_DONE_SUMMARY_PREFIX}Shadow the dialogue (10 min)`, iso("2026-07-15")),
        row("Did 20 minutes of tone drills", iso("2026-07-15")),
      ],
      today,
      TZ,
    );
    expect(ids).toEqual([planBlockId("Shadow the dialogue")]);
  });

  it("does not carry yesterday's tick into today", () => {
    const ids = completedPlanBlockIds(
      [row(`${PLAN_DONE_SUMMARY_PREFIX}Shadow the dialogue (10 min)`, iso("2026-07-14"))],
      today,
      TZ,
    );
    expect(ids).toEqual([]);
  });

  it("is day-scoped in the learner's timezone, not UTC", () => {
    // 23:30 Chicago on the 15th is 04:30 UTC on the 16th — the same evening's work either way.
    const rows = [row(`${PLAN_DONE_SUMMARY_PREFIX}Late review (5 min)`, "2026-07-16T04:30:00Z")];
    const stillTheSameEvening = new Date("2026-07-16T04:45:00Z"); // 23:45 Chicago, 15 July
    expect(completedPlanBlockIds(rows, stillTheSameEvening, "America/Chicago")).toEqual([
      planBlockId("Late review"),
    ]);
    // Past local midnight it is a new day and the box is tickable again — even though UTC has not
    // rolled over relative to the row, and a naive UTC comparison would still call it "today".
    const afterLocalMidnight = new Date("2026-07-16T05:30:00Z"); // 00:30 Chicago, 16 July
    expect(completedPlanBlockIds(rows, afterLocalMidnight, "America/Chicago")).toEqual([]);
    expect(completedPlanBlockIds(rows, afterLocalMidnight, "UTC")).toEqual([
      planBlockId("Late review"),
    ]); // same instant, UTC day — proof the tz argument is load-bearing
  });

  it("de-duplicates repeat rows for the same block", () => {
    const ids = completedPlanBlockIds(
      [
        row(`${PLAN_DONE_SUMMARY_PREFIX}Shadow the dialogue (10 min)`, iso("2026-07-15")),
        row(`${PLAN_DONE_SUMMARY_PREFIX}Shadow the dialogue (10 min)`, iso("2026-07-15")),
      ],
      today,
      TZ,
    );
    expect(ids).toHaveLength(1);
  });

  it("ignores a row with an unparseable timestamp instead of throwing", () => {
    expect(
      completedPlanBlockIds([row(`${PLAN_DONE_SUMMARY_PREFIX}x (1 min)`, "not-a-date")], today, TZ),
    ).toEqual([]);
  });
});
