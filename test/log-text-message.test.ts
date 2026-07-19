// logTextMessage is the ONE implementation of "the command router declined this text (intent
// 'log'), so file it": distil → Evidence DB → auto-close a matching assignment → queue new vocab for
// Anki → return the single acknowledgement. It used to be inlined in the Telegram webhook, which is
// why the dashboard chat — the other caller of routeCommand — silently dropped every check-in.
// These assertions moved here from test/telegram-route.test.ts along with the code.
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
const getOpenAssignments = vi.fn(async () => [] as any[]);
const markAssignmentDone = vi.fn(async () => {});
const getActionRows = vi.fn(async () => [] as any[]);
vi.mock("../lib/notion", () => ({
  addEvidence, enqueueAction, getCardedWords, getOpenAssignments, markAssignmentDone, getActionRows,
  getKnownWords: vi.fn(async () => []), readSyllabus: vi.fn(async () => []),
  getRecentLessons: vi.fn(async () => []), readScorecard: vi.fn(async () => ""),
  readGradebook: vi.fn(async () => ""), readStudyMap: vi.fn(async () => ""),
  readLedger: vi.fn(async () => ""), getWeekFocus: vi.fn(async () => ""),
  getRetainedWords: vi.fn(async () => []), readListeningPending: vi.fn(async () => null),
  writeListeningPending: vi.fn(async () => {}), recordListeningResult: vi.fn(async () => {}),
  getListeningStats: vi.fn(async () => ({ correct: 0, total: 0 })),
  lessonExists: vi.fn(async () => false), addLesson: vi.fn(async () => "L1"),
  requeueAction: vi.fn(async () => {}),
}));

const distil = (o: Record<string, unknown>) => generateObject.mockResolvedValueOnce({ object: o });

beforeEach(() => {
  vi.resetModules();
  Object.assign(process.env, FULL_ENV);
  for (const f of [generateObject, generateText, sendMessage, addEvidence, enqueueAction, getCardedWords, getOpenAssignments, markAssignmentDone])
    f.mockReset();
  addEvidence.mockResolvedValue("EV1");
  enqueueAction.mockResolvedValue("Q1");
  getCardedWords.mockResolvedValue([]);
  getOpenAssignments.mockResolvedValue([]);
});

describe("logTextMessage", () => {
  it("acks with what was understood, never the bare string 'Logged.'", async () => {
    distil({
      type: "check-in", summary: "did 30 min of tone drills", weakSignals: ["3rd tone"],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance" }],
    });
    const { logTextMessage } = await import("../lib/command");
    const ack = await logTextMessage("did 30 min of tone drills", "42");
    expect(ack).not.toBe("Logged.");
    expect(ack).toContain("did 30 min of tone drills");
    expect(ack).toContain("3rd tone");
    expect(addEvidence.mock.calls[0][0]).toMatchObject({ type: "check-in", source: "telegram" });
  });

  it("records the surface the message came from", async () => {
    distil({ type: "check-in", summary: "s", weakSignals: [], newVocab: [] });
    const { logTextMessage } = await import("../lib/command");
    await logTextMessage("did 30 min", "42", "web");
    expect((addEvidence.mock.calls[0][0] as any).source).toBe("web");
  });

  it("queues new vocab for Anki and confirms it without claiming it is in the deck", async () => {
    distil({
      type: "check-in", summary: "tutor taught me a word", weakSignals: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
    });
    const { logTextMessage } = await import("../lib/command");
    const ack = await logTextMessage("tutor taught me 跳舞", "42");
    expect(enqueueAction).toHaveBeenCalledOnce();
    expect((enqueueAction.mock.calls[0][0] as any).type).toBe("create_anki_cards");
    expect(ack).toMatch(/1 new word/);
    expect(ack).toMatch(/queued for Anki/);
    expect(ack).not.toMatch(/added to your Anki deck|now in your Anki deck/i);
    expect(ack).not.toMatch(/import|Pleco|\.txt/i);
  });

  it("does not assert the words are 'already carded' when the de-dupe suppressed them", async () => {
    // The suppressing set is the real card record plus the syllabus — it is NOT proof the learner has
    // a card, and it used to be scraped from ledger prose, where it was often flatly untrue.
    getCardedWords.mockResolvedValue(["跳舞"]);
    distil({
      type: "check-in", summary: "practised", weakSignals: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance" }],
    });
    const { logTextMessage } = await import("../lib/command");
    const ack = await logTextMessage("practised 跳舞", "42");
    expect(enqueueAction).not.toHaveBeenCalled();
    expect(ack).not.toMatch(/already carded/);
    expect(ack).toMatch(/Anki queue or your syllabus/);
  });

  it("names an auto-closed assignment in the SAME single ack", async () => {
    getOpenAssignments.mockResolvedValue([{ id: "AS1", kind: "homework", description: "write 写字 20×" }]);
    distil({ type: "homework", summary: "wrote 写字", weakSignals: [], newVocab: [] });
    const { logTextMessage } = await import("../lib/command");
    const ack = await logTextMessage("wrote 写字", "42");
    expect(markAssignmentDone).toHaveBeenCalledWith("AS1");
    expect(ack).toMatch(/marked done: write 写字 20×/i);
    expect(ack).toContain("真棒"); // closing earns the bigger cheer, and only once
    expect(ack).not.toContain("加油");
  });

  it("says so when the enqueue fails instead of acking as if the words were saved", async () => {
    enqueueAction.mockRejectedValue(new Error("notion 502"));
    distil({
      type: "homework", summary: "tutor slide", weakSignals: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance" }],
    });
    const { logTextMessage } = await import("../lib/command");
    const ack = await logTextMessage("learned 跳舞", "42");
    expect(addEvidence).toHaveBeenCalledOnce(); // the evidence row survives the queue error
    expect(ack).toMatch(/couldn't queue/i);
  });

  it("still acks when the distilled summary is empty", async () => {
    distil({ type: "homework", summary: "", weakSignals: [], newVocab: [] });
    const { logTextMessage } = await import("../lib/command");
    const ack = await logTextMessage("here", "42");
    expect(ack).not.toBe("Logged.");
    expect(ack).toContain("homework");
  });
});
