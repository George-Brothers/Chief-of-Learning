// Before this, ANY non-5xx failure was classified permanent: completeTask(ok=false) wrote Status
// "error", getQueuedActions only ever returns "queued", and the cards were destroyed silently. With
// AnkiConnect answering 404 (wrong port), one poll cycle would have annihilated a whole backlog.
// The rule now: retry unless provably permanent, bound the attempts for anything unexplained, and
// never burn a row without first parking its cards on disk.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchTasks = vi.fn();
const completeTask = vi.fn();
const addCards = vi.fn();
const parkCards = vi.fn(async () => "/w/.failed/2026-07-19-A1.cards.json");

vi.mock("../agent/poll", () => ({ fetchTasks, completeTask }));
vi.mock("../agent/anki", () => ({ addCards }));
vi.mock("../agent/deadletter", () => ({ parkCards }));

const cfg = {
  watchDir: "/w", cloudUrl: "http://cloud", secret: "s",
  ankiUrl: "http://localhost:8766", ankiDeck: "Chinese::Lucy",
  pollMs: 5000, retentionMs: 0, failedDir: "/w/.failed",
};
const CARD = { headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" };
const payload = JSON.stringify({ cards: [CARD], label: "tutor 2026-07-19" });
const task = (p = payload) => [{ id: "A1", type: "create_anki_cards", payload: p }];

const wrongPort = () => new Error("anki findNotes failed: 404 ");
const ankiClosed = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

beforeEach(() => {
  vi.resetModules();
  for (const f of [fetchTasks, completeTask, addCards, parkCards]) f.mockReset();
  parkCards.mockResolvedValue("/w/.failed/2026-07-19-A1.cards.json");
});

describe("drainTasks — a 404 on the Anki port must not destroy cards", () => {
  it("defers instead of burning on the first unexplained failure", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValue(wrongPort());
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("deferred");
    expect(completeTask).not.toHaveBeenCalled(); // the row stays "queued"
    expect(parkCards).not.toHaveBeenCalled();
  });

  it("gives up only after a bounded number of attempts, and parks the cards first", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValue(wrongPort());
    const { drainTasks, MAX_ATTEMPTS } = await import("../agent/executor");

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect((await drainTasks(cfg))[0].status).toBe("deferred");
    }
    const last = (await drainTasks(cfg))[0];
    expect(last.status).toBe("dead-lettered");
    // Parked BEFORE the row is burned — that ordering is the whole point.
    expect(parkCards).toHaveBeenCalledOnce();
    expect(parkCards.mock.calls[0][1]).toMatchObject({ taskId: "A1", cards: [CARD] });
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", expect.stringContaining(".cards.json"), false);
  });

  it("never spends the attempt budget while Anki is simply closed", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValue(ankiClosed());
    const { drainTasks, MAX_ATTEMPTS } = await import("../agent/executor");

    for (let i = 0; i < MAX_ATTEMPTS * 3; i++) {
      expect((await drainTasks(cfg))[0].status).toBe("deferred");
    }
    expect(completeTask).not.toHaveBeenCalled();
    expect(parkCards).not.toHaveBeenCalled();
  });

  it("forgets the attempt count once the task succeeds", async () => {
    fetchTasks.mockResolvedValue(task());
    const { drainTasks, MAX_ATTEMPTS } = await import("../agent/executor");

    addCards.mockRejectedValueOnce(wrongPort());
    expect((await drainTasks(cfg))[0].status).toBe("deferred");
    addCards.mockResolvedValueOnce({ added: 1, skipped: 0, failed: [] });
    expect((await drainTasks(cfg))[0].status).toBe("done");

    // A later unrelated hiccup starts from a fresh budget rather than an inherited one.
    addCards.mockRejectedValue(wrongPort());
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect((await drainTasks(cfg))[0].status).toBe("deferred");
    }
    expect((await drainTasks(cfg))[0].status).toBe("dead-lettered");
  });

  it("parks the cards before burning a payload Anki will never accept", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValue(new Error("anki addNote error: model was not found: Basic"));
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("burned");
    expect(parkCards).toHaveBeenCalledOnce();
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", expect.stringContaining("model was not found"), false);
  });

  it("parks the raw payload when it cannot even be parsed", async () => {
    fetchTasks.mockResolvedValue(task("{ not json"));
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("burned");
    expect(parkCards.mock.calls[0][1]).toMatchObject({ rawPayload: "{ not json" });
  });
});

describe("drainTasks — partial batches", () => {
  it("reports partial success honestly and parks only the notes that failed", async () => {
    const bad = { headword: "", pinyin: "", definition: "", example: "" };
    fetchTasks.mockResolvedValue(task());
    addCards.mockResolvedValue({
      added: 2, skipped: 1, failed: [{ card: bad, error: "cannot create note because it is empty" }],
    });
    const { drainTasks } = await import("../agent/executor");

    const [r] = await drainTasks(cfg);
    expect(r.status).toBe("partial");
    expect(parkCards.mock.calls[0][1]).toMatchObject({ cards: [bad] });
    const [, , result, ok] = completeTask.mock.calls[0];
    expect(result).toMatch(/added 2, skipped 1, failed 1/);
    expect(ok).toBe(false); // the learner is told the truth, not "✅ done"
  });

  it("passes the payload label to addCards so it lands as an Anki tag", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockResolvedValue({ added: 1, skipped: 0, failed: [] });
    const { drainTasks } = await import("../agent/executor");
    await drainTasks(cfg);
    expect(addCards).toHaveBeenCalledWith(cfg.ankiUrl, cfg.ankiDeck, [CARD], "tutor 2026-07-19");
  });
});
