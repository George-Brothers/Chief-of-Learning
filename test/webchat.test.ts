import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const routeCommand = vi.fn();
// Questions are answered INSIDE routeCommand (intents "answer"/"answer_log"); the only thing it
// declines is intent "log", which must be filed — see test/webchat-log.test.ts for that end to end.
const logTextMessage = vi.fn(async () => "📝 Got it — did 30 min of tone drills.\n加油 (jiāyóu)!");
vi.mock("../lib/command", () => ({ routeCommand, logTextMessage }));

describe("respondToMessage (web chat = same brain as Telegram)", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV, { TELEGRAM_ALLOWED_CHAT_ID: "42" });
    routeCommand.mockReset();
    logTextMessage.mockReset();
    logTextMessage.mockResolvedValue("📝 Got it — did 30 min of tone drills.\n加油 (jiāyóu)!");
  });

  it("routes commands through routeCommand and returns the collected reply", async () => {
    routeCommand.mockImplementation(async (_msg: string, _chatId: string, reply: (t: string) => Promise<void>) => {
      await reply("On it — making Lesson 5 cards 💪");
      return true;
    });
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("/cards lesson 5");
    expect(out.handledAs).toBe("command");
    expect(out.reply).toContain("Lesson 5");
    expect(routeCommand).toHaveBeenCalledWith("/cards lesson 5", "42", expect.any(Function));
    expect(logTextMessage).not.toHaveBeenCalled();
  });

  it("answers a question through routeCommand, which owns the 'answer' intent", async () => {
    routeCommand.mockImplementation(async (_m: string, _c: string, reply: (t: string) => Promise<void>) => {
      await reply("了 marks completed action.");
      return true;
    });
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("what does 了 do?");
    expect(out.handledAs).toBe("command");
    expect(out.reply).toContain("了");
    expect(logTextMessage).not.toHaveBeenCalled();
  });

  it("FILES what the router declines instead of answering it — dashboard study is not lost", async () => {
    // The bug: routeCommand returns false only for intent "log", and this adapter used to fall through
    // to a Q&A answer. No distil, no evidence row, no cards — reported study vanished.
    routeCommand.mockResolvedValue(false);
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("did 30 min of tone drills");
    expect(out.handledAs).toBe("log");
    expect(logTextMessage).toHaveBeenCalledWith("did 30 min of tone drills", "42", "web");
    expect(out.reply).toContain("30 min of tone drills");
  });

  it("still replies, and never claims it filed, when the evidence write throws", async () => {
    routeCommand.mockResolvedValue(false);
    logTextMessage.mockRejectedValue(new Error("notion 503"));
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("did 30 min of tone drills");
    expect(out.reply).toMatch(/couldn't save/i);
    expect(out.reply).not.toMatch(/Got it/);
  });

  it("short-circuits empty input without touching the brain", async () => {
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("    ");
    expect(out.handledAs).toBe("answer");
    expect(out.reply).toMatch(/加油/);
    expect(routeCommand).not.toHaveBeenCalled();
    expect(logTextMessage).not.toHaveBeenCalled();
  });

  it("gives a default ack when a command produced no text", async () => {
    routeCommand.mockResolvedValue(true); // handled, but wrote nothing
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("/status");
    expect(out.handledAs).toBe("command");
    expect(out.reply).toMatch(/加油/);
  });
});
