import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText }));

const sendMessage = vi.fn();
vi.mock("../lib/telegram", () => ({ sendMessage }));

const enqueueAction = vi.fn();
const getKnownWords = vi.fn(async () => ["我"]);
const readSyllabus = vi.fn(async () => [{ chapter: "IC L5", section: "textbook", vocab: "跳舞", grammar: "" }]);
const getRecentLessons = vi.fn(async () => []);
const readScorecard = vi.fn(async () => "");
const readGradebook = vi.fn(async () => "");
const readStudyMap = vi.fn(async () => "");
const readLedger = vi.fn(async () => "");
const getWeekFocus = vi.fn(async () => "");
const getRetainedWords = vi.fn(async () => []);
const getOpenAssignments = vi.fn(async () => []);
const markAssignmentDone = vi.fn(async () => {});
const readListeningPending = vi.fn(async () => null);
const writeListeningPending = vi.fn(async () => {});
const recordListeningResult = vi.fn(async () => {});
const getListeningStats = vi.fn(async () => ({ correct: 0, total: 0 }));
const lessonExists = vi.fn(async () => false);
const addLesson = vi.fn(async () => "L-new");
vi.mock("../lib/notion", () => ({ enqueueAction, getKnownWords, readSyllabus, getRecentLessons, readScorecard, readGradebook, readStudyMap, readLedger, getWeekFocus, getRetainedWords, getOpenAssignments, markAssignmentDone, readListeningPending, writeListeningPending, recordListeningResult, getListeningStats, lessonExists, addLesson }));

const runLessonFeedback = vi.fn();
const distillLesson = vi.fn();
vi.mock("../lib/lesson", () => ({ runLessonFeedback, distillLesson }));
const dispatchActions = vi.fn();
vi.mock("../lib/actions", () => ({ dispatchActions }));

// hsk is pure — do not mock it.

