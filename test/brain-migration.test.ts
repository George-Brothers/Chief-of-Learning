import { describe, it, expect } from "vitest";
import {
  migrate, unmatchedRules, absentButExpected, STUDY_MAP_REWRITES, GRADEBOOK_REWRITES, type Rewrite,
} from "../lib/brain-migration";
import { STUDY_MAP, GRADEBOOK } from "../seed/data";

// The Study Map / Gradebook text as it was ACTUALLY seeded into the live Notion brain (seed/data.ts
// at 363ac5e, before the automation-aware rewording landed). The migration exists to fix these exact
// pages, so this — not the current seed — is what the rules must be proven against.
const LEGACY_STUDY_MAP = `# Study Map — what to learn + where
Where they are: Integrated Chinese Vol. 1, Lessons 3–4 (Time & Date → Hobbies).
5 sources: TB textbook · WB workbook · CharWB character workbook (handwriting) ·
Notes own lesson notes · Tutor flashcard slides.

## Current focus (L3–L4)
- Characters: work the Character Workbook in order (Basics → 3-1 → 3-2 → 4-1 → 4-2).
  Hand-write now: 忙 没 字.
- Grammar: numbers to 100, dates, telling time, 的 as modifier, invitation "我请你吃饭",
  alternative questions, A-not-A (I & II), 还 + repeat verb, 是不是 questions,
  有(一)点儿 as predicate, 不行 vs 不好, 想 (want to), verb-object compounds.
- Vocab: time & date words, hobby/activity verbs (听音乐 看电影 跳舞 跑步 游泳 打球 上课 上班),
  food & invitations, response phrases (好的/好啊/没问题/不行), degree adverbs (太…了 非常 特别).
- Speaking/tones: dinner-invite role-play; fix 我请你吃饭, 请他吃饭; drop 是 before a verb.

## The real target: HSK 3.0 by the exam date
Goal = HSK 3.0 (2021), ~2,193 words across bands 1–3 (the HSK-3 tier itself is the 973-word band),
by a fixed exam date. The HSK Scorecard computes exact per-band coverage + a pace/ETA verdict, and
study aims at whatever band is lowest-coverage. Integrated Chinese Vol. 1 only carries a learner
through ~HSK 1–2; it CANNOT reach 973/HSK-3 vocab alone.

## HSK-3 vocab track (source for band 2–3 words, beyond IC Vol. 1)
Once IC L1–L10 vocab is banked, pull new words from a dedicated HSK-3 source to feed bands 2–3:
- IC Vol. 2 (continues the same loop), and/or
- an HSK 2 → HSK 3 Pleco deck worked in band order (finish HSK 1 gaps → HSK 2 → HSK 3).
If the Scorecard shows bands 1–2 near-complete but band 3 flat, that's SOURCE EXHAUSTION, and the
weekly review should flag it: they need new material, not more IC Vol. 1.

## Standing weak spot: LISTENING (biggest gap)
The notes have almost no listening. Only WB Listening Comprehension + Fluency Link cover it.
If a week passes with zero listening, that becomes the day's one action.

## Per-lesson loop (reuse every lesson)
TB (learn) → Pleco (vocab) → CharWB (write) → WB (all 4 skills incl. listening) → tutor (speak)
→ log new words to the Ledger.

## Route from here
1. Lock down L3 (Time & Date): TB L3 → WB L3 → CharWB 3-1 & 3-2.
2. Clear the L3 vocab backlog into Pleco.
3. Drill the 4 recurring grammar points once, well: A-not-A, 是不是, 还+repeat verb, 有(一)点儿.
4. Speak it: dinner-invitation role-play out loud, then with the tutor.
5. Fix flagged tones.
6. Move into L4 (Hobbies): verb-object compounds → WB L4 → CharWB 4-1 & 4-2.
7. Close the listening gap: one WB Listening section per lesson, don't let it lag.
8. Then L5 (Visiting Friends) onward, same loop.`;

const LEGACY_GRADEBOOK = `WEEK FOCUS: Fix 是-before-verb in speech, and do 1 WB listening section (close the listening gap).

# Gradebook — teacher's tracking sheet
The learner reads the verdict; they don't edit it. The Sunday run refreshes it.

## Headline verdict (judged by pace + time)
- Lesson pace: ~1 lesson / 2 weeks (adaptive). On L3–L4. 🟢 on schedule.
- Study time: ≥1.5 hr weekdays. This week: slow start (weekend task carried). 🟡

Lesson windows (flex): L3 (Time & Date) solid in ~2 weeks · L4 (Hobbies) solid in ~4 weeks.

## Skill strands
- Characters & writing 🟡 — first task (忙没字) still open, carried; no photo yet.
- Workbook (all 4 skills) ⚪ — not started.
- Listening 🔴 — known standing gap; protect it. If a week passes with zero listening it becomes the day's one action.
- Vocab / tutor words 🟡 — backlog to clear into Pleco.
- Speaking & tones 🟡 — new fix: drop 是 before a verb; also 我请你吃饭 tones.
- Grammar 🟢 — strong on A-not-A; 是不是 nuance still fuzzy.

## Tutor rhythm — three sessions a week
Recent session: did well on A-not-A (去不去, 看不看, 跳不跳舞) + verb-object compounds
(听音乐, 看电影, 跳舞, 打球) + time periods. Struggled with 是 before a verb, and 是不是 vs A-not-A.
Fix-up: 3 statements aloud with no 是 before the verb.

## Weekly reports
(first Sunday review appends here)`;

const CASES: Array<{ name: string; legacy: string; current: string; rewrites: Rewrite[] }> = [
  { name: "Study Map", legacy: LEGACY_STUDY_MAP, current: STUDY_MAP, rewrites: STUDY_MAP_REWRITES },
  { name: "Gradebook", legacy: LEGACY_GRADEBOOK, current: GRADEBOOK, rewrites: GRADEBOOK_REWRITES },
];

