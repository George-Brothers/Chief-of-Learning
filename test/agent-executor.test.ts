// §2.1: markActionDone(ok=false) writes status "error", and getQueuedActions() only ever returns
// "queued" rows — so burning a task is PERMANENT. Anki being closed (the normal case on a laptop)
// used to burn it, destroying the cards for good. These tests pin which failures may burn a task.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchTasks = vi.fn();
const completeTask = vi.fn();
const addCards = vi.fn();
const parkCards = vi.fn(async () => "/w/.failed/parked.cards.json");

vi.mock("../agent/poll", () => ({ fetchTasks, completeTask }));
vi.mock("../agent/anki", () => ({ addCards }));
// Burning a row now REQUIRES parking its cards first (see agent-executor-deadletter.test.ts).
vi.mock("../agent/deadletter", () => ({ parkCards }));

const cfg = {
  watchDir: "/w", cloudUrl: "http://cloud", secret: "s",
  ankiUrl: "http://localhost:8765", ankiDeck: "Chinese::Lessons",
  pollMs: 5000, retentionMs: 0, failedDir: "/w/.failed",
};
const CARDS = JSON.stringify({
  cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
});
const task = (payload = CARDS) => [{ id: "A1", type: "create_anki_cards", payload }];

/** How fetch actually rejects when AnkiConnect isn't listening. */
const ankiClosed = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

beforeEach(() => {
  vi.resetModules();
  for (const f of [fetchTasks, completeTask, addCards, parkCards]) f.mockReset();
  parkCards.mockResolvedValue("/w/.failed/parked.cards.json");
});

describe("drainTasks", () => {
  it("completes a task and reports what landed", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockResolvedValue({ added: 1, skipped: 0, failed: [] });
    const { drainTasks } = await import("../agent/executor");

    expect(await drainTasks(cfg)).toEqual([{ id: "A1", status: "done", added: 1, skipped: 0 }]);
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", "added 1, skipped 0", true);
  });

  it("does NOT burn the task when Anki is closed", async () => {
    // The reproduced bug: this used to completeTask(ok=false) → status "error" → never re-fetched.
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValue(ankiClosed());
    const { drainTasks } = await import("../agent/executor");

    expect(await drainTasks(cfg)).toEqual([{ id: "A1", status: "deferred", error: "fetch failed" }]);
    expect(parkCards).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled(); // the row stays "queued" — that IS the retry
  });

  it("creates the cards on a later drain once Anki is reopened", async () => {
    // End-to-end of the repro's timeline: closed at tick 1, reopened at tick 2, cards must land.
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValueOnce(ankiClosed()).mockResolvedValueOnce({ added: 1, skipped: 0, failed: [] });
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("deferred");
    expect((await drainTasks(cfg))[0]).toEqual({ id: "A1", status: "done", added: 1, skipped: 0 });
    expect(completeTask).toHaveBeenCalledOnce();
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", "added 1, skipped 0", true);
  });

  it("does NOT burn a completed task when only the success report fails", async () => {
    // Cards landed, but the done-report throws (Vercel 5xx mid-redeploy). Burning here — or firing a
    // false failure — would destroy a task whose cards are already in Anki. Leave it queued to re-report.
    fetchTasks.mockResolvedValue(task());
    addCards.mockResolvedValue({ added: 1, skipped: 0, failed: [] });
    completeTask.mockRejectedValueOnce(new Error("completeTask failed: 503 redeploying"));
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("deferred");
    // The only completeTask call was the success report — never a burn (ok=false).
    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", "added 1, skipped 0", true);
  });

  it("re-reports on a later drain once the cloud is back (cards are idempotent)", async () => {
    fetchTasks.mockResolvedValue(task());
    addCards.mockResolvedValue({ added: 0, skipped: 1, failed: [] }); // findNotes dedup: nothing re-added
    completeTask.mockRejectedValueOnce(new Error("completeTask failed: 503")).mockResolvedValueOnce(undefined);
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("deferred");
    expect((await drainTasks(cfg))[0]).toEqual({ id: "A1", status: "done", added: 0, skipped: 1 });
  });

  it("burns a task Anki will never accept", async () => {
    // A rejected payload fails identically forever; retrying it would just spin.
    fetchTasks.mockResolvedValue(task());
    addCards.mockRejectedValue(new Error("anki addNote error: model 'Basic' not found"));
    const { drainTasks } = await import("../agent/executor");

    const [r] = await drainTasks(cfg);
    expect(r.status).toBe("burned");
    expect(parkCards).toHaveBeenCalledOnce(); // never burned without a disk copy
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", expect.stringContaining("not found"), false);
  });

  it("burns a malformed payload rather than retrying it forever", async () => {
    fetchTasks.mockResolvedValue(task("{ not json"));
    const { drainTasks } = await import("../agent/executor");

    expect((await drainTasks(cfg))[0].status).toBe("burned");
    expect(completeTask).toHaveBeenCalledWith(cfg, "A1", expect.any(String), false);
  });

  it("leaves task types it doesn't own alone", async () => {
    fetchTasks.mockResolvedValue([{ id: "A2", type: "assign_reading", payload: "{}" }]);
    const { drainTasks } = await import("../agent/executor");

    expect(await drainTasks(cfg)).toEqual([{ id: "A2", status: "ignored" }]);
    expect(completeTask).not.toHaveBeenCalled();
    expect(addCards).not.toHaveBeenCalled();
  });
});

describe("isTransient", () => {
  it("treats a laptop with Anki closed as transient", async () => {
    const { isTransient } = await import("../agent/executor");
    expect(isTransient(ankiClosed())).toBe(true);
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { cause: { code: "ETIMEDOUT" } }))).toBe(true);
    expect(isTransient(new Error("anki addNote failed: 503 upstream"))).toBe(true);
  });

  it("treats a rejected payload as permanent", async () => {
    const { isTransient } = await import("../agent/executor");
    expect(isTransient(new Error("anki addNote error: cannot create note because it is a duplicate")))
      .toBe(false);
  });

  it("treats a malformed RESPONSE from the Anki port as transient, not as a rejected payload", async () => {
    // See test/agent-nonjson-response.test.ts: a service answering 200 + text/html raises a
    // SyntaxError out of the response parse. Burning on that destroyed a whole batch on attempt 1.
    const { isTransient } = await import("../agent/executor");
    expect(isTransient(new SyntaxError("Unexpected token n in JSON at position 2"))).toBe(true);
  });

  it("treats an unexplained failure as transient — the fail-safe default", async () => {
    const { isTransient } = await import("../agent/executor");
    // The live bug: something else on the AnkiConnect port answering 404. This used to be
    // "permanent" and destroyed the queue in a single poll cycle.
    expect(isTransient(new Error("anki findNotes failed: 404 "))).toBe(true);
    expect(isTransient(new Error("anki addNote failed: 401 unauthorized"))).toBe(true);
  });
});
