import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardBody } from "@/app/dashboard/body";
import type { DashboardData } from "@/lib/dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

const STUDY_MAP = "## Phase 2\n\nHold **是** to nouns only.\n\n- Finish CharWB 3-1\n- 3 listening reps a week";

// A Wednesday (tutor, evening) — 60 self-study minutes per lib/rhythm.ts.
const NOW = "2026-07-15T09:30:00.000Z";

function data(over: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: NOW,
    timezone: "Asia/Shanghai",
    hasLiveData: true,
    coverage: {
      bands: [{ band: 1, known: 300, total: 500, pct: 0.6 }],
      cumulativeKnown: 592,
      cumulativeTotal: 2193,
      gapToTarget: 1601,
      charBands: [],
      charsKnown: 410,
      charsTotal: 973,
    },
    pace: {
      known: 592,
      target: 2193,
      gap: 1601,
      daysLeft: 236,
      wordsPerDayNeeded: 6.8,
      wordsPerWeekNeeded: 18,
      observedPerWeek: 12,
      etaDate: new Date("2027-09-01T00:00:00.000Z"),
      verdict: "behind",
    },
    scorecardChecklist: "",
    streak: 6,
    studyDays: 42,
    xp: { xp: 12340, level: 5, title: "书虫 · Bookworm", intoLevel: 340, forNextLevel: 500, pctToNext: 0.68 },
    weekFocus: "是 before verbs",
    studyMap: STUDY_MAP,
    ledger: "### Ledger\n- 学习 xuéxí study",
    gradebook: "",
    focusAreas: [{ area: "是 before plain verbs", suggestion: "Rewrite 8 sentences.", hits: 3 }],
    activity: [{ id: "a1", createdTime: NOW, type: "check-in", summary: "Did the drill" }],
    lessons: [],
    todayPlan: {
      raw: "- 25 min CharWB 3-1\n- 10 min 是-drill\n加油！",
      blocks: [
        { id: "blk1", text: "CharWB 3-1", minutes: 25 },
        { id: "blk2", text: "是-drill", minutes: 10 },
      ],
      structured: true,
    },
    completedBlockIds: [],
    openAssignments: [
      { id: "as1", kind: "homework", description: "Write 8 sentences", createdTime: NOW, daysCarried: 4 },
    ],
    listening: {
      checks: [{ date: "2026-07-14", ok: true, word: "跳舞" }],
      offers: [],
      weekCount: 0,
      correct: 1,
      total: 1,
      unusedSources: [{ id: "du", name: "Du Chinese", where: "app", hskMin: 1, hskMax: 3 } as never],
    },
    lessonHistory: [
      {
        id: "l1",
        date: "2026-07-13",
        summary: "Worked on **directions**.",
        weakSignals: "tones",
        homework: "- Write 8 sentences",
        vocabIntroduced: [{ headword: "左边", pinyin: "zuǒbian", definition: "left side" }],
        errors: [{ quote: "我是去", kind: "grammar", correction: "我去" }],
        couldNotSay: ["turn left at the lights"],
        grammarPoints: ["directional complements"],
        durationMinutes: 60,
      },
    ],
    agent: {
      presence: "online",
      lastSeenIso: "2026-07-15T09:25:00.000Z",
      ankiReachable: true,
      queuedTasks: 0,
      queuedCards: 0,
      erroredTasks: 0,
      errors: [],
    },
    ...over,
  } as DashboardData;
}

const render = (d: DashboardData = data()) => renderToStaticMarkup(createElement(DashboardBody, { data: d }));

