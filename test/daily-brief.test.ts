import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const runDailyCoach = vi.fn(async () => ({
  todayPostit: "Your 1.5h: CharWB 3-1, write 忙没字 10x.",
  dailyLogEntry: "ONE action: ...",
  newVocab: [],
  ledgerNotes: [],
}));
const runWeeklyReview = vi.fn(async () => ({
  weeklyReport: "report",
  weekFocus: "listening",
  gradebookUpdate: "verdict",
  scorecardChecklist: "## Grammar\n[ ] 是 A是B",
}));

const notion = {
  getUnprocessedEvidence: vi.fn(async () => [] as any[]),
  getRecentEvidence: vi.fn(async () => [] as any[]),
  markProcessed: vi.fn(async () => {}),
  readDailyLog: vi.fn(async () => "log"),
  readStudyMap: vi.fn(async () => "map"),
  readLedger: vi.fn(async () => "ledger"),
  readGradebook: vi.fn(async () => "gradebook"),
  getWeekFocus: vi.fn(async () => "focus"),
  getKnownWords: vi.fn(async () => ["爱", "八"] as string[]),
  readScorecard: vi.fn(async () => ""),
  writeScorecard: vi.fn(async () => {}),
  writeToday: vi.fn(async () => {}),
  prependDailyLog: vi.fn(async () => {}),
  appendLedgerNotes: vi.fn(async () => {}),
  writeGradebook: vi.fn(async () => {}),
  getUnprocessedLessons: vi.fn(async () => []),
  markLessonsProcessed: vi.fn(async () => {}),
  getRetainedWords: vi.fn(async () => [] as string[]),
  getOpenAssignments: vi.fn(async () => [] as any[]),
};
const sendMessage = vi.fn(async () => {});
const makeDeckFromVocab = vi.fn(async () => ({ sent: false, count: 0 }));
const runLessonFeedback = vi.fn();
const dispatchActions = vi.fn();

vi.mock("@/lib/ai", () => ({ runDailyCoach, runWeeklyReview }));
vi.mock("@/lib/notion", () => notion);
vi.mock("@/lib/telegram", () => ({ sendMessage }));
vi.mock("@/lib/deck", () => ({ makeDeckFromVocab }));
vi.mock("@/lib/lesson", () => ({ runLessonFeedback }));
vi.mock("@/lib/actions", () => ({ dispatchActions }));

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, { CRON_SECRET: "CRN" });
  for (const f of [runDailyCoach, runWeeklyReview, sendMessage, makeDeckFromVocab, runLessonFeedback, dispatchActions]) f.mockClear();
  for (const f of Object.values(notion)) f.mockClear();
  notion.getUnprocessedLessons.mockResolvedValue([]);
});

const req = (auth?: string) =>
  new Request("http://x/api/daily-brief", { headers: auth ? { authorization: auth } : {} });

describe("daily-brief cron", () => {
  it("rejects a missing/incorrect bearer with 401", async () => {
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer WRONG"))).status).toBe(401);
  });

  it("writes today + sends the post-it on the happy path", async () => {
    const { GET } = await import("@/app/api/daily-brief/route");
    const res = await GET(req("Bearer CRN"));
    expect(res.status).toBe(200);
    expect(runDailyCoach).toHaveBeenCalledOnce();
    expect(notion.writeToday).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toContain("忙没字");
  });

  it("includes post-lesson feedback and dispatches its actions", async () => {
    Object.assign(process.env, FULL_ENV, { CRON_SECRET: "CRN" });
    notion.getUnprocessedLessons.mockResolvedValue([
      { id: "L1", date: "2026-07-14", summary: "hobbies", weakSignals: "grammar", homework: "", vocabCount: 1 },
    ]);
    notion.markLessonsProcessed.mockResolvedValue(undefined);
    runLessonFeedback.mockResolvedValue({
      feedback: "Fix 是-before-verb today. 加油 (jiāyóu)!",
      actions: [{ type: "queue_drill", drill: "rewrite 5 sentences" }],
    });
    const { GET } = await import("@/app/api/daily-brief/route");
    const res = await GET(req("Bearer CRN"));
    expect(res.status).toBe(200);
    expect(runLessonFeedback).toHaveBeenCalledOnce();
    expect(dispatchActions).toHaveBeenCalledOnce();
    expect(notion.markLessonsProcessed).toHaveBeenCalledWith(["L1"]);
    // Feedback reaches the learner.
    const sent = sendMessage.mock.calls.map((c: unknown[]) => c[1]).join("\n");
    expect(sent).toContain("是-before-verb");
  });

  it("computes coverage on retained and shows exposed", async () => {
    Object.assign(process.env, FULL_ENV, { CRON_SECRET: "CRN" });
    notion.getRetainedWords.mockResolvedValue(["我"]);
    notion.getKnownWords.mockResolvedValue(["我", "你", "他", "她"]);
    notion.getOpenAssignments.mockResolvedValue([]);
    const { GET } = await import("@/app/api/daily-brief/route");
    const res = await GET(req("Bearer CRN"));
    expect(res.status).toBe(200);
    // scorecard written contains the Exposed line
    const wrote = notion.writeScorecard.mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(wrote).toMatch(/Exposed: 4 words shown/);
  });
});
