import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const distillEvidence = vi.fn();
const addEvidence = vi.fn(async () => "pg1");
const sendMessage = vi.fn(async () => {});
const getFileBytes = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" }));
const makeDeckFromVocab = vi.fn(async () => ({ sent: false, count: 0 }));
const enqueueCards = vi.fn(async () => 0);
const routeCommand = vi.fn(async () => false);
// The shared filing path for text the router declined (intent "log"). It lives in lib/command so the
// dashboard chat gets the same behaviour — see test/log-text-message.test.ts for what it produces and
// test/webchat-log.test.ts for the surface that used to drop these messages entirely.
const logTextMessage = vi.fn(async () => "📝 Got it — did 30m.\n加油 (jiāyóu)!");
const consumePendingListening = vi.fn(async () => false);
const autoCloseAssignmentFromEvidence = vi.fn(async () => undefined as { id: string; kind: string; description: string } | undefined);

vi.mock("@/lib/ai", () => ({ distillEvidence }));
vi.mock("@/lib/notion", () => ({ addEvidence }));
vi.mock("@/lib/telegram", () => ({ sendMessage, getFileBytes }));
vi.mock("@/lib/deck", () => ({ makeDeckFromVocab }));
vi.mock("@/lib/actions", () => ({ enqueueCards }));
vi.mock("@/lib/command", () => ({ routeCommand, logTextMessage, consumePendingListening, autoCloseAssignmentFromEvidence }));
// lib/ack is pure formatting with no dependencies — left REAL so the ack assertions below are about
// what the learner actually reads.

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, {
    TELEGRAM_WEBHOOK_SECRET: "SEK",
    TELEGRAM_ALLOWED_CHAT_ID: "42",
  });
  for (const f of [distillEvidence, addEvidence, sendMessage, getFileBytes, makeDeckFromVocab])
    f.mockClear();
  enqueueCards.mockReset();
  enqueueCards.mockResolvedValue(0);
  makeDeckFromVocab.mockResolvedValue({ sent: false, count: 0 });
  routeCommand.mockReset();
  routeCommand.mockResolvedValue(false);
  logTextMessage.mockReset();
  logTextMessage.mockResolvedValue("📝 Got it — did 30m.\n加油 (jiāyóu)!");
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

  it("hands a text check-in to the SHARED filing path and sends back its ack", async () => {
    // Filing deliberately does not live in this route any more. It used to, and "routeCommand
    // returned false" therefore only meant "file it" on Telegram — the dashboard chat called the same
    // router and answered instead, losing every check-in typed there.
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "did 30 min, tones bad" } }));
    expect(res.status).toBe(200);
    expect(logTextMessage).toHaveBeenCalledWith("did 30 min, tones bad", "42", "telegram");
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toBe("📝 Got it — did 30m.\n加油 (jiāyóu)!");
    expect(distillEvidence).not.toHaveBeenCalled(); // the shared path distils, not this route
  });

  it("names the auto-closed assignment in ONE combined ack, not a second message", async () => {
    // Two notifications for one submission is noise, and the old "Marked done" line didn't name what
    // closed — the learner had to guess. One message, and it says which assignment.
    autoCloseAssignmentFromEvidence.mockResolvedValue({ id: "AS1", kind: "homework", description: "write 写字 20×" });
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, caption: "my homework", photo: [{ file_id: "big" }] } }));
    expect(res.status).toBe(200);
    expect(addEvidence).toHaveBeenCalledOnce();
    expect(autoCloseAssignmentFromEvidence).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    const ack = sendMessage.mock.calls[0][1] as string;
    expect(ack).toMatch(/marked done: write 写字 20×/i); // the closed assignment is named
    expect(ack).toContain("did 30m"); // …alongside what was understood
    expect(ack).toContain("真棒"); // closing earns the bigger cheer, and only once
    expect(ack).not.toContain("加油");
  });

  it("still names a closed assignment alongside the card confirmation, in ONE message", async () => {
    autoCloseAssignmentFromEvidence.mockResolvedValue({ id: "AS1", kind: "homework", description: "write 写字 20×" });
    distillEvidence.mockResolvedValue({
      type: "homework", summary: "wrote 写字", weakSignals: [],
      newVocab: [{ headword: "写字", pinyin: "xiězì", definition: "write characters" }],
    });
    enqueueCards.mockResolvedValue(1);
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, caption: "wrote 写字", photo: [{ file_id: "big" }] } }));
    expect(sendMessage).toHaveBeenCalledOnce();
    const ack = sendMessage.mock.calls.at(-1)![1] as string;
    expect(ack).toMatch(/marked done: write 写字 20×/i);
    expect(ack).toMatch(/1 new word/);
  });

  it("sends tutor/homework photo vocab to Anki and NEVER a Pleco file", async () => {
    // The gap the whole audit turned on: this path only ever produced a Pleco .txt, so the learner's
    // single biggest vocab source — tutor slides and homework photos — never reached Anki at all.
    // The .txt is now gone from this automatic path: "I don't want to get a msg with words to add,
    // I want it to go directly to Anki."
    distillEvidence.mockResolvedValue({
      type: "homework", summary: "tutor slide", weakSignals: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
    });
    enqueueCards.mockResolvedValue(1);
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, caption: "slide", photo: [{ file_id: "big" }] } }));

    expect(enqueueCards).toHaveBeenCalledOnce();
    expect(enqueueCards.mock.calls[0][0]).toEqual([
      { headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" },
    ]);
    expect(enqueueCards.mock.calls[0][1]).toMatch(/^tutor \d{4}-\d{2}-\d{2}$/);
    expect(makeDeckFromVocab).not.toHaveBeenCalled();
  });

  it("confirms queued cards without claiming they are in the deck, and never asks him to import", async () => {
    distillEvidence.mockResolvedValue({
      type: "homework", summary: "tutor slide", weakSignals: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
    });
    enqueueCards.mockResolvedValue(1);
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, caption: "slide", photo: [{ file_id: "big" }] } }));
    const ack = sendMessage.mock.calls.at(-1)![1] as string;
    expect(ack).toMatch(/1 new word/);
    // No heartbeat source is installed, so presence is "unknown" — the ack must not assert delivery.
    expect(ack).toMatch(/queued for Anki/);
    expect(ack).not.toMatch(/added to your Anki deck|now in your Anki deck/i);
    // …and never homework: no file, no list to type in, no Pleco.
    expect(ack).not.toMatch(/import|Pleco|\.txt|add these/i);
  });

  it("says so when the enqueue fails instead of acking as if the words were saved", async () => {
    distillEvidence.mockResolvedValue({
      type: "homework", summary: "tutor slide", weakSignals: [],
      newVocab: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance" }],
    });
    enqueueCards.mockRejectedValue(new Error("notion 502"));
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, caption: "learned 跳舞", photo: [{ file_id: "big" }] } }));
    expect(res.status).toBe(200);
    expect(addEvidence).toHaveBeenCalledOnce(); // evidence survives the queue error
    expect(makeDeckFromVocab).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.at(-1)![1]).toMatch(/couldn't queue/i);
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

  it("files a question the command layer declined as evidence, instead of sniffing for a '?'", async () => {
    // Answering lives in routeCommand (intent "answer") now, and the route's own `isQuestion(text)`
    // branch is gone. So when routeCommand declines, a question mark must NOT divert the message:
    // it goes down the evidence path like any other text. The old route answered it and stored
    // nothing.
    routeCommand.mockResolvedValue(false);
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, text: "了 vs 过?" } }));
    expect(routeCommand).toHaveBeenCalledWith("了 vs 过?", "42");
    // It goes down the evidence path (now the shared one) verbatim — no '?' sniffing, no answering.
    expect(logTextMessage).toHaveBeenCalledWith("了 vs 过?", "42", "telegram");
    expect(sendMessage.mock.calls.at(-1)![1]).toContain("did 30m"); // acked, not answered
  });

  it("still acks when the distilled summary is empty", async () => {
    distillEvidence.mockResolvedValue({ type: "homework", summary: "", newVocab: [], weakSignals: [] });
    const { POST } = await import("@/app/api/telegram/route");
    await POST(post({ message: { chat: { id: 42 }, caption: "here", photo: [{ file_id: "big" }] } }));
    const ack = sendMessage.mock.calls.at(-1)![1] as string;
    expect(ack).not.toBe("Logged.");
    expect(ack).toContain("homework");
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

  it("offers a listening answer to consumePendingListening BEFORE the classifier can claim it", async () => {
    Object.assign(process.env, FULL_ENV, { TELEGRAM_WEBHOOK_SECRET: "SEK", TELEGRAM_ALLOWED_CHAT_ID: "42" });
    // routeCommand returns true for a bare reply now (the classifier is biased toward "answer"), so
    // the old routeCommand-first order made consumePendingListening unreachable. See
    // test/telegram-listening-priority.test.ts for the same guarantee through the real command layer.
    routeCommand.mockResolvedValue(true);
    consumePendingListening.mockResolvedValue(true);
    const { POST } = await import("@/app/api/telegram/route");
    const res = await POST(post({ message: { chat: { id: 42 }, text: "跳舞" } }));
    expect(res.status).toBe(200);
    expect(consumePendingListening).toHaveBeenCalledWith("跳舞", "42");
    expect(routeCommand).not.toHaveBeenCalled();
    expect(distillEvidence).not.toHaveBeenCalled();
  });
});