describe("dashboard body", () => {
  it("renders Notion Markdown as formatted output, not literal ## and ** characters", () => {
    const html = render();
    expect(html).toContain("Phase 2");
    expect(html).toContain("<strong>是</strong>");
    expect(html).toContain("<li>");
    expect(html).not.toContain("## Phase 2");
    expect(html).not.toContain("**是**");
  });

  it("leads with today's budget from the real week table and the checkable blocks", () => {
    const html = render();
    // Wednesday is a tutor day with an evening lesson: 60 self-study minutes.
    expect(html).toContain("60");
    expect(html).toContain("tutor · tonight");
    expect(html).toContain("CharWB 3-1");
    expect((html.match(/role="checkbox"/g) ?? []).length).toBe(2);
  });

  it("surfaces couldNotSay from the lesson note", () => {
    const html = render();
    expect(html).toContain("turn left at the lights");
  });

  it("flags a listening week with zero reps as a standing gap", () => {
    expect(render()).toContain("Standing gap");
    const ok = render(data({ listening: { ...data().listening, weekCount: 3 } }));
    expect(ok).toContain("On target");
  });

  it("prints the retained/pace/status readout the direction calls for", () => {
    const html = render();
    expect(html).toContain("592");
    expect(html).toContain("2193");
    expect(html).toContain("27.0%");
    expect(html).toContain("12/wk");
    expect(html).toContain("need 18/wk");
    expect(html).toContain("Behind");
  });

  /**
   * FAILS against the pre-fix page: DashboardData carried no done-set and PlanChecklist ignored one,
   * so a block ticked earlier today rendered unticked on every fresh server render.
   */
  it("renders a block ticked earlier today as still ticked on a fresh load", () => {
    const html = render(data({ completedBlockIds: ["blk2"] }));
    const boxes = html.match(/aria-checked="(true|false)"/g) ?? [];
    expect(boxes).toEqual(['aria-checked="false"', 'aria-checked="true"']);
  });

  /** The capped doc panes have no focusable content of their own — WCAG 2.1.1 needs the container. */
  it("makes the capped Map documents reachable by keyboard", () => {
    const html = render();
    expect(html).toContain('tabindex="0" role="region" aria-label="Study map"');
    expect(html).toContain('tabindex="0" role="region" aria-label="Knowledge ledger"');
  });

  /** Hanzi under lang="en" is read as English; the runs that carry it are marked. */
  it("marks the Chinese runs in lesson notes as zh-Hans", () => {
    const html = render();
    // Matched loosely on purpose: the CSS-module class hash changes whenever the stylesheet does.
    expect(html).toMatch(/<span class="[^"]*hanzi[^"]*" lang="zh-Hans">我是去<\/span>/);
    expect(html).toMatch(/lang="zh-Hans">左边<\/span>/);
    expect(html).toMatch(/lang="zh-Hans">我去<\/span>/); // the correction, not just the quote
  });

  it("says what to do when there is no plan instead of showing an empty box", () => {
    const html = render(data({ todayPlan: { raw: "", blocks: [], structured: false } }));
    expect(html).toContain("Nothing on today&#x27;s post-it yet");
    expect(html).not.toContain('role="checkbox"');
  });
});

/**
 * The agent panel. Everything else on this page describes the learner; this describes the machinery,
 * and it is here because the machinery failing looked exactly like the learner resting.
 */
describe("agent panel", () => {
  const agent = (over: Partial<DashboardData["agent"]>) =>
    render(data({ agent: { ...data().agent, ...over } }));

  it("shows the last check-in, the queue and AnkiConnect when everything is healthy", () => {
    const html = agent({});
    expect(html).toContain("Agent");
    expect(html).toContain("Online");
    expect(html).toContain("2026-07-15");
    expect(html).toContain("open");
    expect(html).toContain("nothing waiting");
  });

  it("reads ALARM — not silence — when the agent is down with cards stuck behind it", () => {
    const html = agent({
      presence: "offline",
      lastSeenIso: "2026-07-12T09:00:00.000Z",
      ankiReachable: false,
      queuedTasks: 2,
      queuedCards: 12,
    });
    expect(html).toContain("Offline");
    expect(html).toContain("action needed");
    expect(html).toContain("12 cards in 2 batches waiting");
    expect(html).toContain("AnkiConnect did not answer");
  });

  it("never invents a check-in for an agent that has never run", () => {
    const html = agent({ presence: "offline", lastSeenIso: null, ankiReachable: null, queuedTasks: 1, queuedCards: 4 });
    expect(html).toContain("has never checked in");
    expect(html).toContain("AnkiConnect has never been probed");
  });

  it("gives every failed batch a visible reason and a way back", () => {
    const html = agent({
      erroredTasks: 1,
      errors: [{ id: "t9", label: "photo 07-14", result: "anki addNote failed: 404" }],
    });
    expect(html).toContain("photo 07-14");
    expect(html).toContain("anki addNote failed: 404");
    expect(html).toContain("/agent retry");
  });
});
