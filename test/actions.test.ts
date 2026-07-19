import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const enqueueAction = vi.fn();
const appendLedgerNotes = vi.fn();
const addAssignment = vi.fn();
const getCardedWords = vi.fn(async () => [] as string[]);
const sendMessage = vi.fn();
vi.mock("../lib/notion", () => ({ enqueueAction, appendLedgerNotes, addAssignment, getCardedWords }));
vi.mock("../lib/telegram", () => ({ sendMessage }));

describe("dispatchActions", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    for (const f of [enqueueAction, appendLedgerNotes, addAssignment, sendMessage, getCardedWords]) f.mockReset();
    getCardedWords.mockResolvedValue([]);
  });

  it("queues cards, messages reading, and ledgers a drill", async () => {
    const { dispatchActions } = await import("../lib/actions");
    await dispatchActions(
      [
        { type: "create_anki_cards", cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }] },
        { type: "assign_reading", topic: "hobbies", level: "HSK1" },
        { type: "queue_drill", drill: "Drill 是-before-verb: rewrite 5 sentences." },
      ],
      "42",
    );
    expect(enqueueAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "create_anki_cards" }),
    );
    expect(sendMessage.mock.calls[0][1]).toContain("hobbies");
    // Reading is recorded durably AND the drill is queued (order-independent).
    const ledgered = appendLedgerNotes.mock.calls.map((c) => c[0] as string).join("\n");
    expect(ledgered).toContain("hobbies");
    expect(ledgered).toContain("是-before-verb");
  });

  it("assign_reading also opens an assignment", async () => {
    const { dispatchActions } = await import("../lib/actions");
    await dispatchActions([{ type: "assign_reading", topic: "hobbies", level: "HSK1" }], "42");
    expect(addAssignment).toHaveBeenCalledWith(expect.objectContaining({ kind: "reading" }));
  });
});
