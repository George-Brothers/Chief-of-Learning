import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText }));

const sendMessage = vi.fn();
vi.mock("../lib/telegram", () => ({ sendMessage }));

const enqueueAction = vi.fn();
const getKnownWords = vi.fn(async () => ["我"]);
// EXPOSED vs CARDABLE: card creation filters on getCardedWords (Pleco-sent words excluded).
const getCardedWords = vi.fn(async () => ["我"]);
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
const addEvidence = vi.fn(async () => "EV1");
const getActionRows = vi.fn(async () => [] as any[]);
const requeueAction = vi.fn(async () => {});
vi.mock("../lib/notion", () => ({ addEvidence, enqueueAction, getKnownWords, getCardedWords, readSyllabus, getRecentLessons, readScorecard, readGradebook, readStudyMap, readLedger, getWeekFocus, getRetainedWords, getOpenAssignments, markAssignmentDone, readListeningPending, writeListeningPending, recordListeningResult, getListeningStats, lessonExists, addLesson, getActionRows, requeueAction }));

const makeDeckFromVocab = vi.fn(async () => ({ sent: true, count: 1 }));
vi.mock("../lib/deck", () => ({ makeDeckFromVocab }));

const runLessonFeedback = vi.fn();
const distillLesson = vi.fn();
vi.mock("../lib/lesson", () => ({ runLessonFeedback, distillLesson }));
const dispatchActions = vi.fn();
// enqueueCards stays REAL — it is the single producer every card path now goes through, so the
// assertions below still check what actually reaches the Notion queue rather than a stub.
vi.mock("../lib/actions", async () => ({
  ...(await vi.importActual<typeof import("../lib/actions")>("../lib/actions")),
  dispatchActions,
}));

// hsk is pure — do not mock it.

