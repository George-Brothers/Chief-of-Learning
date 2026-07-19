import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FULL_ENV } from "./helpers";

const generateObject = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText: vi.fn() }));

describe("distillLesson", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    // The long-context role's primary is Gemini, so wire the (optional) Google key for this test.
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g";
    generateObject.mockReset();
  });
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  it("returns the model's structured lesson note", async () => {
    const note = {
      summary: "Reviewed hobbies; practiced 喜欢.",
      vocabIntroduced: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "to dance", example: "我喜欢跳舞。" }],
      errors: [{ quote: "你是喜欢跳舞", kind: "grammar", correction: "你喜欢跳舞" }],
      grammarPoints: ["喜欢 + verb"],
      couldNotSay: ["what time class starts"],
      homeworkAssigned: "Write 5 sentences with 喜欢.",
      durationMinutes: 55,
    };
    generateObject.mockResolvedValue({ object: note });
    const { distillLesson } = await import("../lib/lesson");
    const result = await distillLesson("... long transcript ...");
    expect(result.vocabIntroduced[0].headword).toBe("跳舞");
    expect(result.errors[0].kind).toBe("grammar");
    // Full-transcript compression → long-context role (Gemini Flash, direct Google provider).
    const model = generateObject.mock.calls[0][0].model;
    expect(model.provider).toBe("google.generative-ai");
    expect(model.modelId).toBe("gemini-2.5-flash");
  });
});

describe("runLessonFeedback", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    generateObject.mockReset();
  });

  it("returns feedback plus typed actions from the reason-role model", async () => {
    generateObject.mockResolvedValue({
      object: {
        feedback: "Great use of 喜欢. Fix 是-before-verb today. 加油 (jiāyóu)!",
        actions: [{ type: "queue_drill", drill: "Rewrite 5 sentences removing 是 before verbs." }],
      },
    });
    const { runLessonFeedback } = await import("../lib/lesson");
    const noteJson = JSON.stringify({
      summary: "hobbies", vocabIntroduced: [],
      errors: [{ quote: "你是喜欢", kind: "grammar", correction: "你喜欢" }],
      grammarPoints: ["喜欢 + verb"], couldNotSay: [], homeworkAssigned: "", durationMinutes: 55,
    });
    const res = await runLessonFeedback({
      lessons: [{ id: "L1", date: "2026-07-14", summary: "hobbies", weakSignals: "grammar: 你是喜欢 → 你喜欢", homework: "", vocabCount: 1, noteJson }],
      studyMap: "IC L3", ledger: "known: 我 你", weekFocus: "listening",
    });
    expect(res.feedback).toContain("是-before-verb");
    expect(res.actions[0].type).toBe("queue_drill");
    expect(generateObject.mock.calls[0][0].model.modelId).toBe("deepseek-v4-flash");
    // The full structured note reaches the model (not just the digest).
    expect(generateObject.mock.calls[0][0].prompt).toContain("喜欢 + verb");
  });
});
