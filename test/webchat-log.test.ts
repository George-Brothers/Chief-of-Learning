// Silent evidence loss on the dashboard. routeCommand deliberately returns false for intent "log"
// ("the caller's evidence path distills and files it") — but the Telegram webhook was the ONLY
// caller that had such a path. A check-in typed into the dashboard chat fell through to
// buildQuestionBrain/answerQuestion: no distill, no addEvidence, no enqueueCards. The study was
// answered at and then dropped — the same class of bug already fixed for Telegram via answer_log.
//
// The command layer runs for REAL here (only the model and Notion are stubbed), so this asserts what
// actually reaches the Evidence DB and the Anki queue, not that some helper was called.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText }));

const sendMessage = vi.fn(async () => {});
vi.mock("../lib/telegram", () => ({ sendMessage }));

const addEvidence = vi.fn(async () => "EV1");
const enqueueAction = vi.fn(async () => "Q1");
const getCardedWords = vi.fn(async () => [] as string[]);
const getKnownWords = vi.fn(async () => [] as string[]);
const getOpenAssignments = vi.fn(async () => [] as any[]);
const markAssignmentDone = vi.fn(async () => {});
const getActionRows = vi.fn(async () => [] as any[]);
const readStudyMap = vi.fn(async () => "IC Lesson 4");
const readLedger = vi.fn(async () => "knows 我 你");
vi.mock("../lib/notion", () => ({
  addEvidence, enqueueAction, getCardedWords, getKnownWords, getOpenAssignments, markAssignmentDone,
  getActionRows, readStudyMap, readLedger,
  readSyllabus: vi.fn(async () => []), getRecentLessons: vi.fn(async () => []),
  readScorecard: vi.fn(async () => ""), readGradebook: vi.fn(async () => ""),
  getWeekFocus: vi.fn(async () => ""), getRetainedWords: vi.fn(async () => []),
  readListeningPending: vi.fn(async () => null), writeListeningPending: vi.fn(async () => {}),
  recordListeningResult: vi.fn(async () => {}), getListeningStats: vi.fn(async () => ({ correct: 0, total: 0 })),
  lessonExists: vi.fn(async () => false), addLesson: vi.fn(async () => "L1"),
  requeueAction: vi.fn(async () => {}),
}));

const CHECKIN = "did 30 min of tone drills, tutor taught me 跳舞";

beforeEach(() => {
  vi.resetModules();
  Object.assign(process.env, FULL_ENV, { TELEGRAM_ALLOWED_CHAT_ID: "42" });
  for (const f of [generateObject, generateText, sendMessage, addEvidence, enqueueAction, getCardedWords, getOpenAssignments, markAssignmentDone])
    f.mockReset();
  addEvidence.mockResolvedValue("EV1");
  enqueueAction.mockResolvedValue("Q1");
  getCardedWords.mockResolvedValue([]);
  getOpenAssignments.mockResolvedValue([]);
  generateObject
    .mockResolvedValueOnce({ object: { intent: "log", request: "" } }) // classify
    .mockResolvedValueOnce({ object: {                                  // distill
      type: "check-in",
      summary: "30 min of tone drills",
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
      weakSignals: ["3rd tone"],
    } });
});

describe("a check-in typed into the dashboard chat", () => {
  it("is filed as evidence — not answered and dropped", async () => {
    const { respondToMessage } = await import("../lib/webchat");
    await respondToMessage(CHECKIN);
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(addEvidence.mock.calls[0][0]).toMatchObject({ type: "check-in", rawText: CHECKIN });
  });

  it("queues its new vocab for Anki", async () => {
    const { respondToMessage } = await import("../lib/webchat");
    await respondToMessage(CHECKIN);
    expect(enqueueAction).toHaveBeenCalledOnce();
    const a = enqueueAction.mock.calls[0][0] as { type: string; payload: string };
    expect(a.type).toBe("create_anki_cards");
    expect(JSON.parse(a.payload).cards[0].headword).toBe("跳舞");
  });

  it("acknowledges what it understood, in the HTTP reply", async () => {
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage(CHECKIN);
    expect(out.reply).toContain("30 min of tone drills");
    expect(out.reply).toMatch(/queued for Anki|Anki/i);
    // the reply goes back over HTTP; the web surface must not push it to Telegram as well
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("closes an assignment the check-in satisfies, like Telegram does", async () => {
    getOpenAssignments.mockResolvedValue([{ id: "AS1", kind: "drill", description: "practise 跳舞" }]);
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage(CHECKIN);
    expect(markAssignmentDone).toHaveBeenCalledWith("AS1");
    expect(out.reply).toContain("practise 跳舞");
  });

  it("still returns a reply when filing fails — and never claims it was filed", async () => {
    addEvidence.mockRejectedValue(new Error("notion 503"));
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage(CHECKIN);
    expect(out.reply.trim()).not.toBe("");
    expect(out.reply).not.toMatch(/Got it/);
  });
});
