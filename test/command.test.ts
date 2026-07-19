import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText }));

describe("command primitives", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    generateObject.mockReset();
    generateText.mockReset();
  });

  it("classifyCommand tags intent with the classify-role model", async () => {
    generateObject.mockResolvedValue({ object: { intent: "make_cards", request: "lesson 5" } });
    const { classifyCommand } = await import("../lib/command");
    const out = await classifyCommand("make lesson 5 flashcards");
    expect(out.intent).toBe("make_cards");
    expect(out.request).toBe("lesson 5");
    // The classify role routes to the direct DeepSeek provider (a constructed model instance now,
    // not a gateway slug string).
    const model = generateObject.mock.calls[0][0].model;
    expect(model.provider).toBe("deepseek.chat");
    expect(model.modelId).toBe("deepseek-v4-flash");
  });

  it("buildCardsForRequest returns source, label, cards via the reason-role model", async () => {
    generateObject.mockResolvedValue({ object: {
      source: "IC Lesson 5 syllabus", label: "Lesson 5",
      cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "to dance", example: "我喜欢跳舞。" }],
    } });
    const { buildCardsForRequest } = await import("../lib/command");
    const out = await buildCardsForRequest("lesson 5", { syllabus: "IC L5: 跳舞", lessons: "", known: ["我"] });
    expect(out.label).toBe("Lesson 5");
    expect(out.cards[0].headword).toBe("跳舞");
    expect(generateObject.mock.calls[0][0].model.modelId).toBe("deepseek-v4-flash");
    // Request + known words reach the prompt.
    expect(generateObject.mock.calls[0][0].prompt).toContain("lesson 5");
  });

  it("composeStatus returns synthesized text", async () => {
    generateText.mockResolvedValue({ text: "HSK1 62% · behind pace. 加油 (jiāyóu)!" });
    const { composeStatus } = await import("../lib/command");
    const out = await composeStatus({ computedBlock: "HSK1: 62%", gradebook: "g", studyMap: "IC L4", weekFocus: "listening" });
    expect(out).toContain("加油");
    expect(generateText.mock.calls[0][0].prompt).toContain("IC L4");
  });
});
