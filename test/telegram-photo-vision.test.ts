import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FULL_ENV } from "./helpers";

// Unlike telegram-route.test.ts, this suite exercises the REAL lib/ai + lib/models so the photo path
// runs the actual vision role selection, fallback, and NoProviderError degrade — only the `ai` SDK and
// the IO boundaries are mocked. This is what proves the handwriting-photo fix end to end.
const { generateObject, generateText } = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));
vi.mock("ai", () => ({ generateObject, generateText }));

const addEvidence = vi.fn(async () => "pg1");
const sendMessage = vi.fn(async () => {});
const getFileBytes = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" }));
const makeDeckFromVocab = vi.fn(async () => ({ sent: false, count: 0 }));
const routeCommand = vi.fn(async () => false);
const consumePendingListening = vi.fn(async () => false);
const autoCloseAssignmentFromEvidence = vi.fn(async () => undefined);
const buildQuestionBrain = vi.fn(async () => "brain");

vi.mock("@/lib/notion", () => ({ addEvidence }));
vi.mock("@/lib/telegram", () => ({ sendMessage, getFileBytes }));
vi.mock("@/lib/deck", () => ({ makeDeckFromVocab }));
vi.mock("@/lib/command", () => ({ routeCommand, consumePendingListening, autoCloseAssignmentFromEvidence }));
vi.mock("@/lib/brain", () => ({ buildQuestionBrain }));

const distilled = { type: "srs-screenshot", summary: "reviewed 20 cards", newVocab: [], weakSignals: [] };

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, { TELEGRAM_WEBHOOK_SECRET: "SEK", TELEGRAM_ALLOWED_CHAT_ID: "42" });
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  for (const f of [addEvidence, sendMessage, getFileBytes, makeDeckFromVocab]) f.mockClear();
  generateObject.mockReset();
  generateObject.mockResolvedValue({ object: distilled });
});
afterEach(() => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function photoPost() {
  return new Request("http://x/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "SEK" },
    body: JSON.stringify({ message: { chat: { id: 42 }, caption: "my homework", photo: [{ file_id: "big" }] } }),
  });
}

describe("telegram photo vision path (real ai + models)", () => {
  it("routes a photo to the OpenAI vision fallback when Google is absent but OpenAI is set — logs, no throw", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(photoPost());

    expect(res.status).toBe(200);
    // The model actually handed to the SDK is the OpenAI vision fallback.
    const model = generateObject.mock.calls[0][0].model;
    expect(model.provider).toBe("openai.responses");
    expect(model.modelId).toBe("gpt-4o-mini");
    // Evidence is logged and the user gets the normal ack — no honest-degrade path here.
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toContain("reviewed 20 cards"); // the ack reflects what was read
  });

  it("degrades honestly when NO vision provider is configured — records the attempt, no throw/500", async () => {
    // Neither Google nor OpenAI is set: the vision role has nothing to route to.
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(photoPost());

    expect(res.status).toBe(200);
    // The model is never even constructed — modelsFor throws NoProviderError before any SDK call.
    expect(generateObject).not.toHaveBeenCalled();
    // We still note that an image arrived...
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(addEvidence.mock.calls[0][0].type).toBe("image");
    // ...and tell the user honestly, NOT the generic "Something broke on my end."
    expect(sendMessage).toHaveBeenCalledWith(
      "42",
      "I couldn't read that image — image reading isn't set up right now, but I've noted you sent one.",
    );
  });
});