describe("routeCommand", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    for (const f of [generateObject, generateText, sendMessage, enqueueAction, runLessonFeedback, dispatchActions, getRetainedWords, getOpenAssignments, markAssignmentDone, readListeningPending, writeListeningPending, recordListeningResult, getListeningStats, lessonExists, addLesson, distillLesson, addEvidence, makeDeckFromVocab, getCardedWords]) f.mockReset();
    getCardedWords.mockResolvedValue(["我"]);
    addEvidence.mockResolvedValue("EV1");
    makeDeckFromVocab.mockResolvedValue({ sent: true, count: 1 });
    lessonExists.mockResolvedValue(false);
    addLesson.mockResolvedValue("L-new");
    getRecentLessons.mockResolvedValue([]);
    getRetainedWords.mockResolvedValue([]);
    getOpenAssignments.mockResolvedValue([]);
    readListeningPending.mockResolvedValue(null);
    getListeningStats.mockResolvedValue({ correct: 0, total: 0 });
    getActionRows.mockReset();
    getActionRows.mockResolvedValue([]);
    requeueAction.mockReset();
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

  it("answers a plain-language question with no '?' instead of filing it as evidence", async () => {
    // The bug this replaced: answer-vs-file was decided by a trailing "?", so "What's the plan today"
    // fell through to the evidence path and got "Logged." The classifier owns that call now, and a
    // handled message never reaches the webhook's evidence path at all.
    generateObject.mockResolvedValueOnce({ object: { intent: "answer", request: "" } });
    generateText.mockResolvedValue({ text: "10 new words, then a listening block. 加油 (jiāyóu)!" });
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("What's the plan today", "42")).toBe(true);
    expect(sendMessage.mock.calls[0][1]).toContain("加油");
    expect(enqueueAction).not.toHaveBeenCalled();
  });

  /**
   * Silent evidence loss: "did 30 min of tone drills, is that enough?" both REPORTS work and ASKS.
   * It used to classify as "answer", and answering is terminal — routeCommand returns true, which
   * short-circuits the webhook's evidence path — so the reported study was replied to and then
   * dropped: no evidence row, no scorecard input, no assignment auto-close, no cards. The hybrid
   * intent must do both halves.
   */
  it("answer_log both answers the question AND files the reported work as evidence", async () => {
    generateObject
      .mockResolvedValueOnce({ object: { intent: "answer_log", request: "" } }) // classify
      .mockResolvedValueOnce({ object: { type: "check-in", summary: "30 min of tone drills", newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }], weakSignals: ["tones"] } }); // distill
    generateText.mockResolvedValue({ text: "That's plenty for a Tuesday. 加油 (jiāyóu)!" });
    const msg = "did 30 min of tone drills, is that enough?";
    const { routeCommand } = await import("../lib/command");

    expect(await routeCommand(msg, "42")).toBe(true);
    // Filed — this is what feeds the scorecard, the daily brief and the weekly review.
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(addEvidence.mock.calls[0][0]).toMatchObject({ type: "check-in", rawText: msg });
    // …and new vocab goes to the Anki queue, NOT back as a Pleco file: this automatic path used to
    // hand the learner a .txt to import, which is a chore, not a result.
    expect(makeDeckFromVocab).not.toHaveBeenCalled();
    expect(enqueueAction).toHaveBeenCalledOnce();
    expect(enqueueAction.mock.calls[0][0].type).toBe("create_anki_cards");
    // …and the confirmation names the words without claiming they are already in the deck.
    expect(sendMessage.mock.calls[0][1]).toMatch(/1 new word/);
    expect(sendMessage.mock.calls[0][1]).toMatch(/queued for Anki/);
    expect(sendMessage.mock.calls[0][1]).not.toMatch(/import|Pleco/i);
    // …and the learner gets ONE message carrying both the answer and the confirmation it was filed.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toContain("plenty for a Tuesday");
    expect(sendMessage.mock.calls[0][1]).toContain("30 min of tone drills");
  });

  it("answer_log auto-closes an assignment the reported work satisfies", async () => {
    getOpenAssignments.mockResolvedValue([{ id: "AS1", kind: "homework", description: "write 写字 20×" }]);
    generateObject
      .mockResolvedValueOnce({ object: { intent: "answer_log", request: "" } })
      .mockResolvedValueOnce({ object: { type: "homework", summary: "wrote 写字 20 times", newVocab: [], weakSignals: [] } });
    generateText.mockResolvedValue({ text: "Nice. 加油 (jiāyóu)!" });
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("wrote 写字 20 times — is my stroke order ok?", "42")).toBe(true);
    expect(markAssignmentDone).toHaveBeenCalledWith("AS1");
    expect(sendMessage.mock.calls[0][1]).toContain("write 写字 20×");
  });

  it("answer_log still answers when filing fails (Notion down must not eat the reply)", async () => {
    generateObject
      .mockResolvedValueOnce({ object: { intent: "answer_log", request: "" } })
      .mockResolvedValueOnce({ object: { type: "check-in", summary: "s", newVocab: [], weakSignals: [] } });
    generateText.mockResolvedValue({ text: "Plenty. 加油 (jiāyóu)!" });
    addEvidence.mockRejectedValue(new Error("notion 503"));
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("did 30 min, enough?", "42")).toBe(true);
    const sent = sendMessage.mock.calls[0][1];
    expect(sent).toContain("Plenty");
    expect(sent).not.toContain("Filed"); // never claim it was recorded when it wasn't
  });

  it("returns false for log (falls through to the evidence path)", async () => {
    generateObject.mockResolvedValueOnce({ object: { intent: "log", request: "" } });
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("did 30 min, tones still rough", "42")).toBe(false);
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

  it("consumePendingListening never eats a slash command (the webhook checks it before routing)", async () => {
    readListeningPending.mockResolvedValue({ expected: "跳舞", sentence: "我喜欢＿＿。", ts: new Date().toISOString() });
    const { consumePendingListening } = await import("../lib/command");
    expect(await consumePendingListening("/status", "42")).toBe(false);
    expect(readListeningPending).not.toHaveBeenCalled(); // guarded before the Notion read
    expect(recordListeningResult).not.toHaveBeenCalled();
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

  /**
   * The Pleco export is not deleted, only demoted: lib/pleco.ts and lib/deck.ts are intact and this
   * command is the one way to reach them. Automatic paths never produce a file.
   */
  it("/pleco exports a Pleco file on explicit request", async () => {
    generateObject.mockResolvedValueOnce({
      object: { source: "IC L5 syllabus", label: "Lesson 5", cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }] },
    });
    makeDeckFromVocab.mockResolvedValue({ sent: true, count: 1 });
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("/pleco lesson 5", "42")).toBe(true);
    expect(makeDeckFromVocab).toHaveBeenCalledOnce();
    expect(makeDeckFromVocab.mock.calls[0][3]).toBe("pleco-request");
    expect(sendMessage.mock.calls[0][1]).toMatch(/Pleco file/);
    // An explicit export must NOT also queue Anki cards — /cards is the command for that.
    expect(enqueueAction).not.toHaveBeenCalled();
  });

  it("/pleco says so when there is nothing new to export", async () => {
    generateObject.mockResolvedValueOnce({ object: { source: "s", label: "L", cards: [] } });
    const { routeCommand } = await import("../lib/command");
    expect(await routeCommand("/pleco", "42")).toBe(true);
    expect(makeDeckFromVocab).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatch(/Nothing new to export/i);
  });


  // ---- /agent: the manual half of "make failure loud" ------------------------------------------

  const cardRow = (id: string, n: number, status: string, label = "L4") => ({
    id,
    type: "create_anki_cards",
    status,
    payload: JSON.stringify({ cards: Array.from({ length: n }, () => ({ headword: "词" })), label }),
    result: status === "error" ? "anki 404" : "",
    createdTime: "",
  });

  it("/agent reports presence, the queue and the failures without touching anything", async () => {
    getActionRows.mockResolvedValue([cardRow("t1", 6, "queued"), cardRow("t2", 3, "error")]);
    const { routeCommand } = await import("../lib/command");
    const replies: string[] = [];
    expect(await routeCommand("/agent", "42", async (t) => { replies.push(t); })).toBe(true);
    const msg = replies.join("\n");
    expect(msg).toMatch(/6 waiting in 1 batch/);
    expect(msg).toMatch(/1 batch failed/);
    expect(msg).toContain("/agent retry");
    // Reporting must never re-drive anything on its own.
    expect(requeueAction).not.toHaveBeenCalled();
  });

  it("/agent says the agent has never checked in rather than implying it is fine", async () => {
    const { routeCommand } = await import("../lib/command");
    const replies: string[] = [];
    await routeCommand("/agent", "42", async (t) => { replies.push(t); });
    expect(replies.join("\n")).toMatch(/never checked in|can't tell/);
  });

  it("/agent retry re-queues every burned batch and leaves healthy rows alone", async () => {
    getActionRows.mockResolvedValue([cardRow("t1", 6, "queued"), cardRow("t2", 3, "error"), cardRow("t3", 1, "error")]);
    const { routeCommand } = await import("../lib/command");
    const replies: string[] = [];
    expect(await routeCommand("/agent retry", "42", async (t) => { replies.push(t); })).toBe(true);
    expect(requeueAction.mock.calls.map((c) => c[0])).toEqual(["t2", "t3"]);
    expect(replies.join("\n")).toMatch(/Re-queued 2/);
  });

  it("/agent retry with nothing failed does not pretend it did something", async () => {
    getActionRows.mockResolvedValue([cardRow("t1", 6, "queued")]);
    const { routeCommand } = await import("../lib/command");
    const replies: string[] = [];
    await routeCommand("/agent retry", "42", async (t) => { replies.push(t); });
    expect(requeueAction).not.toHaveBeenCalled();
    expect(replies.join("\n")).toMatch(/Nothing failed/);
  });

  it("/agent retry reports the ones Notion refused instead of over-claiming", async () => {
    getActionRows.mockResolvedValue([cardRow("t2", 3, "error"), cardRow("t3", 1, "error")]);
    requeueAction.mockRejectedValueOnce(new Error("notion 502"));
    const { routeCommand } = await import("../lib/command");
    const replies: string[] = [];
    await routeCommand("/agent retry", "42", async (t) => { replies.push(t); });
    expect(replies.join("\n")).toMatch(/Re-queued 1 failed batch \(1 wouldn't budge/);
  });
});
