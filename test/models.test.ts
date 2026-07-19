import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { modelsFor, slugFor, MODEL_DEFAULTS, FALLBACK, type Role } from "../lib/models";
import { FULL_ENV } from "./helpers";

// FULL_ENV carries DEEPSEEK_API_KEY (required) but NOT the optional Google key — i.e. the captain's
// current "DeepSeek only" state. Each test opts the Google key in when it wants the Gemini path.
const DEEPSEEK = "deepseek.chat";
const GOOGLE = "google.generative-ai";
const OPENAI = "openai.responses";

function providers(role: Role): string[] {
  return modelsFor(role).map((m) => m.provider);
}
function modelIds(role: Role): string[] {
  return modelsFor(role).map((m) => m.modelId);
}

describe("model routing", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    for (const k of ["MODEL_CHAT", "MODEL_REASON", "MODEL_CLASSIFY", "MODEL_LONG", "MODEL_VISION"]) delete process.env[k];
  });
  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("routes chat/reason/classify to direct DeepSeek with only DEEPSEEK_API_KEY set", () => {
    for (const role of ["chat", "reason", "classify"] as Role[]) {
      expect(providers(role)[0], role).toBe(DEEPSEEK);
      expect(modelIds(role)[0], role).toBe("deepseek-v4-flash");
    }
  });

  it("does NOT require the Google key for the DeepSeek chat path", () => {
    // No GOOGLE key: chat still resolves (its google fallback is simply skipped, not an error).
    expect(() => modelsFor("chat")).not.toThrow();
    expect(providers("chat")).toEqual([DEEPSEEK]); // google fallback dropped, deepseek-only
  });

  it("falls the long role back to DeepSeek when the Google key is absent (fail closed, still works)", () => {
    // long primary is Gemini, but with no Google key it degrades to its DeepSeek fallback.
    expect(providers("long")).toEqual([DEEPSEEK]);
    expect(modelIds("long")).toEqual(["deepseek-v4-flash"]);
  });

  it("leaves the vision role unavailable when NEITHER Google nor OpenAI is configured", () => {
    // FULL_ENV carries no Google key and no OPENAI_API_KEY → nothing multimodal is wired.
    delete process.env.OPENAI_API_KEY;
    expect(() => modelsFor("vision")).toThrow(/No AI provider configured for role "vision"/);
  });

  it("falls the vision role back to OpenAI when Google is absent but OPENAI_API_KEY is set", () => {
    // The handwriting-photo fix: no Google key, but OpenAI's (already used for embeddings) rescues vision.
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(providers("vision")).toEqual([OPENAI]);
    expect(modelIds("vision")).toEqual(["gpt-4o-mini"]);
  });

  it("uses the direct Google provider for long/vision once the Google key is present", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g";
    delete process.env.OPENAI_API_KEY;
    expect(providers("vision")).toEqual([GOOGLE]);
    expect(modelIds("vision")).toEqual(["gemini-2.5-flash"]);
    // long is Gemini primary, DeepSeek fallback — in order.
    expect(providers("long")).toEqual([GOOGLE, DEEPSEEK]);
  });

  it("orders vision as Gemini primary then the OpenAI fallback when both keys are set", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g";
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(providers("vision")).toEqual([GOOGLE, OPENAI]);
    expect(modelIds("vision")).toEqual(["gemini-2.5-flash", "gpt-4o-mini"]);
  });

  it("orders each text role as primary then cross-provider fallback when both keys are set", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "g";
    expect(providers("chat")).toEqual([DEEPSEEK, GOOGLE]);
    expect(providers("reason")).toEqual([DEEPSEEK, GOOGLE]);
  });

  it("honors the MODEL_* env override, keeping the direct-provider construction", () => {
    process.env.MODEL_CHAT = "deepseek/deepseek-v4-pro";
    expect(slugFor("chat")).toBe("deepseek/deepseek-v4-pro");
    expect(modelIds("chat")[0]).toBe("deepseek-v4-pro");
    expect(providers("chat")[0]).toBe(DEEPSEEK);
  });

  it("keeps the vision model overridable via MODEL_VISION (e.g. to pin the exact OpenAI id)", () => {
    // firstmate confirms the live OpenAI vision id before merge — swapping it is an env change, not code.
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.MODEL_VISION = "openai/gpt-4o";
    expect(slugFor("vision")).toBe("openai/gpt-4o");
    expect(providers("vision")[0]).toBe(OPENAI);
    expect(modelIds("vision")[0]).toBe("gpt-4o");
  });

  it("rejects an override with an unknown provider prefix", () => {
    process.env.MODEL_CHAT = "anthropic/claude";
    expect(() => modelsFor("chat")).toThrow(/Invalid model slug/);
  });

  it("keeps the defaults + fallbacks as provider/model-id slugs", () => {
    for (const slug of [...Object.values(MODEL_DEFAULTS), ...Object.values(FALLBACK).flat()]) {
      expect(slug).toMatch(/^(deepseek|google|openai)\/.+/);
    }
  });
});
