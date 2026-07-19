import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const routeCommand = vi.fn();
vi.mock("../lib/command", () => ({ routeCommand }));

const answerQuestion = vi.fn(async () => "了 marks completed action.");
vi.mock("../lib/ai", () => ({ answerQuestion }));

const readStudyMap = vi.fn(async () => "IC Lesson 4");
const readLedger = vi.fn(async () => "knows 我 你");
vi.mock("../lib/notion", () => ({ readStudyMap, readLedger }));

describe("respondToMessage (web chat = same brain as Telegram)", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV, { TELEGRAM_ALLOWED_CHAT_ID: "42" });
    routeCommand.mockReset();
    answerQuestion.mockClear();
    readStudyMap.mockClear();
    readLedger.mockClear();
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
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("falls back to answerQuestion for non-commands, against the live brain", async () => {
    routeCommand.mockResolvedValue(false);
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("what does 了 do?");
    expect(out.handledAs).toBe("answer");
    expect(out.reply).toContain("了");
    expect(answerQuestion).toHaveBeenCalledOnce();
    // brain context is assembled from Study Map + Ledger, like the Telegram question path.
    const brainArg = answerQuestion.mock.calls[0][1];
    expect(brainArg).toContain("IC Lesson 4");
    expect(brainArg).toContain("knows 我 你");
  });

  it("short-circuits empty input without touching the brain", async () => {
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("    ");
    expect(out.handledAs).toBe("answer");
    expect(out.reply).toMatch(/加油/);
    expect(routeCommand).not.toHaveBeenCalled();
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("gives a default ack when a command produced no text", async () => {
    routeCommand.mockResolvedValue(true); // handled, but wrote nothing
    const { respondToMessage } = await import("../lib/webchat");
    const out = await respondToMessage("/status");
    expect(out.handledAs).toBe("command");
    expect(out.reply).toMatch(/加油/);
  });
});