describe("routeCommand", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    for (const f of [generateObject, generateText, sendMessage, enqueueAction, runLessonFeedback, dispatchActions, getRetainedWords, getOpenAssignments, markAssignmentDone, readListeningPending, writeListeningPending, recordListeningResult, getListeningStats, lessonExists, addLesson, distillLesson]) f.mockReset();
    lessonExists.mockResolvedValue(false);
    addLesson.mockResolvedValue("L-new");
    getRecentLessons.mockResolvedValue([]);
    getRetainedWords.mockResolvedValue([]);
    getOpenAssignments.mockResolvedValue([]);
    readListeningPending.mockResolvedValue(null);
    getListeningStats.mockResolvedValue({ correct: 0, total: 0 });
  });

  it("/cards enqueues a notify action and acks (deterministic slash, no classify)", async () => {
    generateObject.mockResolvedValue({ object: { source: "IC L5 syllabus", label: "Lesson 5", cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }] } });
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("/cards lesson 5", "42");
    expect(handled).toBe(true);
    expect(generateText).not.toHaveBeenCalled(); // slash path never classifies
    const payload = JSON.parse(enqueueAction.mock.calls[0][0].payload);
    expect(payload.notify).toBe(true);
    expect(payload.label).toBe("Lesson 5");
    expect(payload.cards).toHaveLength(1);
    expect(sendMessage.mock.calls[0][1]).toContain("Lesson 5");
  });

  it("make_cards drops words already known, and says so when nothing is left", async () => {
    generateObject
      .mockResolvedValueOnce({ object: { intent: "make_cards", request: "lesson 5" } }) // classify
      .mockResolvedValueOnce({ object: { source: "s", label: "Lesson 5", cards: [{ headword: "我", pinyin: "wǒ", definition: "I", example: "我好。" }] } }); // assemble (all known)
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("make lesson 5 flashcards", "42");
    expect(handled).toBe(true);
    expect(enqueueAction).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatch(/already/i);
  });

  it("status classifies and replies without enqueuing", async () => {
    generateObject.mockResolvedValueOnce({ object: { intent: "status", request: "" } });
    generateText.mockResolvedValue({ text: "You're at HSK1 62%. 加油 (jiāyóu)!" });
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("how am I doing?", "42");
    expect(handled).toBe(true);
    expect(sendMessage.mock.calls[0][1]).toContain("加油");
    expect(enqueueAction).not.toHaveBeenCalled();
  });

  it("returns false for other (falls through to existing behavior)", async () => {
    generateObject.mockResolvedValueOnce({ object: { intent: "other", request: "" } });
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("what does 好 mean?", "42")).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("routes replies to a custom Responder instead of Telegram (web dashboard reuse)", async () => {
    generateObject.mockResolvedValue({ object: { source: "IC L5 syllabus", label: "Lesson 5", cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }] } });
    const { routeCommand } = await import("../lib/command");
    const collected: string[] = [];
    const handled = await routeCommand("/cards lesson 5", "42", async (t) => { collected.push(t); });
    expect(handled).toBe(true);
    expect(collected[0]).toContain("Lesson 5");
    expect(sendMessage).not.toHaveBeenCalled(); // the custom responder replaced the Telegram sink
  });

  it("feedback runs the Opus pass and dispatches its actions", async () => {
    generateObject.mockResolvedValueOnce({ object: { intent: "feedback", request: "" } });
    getRecentLessons.mockResolvedValue([
      { id: "L1", date: "2026-07-14", summary: "hobbies", weakSignals: "", homework: "", vocabCount: 1, noteJson: "{}" },
    ]);
    runLessonFeedback.mockResolvedValue({ feedback: "Fix 是-before-verb today. 加油 (jiāyóu)!", actions: [{ type: "queue_drill", drill: "rewrite 5" }] });
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("give me feedback on my last lesson", "42");
    expect(handled).toBe(true);
    expect(sendMessage.mock.calls[0][1]).toContain("是-before-verb");
    expect(dispatchActions).toHaveBeenCalledOnce();
  });

  it("/done closes the single open assignment", async () => {
    getOpenAssignments.mockResolvedValue([{ id: "AS1", kind: "reading", description: "Du Chinese story" }]);
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("/done", "42");
    expect(handled).toBe(true);
    expect(markAssignmentDone).toHaveBeenCalledWith("AS1");
    expect(sendMessage.mock.calls[0][1]).toMatch(/done|✓|✅/i);
  });

  it("auto-closes an open assignment when evidence confidently matches it", async () => {
    getOpenAssignments.mockResolvedValue([
      { id: "AS1", kind: "homework", description: "write 写字 20×" },
      { id: "AS2", kind: "reading", description: "Du Chinese story about 天气" },
    ]);
    const { autoCloseAssignmentFromEvidence } = await import("../lib/command");
    const closed = await autoCloseAssignmentFromEvidence({
      type: "homework", summary: "photo of 写字 practice, 20 reps", newVocab: [], weakSignals: [],
    });
    expect(closed?.id).toBe("AS1");
    expect(markAssignmentDone).toHaveBeenCalledWith("AS1");
  });

  it("closes nothing when the evidence is ambiguous (matches two open assignments)", async () => {
    getOpenAssignments.mockResolvedValue([
      { id: "AS1", kind: "homework", description: "drill 天气 vocab" },
      { id: "AS2", kind: "reading", description: "read the 天气 forecast" },
    ]);
    const { autoCloseAssignmentFromEvidence } = await import("../lib/command");
    const closed = await autoCloseAssignmentFromEvidence({
      type: "check-in", summary: "studied 天气 words today", newVocab: [], weakSignals: [],
    });
    expect(closed).toBeUndefined();
    expect(markAssignmentDone).not.toHaveBeenCalled();
  });

  it("closes nothing when no open assignment shares vocabulary with the evidence", async () => {
    getOpenAssignments.mockResolvedValue([{ id: "AS1", kind: "reading", description: "Du Chinese story" }]);
    const { autoCloseAssignmentFromEvidence } = await import("../lib/command");
    const closed = await autoCloseAssignmentFromEvidence({
      type: "check-in", summary: "did 30 min of tones", newVocab: [], weakSignals: [],
    });
    expect(closed).toBeUndefined();
    expect(markAssignmentDone).not.toHaveBeenCalled();
  });

  it("matches on a new-vocab headword, and ignores common single-character noise", async () => {
    const { matchEvidenceToAssignment } = await import("../lib/command");
    const open = [{ id: "AS1", kind: "homework", description: "make 跳舞 cards" }];
    // Single-char 我 must NOT match anything; the 跳舞 headword must.
    expect(matchEvidenceToAssignment({ summary: "我 practiced", newVocab: [], weakSignals: [] }, open)).toBeUndefined();
    expect(
      matchEvidenceToAssignment(
        { summary: "", newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance" }], weakSignals: [] },
        open,
      )?.id,
    ).toBe("AS1");
  });

  it("/listen builds a cloze from a lesson and stores pending", async () => {
    getRecentLessons.mockResolvedValue([{ id: "L1", date: "2026-07-15", summary: "hobbies", weakSignals: "", homework: "", vocabCount: 1,
      noteJson: JSON.stringify({ summary: "", vocabIntroduced: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }], errors: [], grammarPoints: [], couldNotSay: [], homeworkAssigned: "", durationMinutes: 30 }) }]);
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("/listen", "42")).toBe(true);
    expect(writeListeningPending).toHaveBeenCalledWith(expect.objectContaining({ expected: "跳舞" }));
    expect(sendMessage.mock.calls[0][1]).toContain("＿＿");
  });

  it("consumePendingListening scores a correct answer", async () => {
    readListeningPending.mockResolvedValue({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: new Date().toISOString() });
    const { consumePendingListening } = await import("../lib/command");
    const handled = await consumePendingListening("跳舞", "42");
    expect(handled).toBe(true);
    expect(recordListeningResult).toHaveBeenCalledWith(true, "跳舞", expect.any(String));
    expect(sendMessage.mock.calls[0][1]).toMatch(/对|✅/);
  });

  it("consumePendingListening ignores when no pending", async () => {
    readListeningPending.mockResolvedValue(null);
    const { consumePendingListening } = await import("../lib/command");
    expect(await consumePendingListening("anything", "42")).toBe(false);
  });

  it("/lesson logs a pasted note and queues cards for new vocab", async () => {
    distillLesson.mockResolvedValue({
      summary: "practiced writing", vocabIntroduced: [{ headword: "写字", pinyin: "xiězì", definition: "write characters", example: "我写字。" }],
      errors: [{ quote: "写字", kind: "tone", correction: "xiězì" }], grammarPoints: [], couldNotSay: [], homeworkAssigned: "write 20×", durationMinutes: 0,
    });
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("/lesson wrote 写字 20 times", "42");
    expect(handled).toBe(true);
    expect(lessonExists).toHaveBeenCalledOnce();
    expect(distillLesson).toHaveBeenCalledWith("wrote 写字 20 times");
    expect(addLesson.mock.calls[0][0].transcript).toBe("wrote 写字 20 times");
    expect(addLesson.mock.calls[0][0].vocabCount).toBe(1);
    const payload = JSON.parse(enqueueAction.mock.calls[0][0].payload);
    expect(payload.notify).toBe(true);
    expect(payload.cards).toHaveLength(1);
    expect(sendMessage.mock.calls[0][1]).toMatch(/logged/i);
  });

  it("/lesson dedups on content hash and does not re-add", async () => {
    lessonExists.mockResolvedValue(true);
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("/lesson wrote 写字 20 times", "42");
    expect(handled).toBe(true);
    expect(distillLesson).not.toHaveBeenCalled();
    expect(addLesson).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatch(/already logged/i);
  });

  it("/note is an alias for /lesson", async () => {
    distillLesson.mockResolvedValue({
      summary: "quick note", vocabIntroduced: [], errors: [], grammarPoints: [], couldNotSay: [], homeworkAssigned: "", durationMinutes: 0,
    });
    const { routeCommand } = await import("../lib/command");
    const handled = await routeCommand("/note reviewed HSK1 list", "42");
    expect(handled).toBe(true);
    expect(addLesson).toHaveBeenCalledOnce();
    expect(enqueueAction).not.toHaveBeenCalled(); // no new vocab → no card enqueue
  });
});
