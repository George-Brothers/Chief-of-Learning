import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

// Every Notion reader loadDashboard uses. Each test decides which of them blow up — the point of
// this suite is that an unreachable Notion degrades a card, never the page.
const boom = () => vi.fn(async () => { throw new Error("notion down"); });
const notion = {
  getKnownWords: boom(),
  readScorecard: boom(),
  readStudyMap: boom(),
  readLedger: boom(),
  readGradebook: boom(),
  getWeekFocus: boom(),
  getRecentActivity: boom(),
  getActivityTimestamps: boom(),
  getRecentLessons: boom(),
  getRecentEvidence: boom(),
  readToday: boom(),
  getOpenAssignments: boom(),
  listeningResultLines: boom(),
  getActionRows: boom(),
};
vi.mock("../lib/notion", () => notion);

const now = new Date("2026-07-15T12:00:00Z");

describe("loadDashboard resilience", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV, { TIMEZONE: "UTC" });
  });

  it("returns a full shape with every read failing", async () => {
    const { loadDashboard } = await import("../lib/dashboard");
    const data = await loadDashboard(now);
    expect(data.hasLiveData).toBe(false);
    expect(data.todayPlan).toEqual({ raw: "", blocks: [], structured: false });
    expect(data.openAssignments).toEqual([]);
    expect(data.lessonHistory).toEqual([]);
    expect(data.listening.checks).toEqual([]);
    expect(data.listening.weekCount).toBe(0);
    // The listening inventory is committed data, so it survives Notion being down entirely.
    expect(data.listening.unusedSources.length).toBeGreaterThan(0);
    // The agent card degrades to "we cannot see it" — never to a reassuring zero.
    expect(data.agent).toEqual({
      presence: "unknown",
      lastSeenIso: null,
      ankiReachable: null,
      queuedTasks: 0,
      queuedCards: 0,
      erroredTasks: 0,
      errors: [],
    });
  });

  it("reports agent liveness and the queue when those reads succeed", async () => {
    const { setHeartbeatReader } = await import("../lib/agent-status");
    setHeartbeatReader(async () => ({ lastSeenIso: "2026-07-15T11:58:00Z", ankiReachable: false }));
    notion.getActionRows.mockResolvedValueOnce([
      { id: "t1", type: "create_anki_cards", status: "queued", payload: '{"cards":[1,2,3],"label":"L4"}', result: "", createdTime: "" },
      { id: "t2", type: "create_anki_cards", status: "error", payload: '{"cards":[9],"label":"photo 07-14"}', result: "anki 404", createdTime: "" },
    ] as never);
    try {
      const { loadDashboard } = await import("../lib/dashboard");
      const data = await loadDashboard(now);
      expect(data.agent).toMatchObject({
        presence: "online",
        lastSeenIso: "2026-07-15T11:58:00Z",
        ankiReachable: false,
        queuedTasks: 1,
        queuedCards: 3,
        erroredTasks: 1,
      });
      expect(data.agent.errors[0]).toMatchObject({ id: "t2", label: "photo 07-14", result: "anki 404" });
    } finally {
      setHeartbeatReader(null);
    }
  });

  it("fills the new fields when the reads succeed", async () => {
    notion.readToday.mockResolvedValueOnce("Rewrite 8 sentences dropping 是 — 25 min\n加油！" as never);
    notion.getOpenAssignments.mockResolvedValueOnce([
      { id: "AS1", kind: "drill", description: "rewrite 5", createdTime: "2026-07-12T09:00:00Z" },
    ] as never);
    notion.listeningResultLines.mockResolvedValueOnce([
      "2026-07-15 🎧 lazy-chinese",
      "2026-07-14 ✓ 跳舞",
    ] as never);
    notion.getRecentLessons.mockResolvedValueOnce([
      {
        id: "L1", date: "2026-07-13", summary: "IC L4", weakSignals: "", homework: "", vocabCount: 3,
        noteJson: JSON.stringify({ couldNotSay: ["I'd rather stay home"], vocabIntroduced: [], errors: [] }),
      },
    ] as never);

    const { loadDashboard } = await import("../lib/dashboard");
    const data = await loadDashboard(now);
    expect(data.todayPlan.blocks[0].minutes).toBe(25);
    expect(data.openAssignments[0].daysCarried).toBe(3);
    expect(data.listening.weekCount).toBe(1);
    expect(data.listening.unusedSources.map((s) => s.id)).not.toContain("lazy-chinese");
    expect(data.lessonHistory[0].couldNotSay).toEqual(["I'd rather stay home"]);
  });

  /**
   * FAILS against the pre-fix loader, which had no completedBlockIds at all — the client had no
   * server-side done-set to render from, so every tick vanished on reload.
   */
  it("reads today's already-ticked blocks back out of the evidence feed", async () => {
    const { planBlockId, PLAN_DONE_SUMMARY_PREFIX } = await import("../lib/dashboard");
    notion.readToday.mockResolvedValueOnce("Rewrite 8 sentences dropping 是 — 25 min\n加油！" as never);
    notion.getRecentActivity.mockResolvedValueOnce([
      // Today's tick of that exact line, written by /api/dashboard/plan.
      { id: "e1", createdTime: "2026-07-15T08:00:00Z", type: "check-in",
        summary: `${PLAN_DONE_SUMMARY_PREFIX}Rewrite 8 sentences dropping 是 (25 min)` },
      // The same line ticked yesterday — must NOT come back pre-checked today.
      { id: "e2", createdTime: "2026-07-14T08:00:00Z", type: "check-in",
        summary: `${PLAN_DONE_SUMMARY_PREFIX}Shadow the dialogue (10 min)` },
      // An ordinary check-in is not a plan tick.
      { id: "e3", createdTime: "2026-07-15T09:00:00Z", type: "check-in", summary: "Did 20 min of tones" },
    ] as never);

    const { loadDashboard } = await import("../lib/dashboard");
    const data = await loadDashboard(now);
    expect(data.completedBlockIds).toEqual([planBlockId("Rewrite 8 sentences dropping 是")]);
    expect(data.completedBlockIds).toContain(data.todayPlan.blocks[0].id);
  });
});
