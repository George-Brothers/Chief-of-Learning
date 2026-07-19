import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const distillEvidence = vi.fn();
const answerQuestion = vi.fn(async () => "了 marks completed action.");
const addEvidence = vi.fn(async () => "pg1");
const readStudyMap = vi.fn(async () => "map");
const readLedger = vi.fn(async () => "ledger");
const sendMessage = vi.fn(async () => {});
const getFileBytes = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" }));
const makeDeckFromVocab = vi.fn(async () => ({ sent: false, count: 0 }));
const routeCommand = vi.fn(async () => false);
const consumePendingListening = vi.fn(async () => false);
const autoCloseAssignmentFromEvidence = vi.fn(async () => undefined as { id: string; kind: string; description: string } | undefined);

vi.mock("@/lib/ai", () => ({ distillEvidence, answerQuestion }));
vi.mock("@/lib/notion", () => ({ addEvidence, readStudyMap, readLedger }));
vi.mock("@/lib/telegram", () => ({ sendMessage, getFileBytes }));
vi.mock("@/lib/deck", () => ({ makeDeckFromVocab }));
vi.mock("@/lib/command", () => ({ routeCommand, consumePendingListening, autoCloseAssignmentFromEvidence }));

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, {
    TELEGRAM_WEBHOOK_SECRET: "SEK",
    TELEGRAM_ALLOWED_CHAT_ID: "42",
  });
  for (const f of [distillEvidence, answerQuestion, addEvidence, sendMessage, getFileBytes, makeDeckFromVocab])
    f.mockClear();
  routeCommand.mockReset();
  routeCommand.mockResolvedValue(false);
  consumePendingListening.mockReset();
  consumePendingListening.mockResolvedValue(false);
  autoCloseAssignmentFromEvidence.mockReset();
  autoCloseAssignmentFromEvidence.mockResolvedValue(undefined);
  distillEvidence.mockResolvedValue({
    type: "check-in",
    summary: "did 30m",
    newVocab: [],
    weakSignals: [],
  });
});