describe("brain text migration", () => {
  for (const c of CASES) {
    it(`${c.name}: every rule finds its target in the text that was actually seeded`, () => {
      // The bug this guards: rule "study-map/listening-inventory" was anchored (^Only WB Listening…)
      // while its target sits mid-line, so it matched nothing, the script printed "already clean",
      // and the live page kept telling the coach to assign workbook listening sections that do not
      // exist. A rule that matches zero lines is a silent no-op, so assert the count per rule.
      const res = migrate(c.legacy, c.rewrites);
      for (const r of c.rewrites) expect(`${r.name}=${res.hits[r.name]}`).toBe(`${r.name}=1`);
      expect(unmatchedRules(c.legacy, res, c.rewrites)).toEqual([]);
    });

    it(`${c.name}: the migrated text carries the new wording and none of the old`, () => {
      const { text } = migrate(c.legacy, c.rewrites);
      for (const r of c.rewrites) {
        expect(r.done.test(text)).toBe(true);
        expect(r.match.test(text)).toBe(false); // idempotence precondition
      }
      expect(text).not.toMatch(/backlog (to clear )?into Pleco/i);
      expect(text).not.toMatch(/WB Listening/);
    });

    it(`${c.name}: re-running changes nothing and still reports no unmatched rules`, () => {
      const once = migrate(c.legacy, c.rewrites);
      const twice = migrate(once.text, c.rewrites);
      expect(twice.diff).toEqual([]);
      // Already-migrated is NOT a failure: each rule's post-state is present, so nothing is flagged.
      expect(unmatchedRules(once.text, twice, c.rewrites)).toEqual([]);
    });

    it(`${c.name}: the current seed is already in the post-migration state`, () => {
      // A future re-seed must not reintroduce the text this migration removes.
      const res = migrate(c.current, c.rewrites);
      expect(res.diff).toEqual([]);
      for (const r of c.rewrites) expect(`${r.name}:${r.done.test(c.current)}`).toBe(`${r.name}:true`);
      expect(unmatchedRules(c.current, res, c.rewrites)).toEqual([]);
    });
  }

  /**
   * The false alarm: app/api/daily-brief/route.ts replaces the WHOLE Gradebook page every Sunday with
   * model-written text, and has already done so. The seeded lines the Gradebook rules target can
   * therefore be legitimately gone — but `unmatchedRules` reported them as broken rules, so
   * `npm run migrate:brain` exited 1 on a healthy brain. A guard that always fails is a guard nobody
   * reads, so the regenerated page's absences must be notes, not failures.
   */
  it("does not fail the run when a REGENERATED page no longer carries its seeded line", () => {
    const regenerated = `WEEK FOCUS: Speak three sentences a day with no 是 before the verb.

# Gradebook — teacher's tracking sheet

## Headline verdict
- Lesson pace: on L4. 🟢
- Vocab: reviews are the gap, not card-making. 🟡`;
    const res = migrate(regenerated, GRADEBOOK_REWRITES);
    expect(res.diff).toEqual([]); // nothing to rewrite — the seeded text is simply gone
    expect(unmatchedRules(regenerated, res, GRADEBOOK_REWRITES)).toEqual([]);
    // …but it is still REPORTED, so a genuinely broken rule isn't invisible either.
    expect(absentButExpected(regenerated, res, GRADEBOOK_REWRITES).map((r) => r.name).sort())
      .toEqual(["gradebook/study-time-budget", "gradebook/vocab-backlog", "gradebook/week-focus"]);
  });

  it("still fails loudly when a SEEDED page's rule finds nothing (the guard stays useful)", () => {
    // The Study Map has no writer in the app, so an absent target there really is a broken rule.
    const rewritten = "# Study Map\nNothing here matches any rule.";
    const res = migrate(rewritten, STUDY_MAP_REWRITES);
    expect(unmatchedRules(rewritten, res, STUDY_MAP_REWRITES).length).toBe(STUDY_MAP_REWRITES.length);
    expect(absentButExpected(rewritten, res, STUDY_MAP_REWRITES)).toEqual([]);
  });

  it("retires the flat ≥1.5 hr weekday study-time verdict for the per-day budgets", () => {
    // seed/data.ts graded study time against "≥1.5 hr weekdays", which the per-day budget model
    // (lib/rhythm.ts: tutor days 60 · Tue/Thu 90 · Fri/Sun 120) replaced in code and prompt while the
    // Notion line stayed live and kept being fed to the coach.
    const { text, hits } = migrate(LEGACY_GRADEBOOK, GRADEBOOK_REWRITES);
    expect(hits["gradebook/study-time-budget"]).toBe(1);
    expect(text).not.toMatch(/1\.5\s*hr/i);
    expect(text).toContain("60 min on tutor days (Mon/Wed/Sat), 90 min Tue/Thu, 120 min Fri/Sun");
    expect(text).toContain("This week: slow start (weekend task carried). 🟡"); // rest of the line kept
  });

  it("flags a rule whose pattern does not fit the live text (the failure that shipped silently)", () => {
    const broken: Rewrite = {
      name: "study-map/listening-inventory (anchored, as shipped)",
      match: /^\s*Only WB Listening Comprehension \+ Fluency Link cover it\.?\s*$/i,
      replace: "…",
      done: /named listening sources each morning/i,
    };
    const res = migrate(LEGACY_STUDY_MAP, [broken]);
    expect(res.diff).toEqual([]); // a diff-is-empty check alone reports this as success
    expect(unmatchedRules(LEGACY_STUDY_MAP, res, [broken]).map((r) => r.name)).toEqual([broken.name]);
  });
});
