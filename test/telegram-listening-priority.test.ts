import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

/**
 * Ordering guard for the webhook's listening path, exercised through the REAL lib/command (only the
 * model SDK, Notion and Telegram are stubbed) — mocking routeCommand/consumePendingListening here
 * would assert on the mocks and prove nothing about which one runs first.
 *
 * The regression: CLASSIFY_PROMPT now says "when unsure, choose answer", so a bare cloze reply like
 * "跳舞" classifies as `answer`. If the route classifies before checking for a pending listening
 * check, the reply is explained instead of scored and the check is never consumable — silently
 * reverting the listening feature.
 */
const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText }));

const sendMessage = vi.fn(async () => {});
const getFileBytes = vi.fn();
vi.mock("@/lib/telegram", () => ({ sendMessage, getFileBytes }));

const readListeningPending = vi.fn(async () => null as { expected: string; sentence: string; ts: string } | null);
const recordListeningResult = vi.fn(async () => {});
const getListeningStats = vi.fn(async () => ({ correct: 3, total: 4 }));
const addEvidence = vi.fn(async () => "pg1");
const getOpenAssignments = vi.fn(async () => []);
vi.mock("@/lib/notion", () => ({
  addEvidence, readListeningPending, recordListeningResult, getListeningStats, getOpenAssignments,
  // Unused by this path, but lib/command imports them at module load.
  enqueueAction: vi.fn(), getKnownWords: vi.fn(async () => []), readSyllabus: vi.fn(async () => []),
  getRecentLessons: vi.fn(async () => []), readScorecard: vi.fn(async () => ""),
  readGradebook: vi.fn(async () => ""), readStudyMap: vi.fn(async () => ""), readLedger: vi.fn(async () => ""),
  getWeekFocus: vi.fn(async () => ""), getRetainedWords: vi.fn(async () => []),
  markAssignmentDone: vi.fn(), writeListeningPending: vi.fn(), lessonExists: vi.fn(async () => false),
  addLesson: vi.fn(), writeListeningResults: vi.fn(),
}));
vi.mock("@/lib/deck", () => ({ makeDeckFromVocab: vi.fn(async () => ({ sent: false, count: 0 })) }));
vi.mock("@/lib/lesson", () => ({ runLessonFeedback: vi.fn(), distillLesson: vi.fn() }));
vi.mock("@/lib/actions", () => ({ dispatchActions: vi.fn() }));
vi.mock("@/lib/brain", () => ({ buildQuestionBrain: vi.fn(async () => "brain") }));

function post(body: unknown) {
  return new Request("http://x/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "SEK" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, { TELEGRAM_WEBHOOK_SECRET: "SEK", TELEGRAM_ALLOWED_CHAT_ID: "42" });
  for (const f of [generateObject, generateText, sendMessage, readListeningPending, recordListeningResult, addEvidence]) f.mockReset();
  getListeningStats.mockResolvedValue({ correct: 3, total: 4 });
  // What the live classifier does with a bare one-word reply now that it biases toward "answer".
  generateObject.mockResolvedValue({ object: { intent: "answer", request: "" } });
  generateText.mockResolvedValue({ text: "跳舞 means to dance. 加油 (jiāyóu)!" });
});

describe("a pending listening check beats the classifier", () => {
  it("scores a one-word reply instead of explaining it", async () => {
    readListeningPending.mockResolvedValue({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: new Date().toISOString() });
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "跳舞" } }));
    expect(res.status).toBe(200);
    expect(recordListeningResult).toHaveBeenCalledWith(true, "跳舞", expect.any(String));
    expect(sendMessage.mock.calls[0][1]).toMatch(/对|✅/);
    // Neither the answer path nor the evidence path may run: the check owns this reply.
    expect(generateText).not.toHaveBeenCalled();
    expect(addEvidence).not.toHaveBeenCalled();
  });

  it("scores a wrong reply too, rather than answering it as a question", async () => {
    readListeningPending.mockResolvedValue({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: new Date().toISOString() });
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, text: "跑步" } }));
    expect(recordListeningResult).toHaveBeenCalledWith(false, "跳舞", expect.any(String));
    expect(generateText).not.toHaveBeenCalled();
  });

  it("still runs slash commands while a check is pending", async () => {
    // The consume-first ordering must not swallow explicit commands.
    readListeningPending.mockResolvedValue({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: new Date().toISOString() });
    generateText.mockResolvedValue({ text: "Here's where you are. 加油 (jiāyóu)!" });
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, text: "/status" } }));
    expect(recordListeningResult).not.toHaveBeenCalled();
    expect(readListeningPending).not.toHaveBeenCalled(); // guarded before the Notion read
    expect(sendMessage.mock.calls[0][1]).toContain("加油");
  });

  it("answers normally once the check has expired", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    readListeningPending.mockResolvedValue({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: threeHoursAgo });
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, text: "跳舞" } }));
    expect(recordListeningResult).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalled(); // the stale check does not starve real questions
  });
});
