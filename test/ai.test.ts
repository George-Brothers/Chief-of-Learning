import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DistilledSchema, DailySchema, WeeklySchema } from "../lib/ai";
import { FULL_ENV } from "./helpers";

const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock("ai", () => ({ generateObject, generateText: vi.fn() }));

describe("DistilledSchema", () => {
  it("accepts a well-formed distilled object", () => {
    const ok = DistilledSchema.safeParse({
      type: "lesson-note",
      summary: "learned 跳舞",
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "to dance" }],
      weakSignals: ["是 before verb"],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown type", () => {
    const bad = DistilledSchema.safeParse({ type: "nope", summary: "", newVocab: [], weakSignals: [] });
    expect(bad.success).toBe(false);
  });
});

describe("DailySchema", () => {
  it("accepts a daily coach result", () => {
    const ok = DailySchema.safeParse({
      todayPostit: "Your 1.5h: CharWB 3-1, write 忙没字 10x.",
      dailyLogEntry: "ONE action: ...",
      newVocab: [],
      ledgerNotes: [],
    });
    expect(ok.success).toBe(true);
  });
});

describe("WeeklySchema", () => {
  it("accepts a weekly review result", () => {
    const ok = WeeklySchema.safeParse({
      weeklyReport: "3 days studied ...",
      weekFocus: "Close the listening gap.",
      gradebookUpdate: "Verdict: on track ...",
      scorecardChecklist: "## Grammar\n[~] A-not-A",
    });
    expect(ok.success).toBe(true);
  });
});

it("COACH_SYSTEM no longer calls the scorecard ground truth", async () => {
  const { COACH_SYSTEM } = await import("../lib/prompts");
  expect(COACH_SYSTEM).not.toMatch(/ground truth/i);
  expect(COACH_SYSTEM).toMatch(/retained/i);
});

it("DAILY_PROMPT teaches how to submit evidence when an assignment repeats", async () => {
  const { DAILY_PROMPT } = await import("../lib/prompts");
  // A repeated assignment must tell the user HOW to close it, not just re-state the task.
  expect(DAILY_PROMPT).toMatch(/repeat/i);
  expect(DAILY_PROMPT).toMatch(/photo/i);
  expect(DAILY_PROMPT).toContain("/lesson");
});

describe("distillEvidence routing", () => {
  const distilled = { type: "check-in", summary: "studied 30m", newVocab: [], weakSignals: [] };

  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    generateObject.mockReset();
    generateObject.mockResolvedValue({ object: distilled });
  });
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("routes a plain-text check-in to DeepSeek with ONLY DEEPSEEK_API_KEY set", async () => {
    const { distillEvidence } = await import("../lib/ai");
    const res = await distillEvidence({ text: "did 30 min of listening today" });
    expect(res.type).toBe("check-in");
    const model = generateObject.mock.calls[0][0].model;
    expect(model.provider).toBe("deepseek.chat");
    expect(model.modelId).toBe("deepseek-v4-flash");
  });

  it("routes an image input to the Gemini vision provider", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g";
    const { distillEvidence } = await import("../lib/ai");
    await distillEvidence({ image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" } });
    const model = generateObject.mock.calls[0][0].model;
    expect(model.provider).toBe("google.generative-ai");
    expect(model.modelId).toBe("gemini-2.5-flash");
  });

  it("falls an image back to the OpenAI vision provider when Google is absent but OpenAI is set", async () => {
    // The handwriting-photo fix: no Google key → the vision role uses openai/gpt-4o-mini instead of throwing.
    process.env.OPENAI_API_KEY = "sk-openai";
    const { distillEvidence } = await import("../lib/ai");
    await distillEvidence({ image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" } });
    const model = generateObject.mock.calls[0][0].model;
    expect(model.provider).toBe("openai.responses");
    expect(model.modelId).toBe("gpt-4o-mini");
  });
});
