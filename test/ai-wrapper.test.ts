import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { FULL_ENV } from "./helpers";

// Mock only the AI SDK's generate* calls; lib/models.ts still constructs REAL (offline) provider
// model instances, so we can assert which provider each attempt hit via `model.provider`.
const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("ai", () => ({ generateObject, generateText }));

const Schema = z.object({ ok: z.boolean() });

describe("runObject / runText wrapper: retry + provider fallback", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g"; // both providers wired → chat = [deepseek, google]
    generateObject.mockReset();
    generateText.mockReset();
  });
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  it("retries the same model on a transient error before giving up on it", async () => {
    generateObject.mockRejectedValueOnce(new Error("transient")).mockResolvedValue({ object: { ok: true } });
    const { runObject } = await import("../lib/ai");
    const out = await runObject("reason", "feat", { schema: Schema, prompt: "x" });
    expect(out.ok).toBe(true);
    // Two attempts, both on the primary DeepSeek model — the retry never needed the fallback.
    expect(generateObject.mock.calls.length).toBe(2);
    expect(generateObject.mock.calls.every((c) => c[0].model.provider === "deepseek.chat")).toBe(true);
  });

  it("falls over to the next provider after the primary exhausts its retries", async () => {
    generateObject.mockImplementation(async ({ model }: { model: { provider: string } }) => {
      if (model.provider === "deepseek.chat") throw new Error("deepseek down");
      return { object: { ok: true } };
    });
    const { runObject } = await import("../lib/ai");
    const out = await runObject("chat", "feat", { schema: Schema, prompt: "x" });
    expect(out.ok).toBe(true);
    const providers = generateObject.mock.calls.map((c) => c[0].model.provider);
    // DeepSeek tried twice (retry), then Google succeeded.
    expect(providers).toEqual(["deepseek.chat", "deepseek.chat", "google.generative-ai"]);
  });

  it("throws the last error when every provider for the role fails", async () => {
    generateObject.mockRejectedValue(new Error("all down"));
    const { runObject } = await import("../lib/ai");
    await expect(runObject("chat", "feat", { schema: Schema, prompt: "x" })).rejects.toThrow("all down");
    // 2 retries × 2 providers (deepseek + google fallback).
    expect(generateObject.mock.calls.length).toBe(4);
  });

  it("runText routes through the same wrapper", async () => {
    generateText.mockResolvedValue({ text: "hi" });
    const { runText } = await import("../lib/ai");
    const out = await runText("chat", "feat", { prompt: "x" });
    expect(out).toBe("hi");
    expect(generateText.mock.calls[0][0].model.provider).toBe("deepseek.chat");
  });
});