function post(body: unknown, secret = "SEK") {
  return new Request("http://x/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });
}

describe("telegram webhook", () => {
  it("runs long enough for the per-message model calls (maxDuration set like the other AI routes)", async () => {
    // Every message triggers >=2 sequential model calls (classify + distill/answer). The route MUST
    // raise its function timeout like the other AI routes (chat=60, daily-brief/ingest=120); without
    // it a short platform default kills the function before sendMessage and the bot is silent to
    // EVERY message. Regression guard for that "no reply to anything" outage.
    const mod = await import("@/app/api/telegram/route");
    expect(typeof mod.maxDuration).toBe("number");
    expect(mod.maxDuration as number).toBeGreaterThanOrEqual(60);
  });

  it("rejects a bad secret with 401", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({}, "WRONG"));
    expect(res.status).toBe(401);
  });

  it("logs a diagnosable reason when the secret_token header is missing (webhook set without secret_token)", async () => {
    // The #1 real-world cause of "the bot ignores every message": setWebhook was run without
    // &secret_token, so Telegram sends NO x-telegram-bot-api-secret-token header and the gate drops
    // every update. It must not be silent — the operator needs a signal in the Vercel logs.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("@/app/api/telegram/route");
    const req = new Request("http://x/api/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" }, // no secret header at all
      body: JSON.stringify({ message: { chat: { id: 42 }, text: "hi" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/secret_token/i);
    warn.mockRestore();
  });

  it("acks a plain greeting (the fall-through reply path never leaves a message unanswered)", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "hey" } }));
    expect(res.status).toBe(200);
    // "hey" is not a command, listening answer, or question — it falls through to the evidence path
    // and must still produce a reply. Silence here is the outage this task fixed.
    expect(sendMessage).toHaveBeenCalled();
  });

  it("ignores messages from other chat ids", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 999 }, text: "hi" } }));
    expect(addEvidence).not.toHaveBeenCalled();
  });

  it("stores a text check-in and acks", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "did 30 min, tones bad" } }));
    expect(res.status).toBe(200);
    expect(distillEvidence).toHaveBeenCalledOnce();
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("acks an auto-closed assignment when evidence matches one", async () => {
    autoCloseAssignmentFromEvidence.mockResolvedValue({ id: "AS1", kind: "homework", description: "write 写字 20×" });
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, caption: "my homework", photo: [{ file_id: "big" }] } }));
    expect(res.status).toBe(200);
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(autoCloseAssignmentFromEvidence).toHaveBeenCalledOnce();
    // The close is acked as its own high-signal line before the generic ack.
    expect(sendMessage.mock.calls.some((c) => /marked done.*写字/i.test(c[1]))).toBe(true);
  });

  it("distills a photo from downloaded bytes and never leaks the token URL", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(
      post({ message: { chat: { id: 42 }, caption: "my homework", photo: [{ file_id: "small" }, { file_id: "big" }] } }),
    );
    expect(res.status).toBe(200);
    // Bytes are fetched server-side (largest photo), not a tokenized URL.
    expect(getFileBytes).toHaveBeenCalledWith("big");
    const arg = distillEvidence.mock.calls[0][0];
    expect(arg.image.data).toBeInstanceOf(Uint8Array);
    expect(arg.image.mediaType).toBe("image/jpeg");
    expect(arg).not.toHaveProperty("imageUrl");
    // The token-bearing URL is never persisted to Notion either.
    expect(addEvidence.mock.calls[0][0]).not.toHaveProperty("imageUrl");
  });

  it("logs an image document (uncompressed photo) through the same evidence path", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(
      post({ message: { chat: { id: 42 }, caption: "my homework", document: { file_id: "doc1", mime_type: "image/png" } } }),
    );
    expect(res.status).toBe(200);
    expect(getFileBytes).toHaveBeenCalledWith("doc1");
    const arg = distillEvidence.mock.calls[0][0];
    expect(arg.image.data).toBeInstanceOf(Uint8Array);
    expect(addEvidence).toHaveBeenCalledOnce();
  });

  it("replies honestly and never crashes on a non-image document", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(
      post({ message: { chat: { id: 42 }, document: { file_id: "doc2", mime_type: "application/pdf", file_name: "hw.pdf" } } }),
    );
    expect(res.status).toBe(200);
    expect(getFileBytes).not.toHaveBeenCalled();
    expect(distillEvidence).not.toHaveBeenCalled();
    expect(addEvidence).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatch(/can't read that file type/i);
  });

  it("answers a question without storing evidence", async () => {
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, text: "了 vs 过?" } }));
    expect(answerQuestion).toHaveBeenCalledOnce();
    expect(addEvidence).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("42", "了 marks completed action.");
  });

  it("routes a command through routeCommand and skips evidence handling", async () => {
    Object.assign(process.env, FULL_ENV, { TELEGRAM_WEBHOOK_SECRET: "SEK", TELEGRAM_ALLOWED_CHAT_ID: "42" });
    routeCommand.mockResolvedValue(true);
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "/status" } }));
    expect(res.status).toBe(200);
    expect(routeCommand).toHaveBeenCalledWith("/status", "42");
    expect(distillEvidence).not.toHaveBeenCalled(); // command short-circuits the evidence path
  });

  it("routes a listening answer through consumePendingListening", async () => {
    Object.assign(process.env, FULL_ENV, { TELEGRAM_WEBHOOK_SECRET: "SEK", TELEGRAM_ALLOWED_CHAT_ID: "42" });
    routeCommand.mockResolvedValue(false);
    consumePendingListening.mockResolvedValue(true);
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "跳舞" } }));
    expect(res.status).toBe(200);
    expect(consumePendingListening).toHaveBeenCalledWith("跳舞", "42");
    expect(distillEvidence).not.toHaveBeenCalled();
  });
});
