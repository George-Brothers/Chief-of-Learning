import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FULL_ENV } from "./helpers";
import { setHeartbeatReader } from "@/lib/agent-status";

afterEach(() => setHeartbeatReader(null));

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
  getRecentListeningSourceIds: vi.fn(async () => [] as string[]),
  recordListeningOffer: vi.fn(async () => {}),
  getActionRows: vi.fn(async () => [] as any[]),
};
const sendMessage = vi.fn(async () => {});
const makeDeckFromVocab = vi.fn(async () => ({ sent: false, count: 0 }));
const runLessonFeedback = vi.fn();
const dispatchActions = vi.fn();
const enqueueCards = vi.fn(async () => 0);

vi.mock("@/lib/ai", () => ({ runDailyCoach, runWeeklyReview }));
vi.mock("@/lib/notion", () => notion);
vi.mock("@/lib/telegram", () => ({ sendMessage }));
vi.mock("@/lib/deck", () => ({ makeDeckFromVocab }));
vi.mock("@/lib/lesson", () => ({ runLessonFeedback }));
vi.mock("@/lib/actions", () => ({ dispatchActions, enqueueCards }));

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, { CRON_SECRET: "CRN" });
  for (const f of [runDailyCoach, runWeeklyReview, sendMessage, makeDeckFromVocab, runLessonFeedback, dispatchActions, enqueueCards]) f.mockClear();
  enqueueCards.mockResolvedValue(0);
  for (const f of Object.values(notion)) f.mockClear();
  notion.getUnprocessedLessons.mockResolvedValue([]);
  notion.getActionRows.mockResolvedValue([]);
  setHeartbeatReader(null);
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

  it("sizes the day from studyPlanShape and offers real named listening sources", async () => {
    // Tue 2026-07-07, 12:00 Chicago → the 90-minute weekday budget, not an invented duration.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T17:00:00Z"));
    try {
      const { GET } = await import("@/app/api/daily-brief/route");
      expect((await GET(req("Bearer CRN"))).status).toBe(200);

      const ctx = runDailyCoach.mock.calls[0][0] as any;
      expect(ctx.budgetMinutes).toBe(90);
      expect(ctx.listeningOptions).toContain("min");
      const offered = ctx.listeningOptions.split("\n");
      expect(offered.length).toBe(3);
      // Every offered line names a source that exists in the committed inventory.
      const { LISTENING_SOURCES } = await import("@/lib/listening-sources");
      const names = offered.map(
        (line: string) => LISTENING_SOURCES.find((s) => line.includes(s.name))!,
      );
      expect(names.every(Boolean)).toBe(true);
      // ...and exactly those sources are the ones recorded, so tomorrow rotates past them.
      expect(notion.recordListeningOffer).toHaveBeenCalledOnce();
      const [ids, date] = notion.recordListeningOffer.mock.calls[0] as any[];
      expect(ids).toEqual(names.map((s: { id: string }) => s.id));
      expect(date).toBe("2026-07-07");
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds the listening rotation from the local day, not UTC", async () => {
    // 21:00 Tue in Chicago is already Wed in UTC. Seeding off getUTCDate() there would pick a
    // different rotation than the date this same run stamps on the offer record.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T02:00:00Z"));
    try {
      const { GET } = await import("@/app/api/daily-brief/route");
      expect((await GET(req("Bearer CRN"))).status).toBe(200);
      const { selectListeningSources } = await import("@/lib/listening-sources");
      const expected = selectListeningSources({ budgetMinutes: 90, seed: 7 }).map((s) => s.id);
      const [ids, date] = notion.recordListeningOffer.mock.calls[0] as any[];
      expect(ids).toEqual(expected);
      expect(date).toBe("2026-07-07");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still delivers the brief when the listening bookkeeping write fails", async () => {
    // recordListeningOffer sits between writeToday and prependDailyLog; an unguarded throw there
    // used to abort after the post-it was written but before the learner ever saw it.
    notion.recordListeningOffer.mockRejectedValueOnce(new Error("notion 502"));
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    expect(notion.prependDailyLog).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toContain("忙没字");
  });

  it("sends the brief's new vocab to Anki and no longer attaches a Pleco file", async () => {
    // daily.newVocab only ever became a Pleco .txt — it never reached the Anki queue. The .txt is now
    // gone from this automatic path; the brief carries a one-line confirmation instead of a file.
    Object.assign(process.env, FULL_ENV, { CRON_SECRET: "CRN" });
    runDailyCoach.mockResolvedValue({
      todayPostit: "go", dailyLogEntry: "e", ledgerNotes: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
    } as any);
    enqueueCards.mockResolvedValue(1);
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    expect(enqueueCards).toHaveBeenCalledOnce();
    expect(enqueueCards.mock.calls[0][0]).toHaveLength(1);
    expect(makeDeckFromVocab).not.toHaveBeenCalled();
    const msg = sendMessage.mock.calls.at(-1)![1] as string;
    expect(msg).toContain("go");                       // the post-it still leads
    expect(msg).toMatch(/1 new word/);                 // …with the card confirmation appended
    expect(msg).toMatch(/queued for Anki/);            // never "added to your deck": nothing drained yet
    expect(msg).not.toMatch(/import|Pleco|\.txt/i);
  });

  it("leaves the brief unchanged when there is no new vocab", async () => {
    Object.assign(process.env, FULL_ENV, { CRON_SECRET: "CRN" });
    runDailyCoach.mockResolvedValue({ todayPostit: "go", dailyLogEntry: "e", ledgerNotes: [], newVocab: [] } as any);
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    expect(enqueueCards).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.at(-1)![1]).toBe("go");
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

/**
 * The loud-failure line. For weeks the local agent being down was indistinguishable from a week with
 * no study material: cards went into the Notion queue, nothing drained them, and nothing anywhere
 * said so. This line is assembled in the ROUTE, from observed state — never asked of the model — so
 * it cannot be paraphrased away on a bad day or hallucinated on a good one.
 */
describe("daily-brief agent alarm", () => {
  const queuedRow = (n: number, status = "queued") => ({
    id: `t-${status}-${n}`,
    type: "create_anki_cards",
    status,
    payload: JSON.stringify({ cards: Array.from({ length: n }, () => ({ headword: "词" })), label: "L4" }),
    result: status === "error" ? "anki addNote failed: 404" : "",
    createdTime: "2026-07-16T04:00:00.000Z",
  });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  // Earlier suites leave a mockResolvedValue on runDailyCoach; pin the post-it these tests read.
  beforeEach(() => {
    runDailyCoach.mockResolvedValue({
      todayPostit: "Your 1.5h: CharWB 3-1, write 忙没字 10x.",
      dailyLogEntry: "e",
      ledgerNotes: [],
      newVocab: [],
    } as any);
  });

  it("leads with the outage when the agent is down AND cards are stuck", async () => {
    const seen = hoursAgo(75); // three days and change
    setHeartbeatReader(async () => ({ lastSeenIso: seen, ankiReachable: false }));
    notion.getActionRows.mockResolvedValue([queuedRow(7), queuedRow(5)]);
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);

    const msg = sendMessage.mock.calls.at(-1)![1] as string;
    expect(msg).toContain("12 cards are waiting");
    expect(msg).toMatch(/3 days/);
    // Loud means FIRST — above the post-it, not buried under it.
    expect(msg.indexOf("Anki agent")).toBeLessThan(msg.indexOf("忙没字"));
    // …and the post-it is still delivered in full.
    expect(msg).toContain("忙没字");
  });

  it("says nothing when the agent is down but nothing is queued", async () => {
    setHeartbeatReader(async () => ({ lastSeenIso: hoursAgo(9 * 24) }));
    notion.getActionRows.mockResolvedValue([]);
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    expect(sendMessage.mock.calls.at(-1)![1]).not.toMatch(/offline|agent/i);
  });

  it("says nothing when the agent is checking in, even with a full queue", async () => {
    setHeartbeatReader(async () => ({ lastSeenIso: new Date().toISOString(), ankiReachable: true }));
    notion.getActionRows.mockResolvedValue([queuedRow(30)]);
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    expect(sendMessage.mock.calls.at(-1)![1]).not.toMatch(/offline|never checked in/i);
  });

  it("reports burned batches even while the agent is up, and names the way back", async () => {
    setHeartbeatReader(async () => ({ lastSeenIso: new Date().toISOString(), ankiReachable: true }));
    notion.getActionRows.mockResolvedValue([queuedRow(2, "error")]);
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    const msg = sendMessage.mock.calls.at(-1)![1] as string;
    expect(msg).toContain("1 card batch failed");
    expect(msg).toContain("/agent retry");
  });

  it("still delivers the brief when the queue read itself fails", async () => {
    notion.getActionRows.mockRejectedValue(new Error("notion 502"));
    const { GET } = await import("@/app/api/daily-brief/route");
    expect((await GET(req("Bearer CRN"))).status).toBe(200);
    expect(sendMessage.mock.calls.at(-1)![1]).toContain("忙没字");
  });
});
