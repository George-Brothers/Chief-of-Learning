// A non-JSON RESPONSE from whatever is answering the AnkiConnect port is a TRANSPORT failure, not a
// rejected payload. It used to be classified permanent (agent/failure.ts keyed on `err.name ===
// "SyntaxError"`, which `await r.json()` throws), so the very first reply of "200 + text/html" from
// the service squatting on the old port burned the queue row and quarantined the batch on attempt 1
// with zero retries — the exact destroy-cards-silently failure this branch exists to remove.
//
// The genuinely permanent JSON failure — a task PAYLOAD we ourselves stored that isn't JSON — is
// handled at its own call site in agent/executor.ts and is unaffected.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchTasks = vi.fn();
const completeTask = vi.fn();
const parkCards = vi.fn(async () => "/w/.failed/parked.cards.json");

vi.mock("../agent/poll", () => ({ fetchTasks, completeTask }));
vi.mock("../agent/deadletter", () => ({ parkCards }));
// agent/anki is REAL here on purpose: the bug lives in the response parse inside ankiInvoke.

const cfg = {
  watchDir: "/w", cloudUrl: "http://cloud", secret: "s",
  ankiUrl: "http://localhost:8765", ankiDeck: "Chinese::Lessons",
  pollMs: 5000, retentionMs: 0, failedDir: "/w/.failed",
};
const CARDS = JSON.stringify({
  cards: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
});
const task = () => [{ id: "A1", type: "create_anki_cards", payload: CARDS }];

/** Something that is not AnkiConnect answering the port: 200, but an HTML page. */
const htmlServer = () =>
  vi.fn(async () =>
    new Response("<!doctype html><html><body>hello from the wrong service</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  );

beforeEach(() => {
  vi.resetModules();
  for (const f of [fetchTasks, completeTask, parkCards]) f.mockReset();
  parkCards.mockResolvedValue("/w/.failed/parked.cards.json");
  fetchTasks.mockResolvedValue(task());
});

describe("a server answering the Anki port with 200 + text/html", () => {
  it("is retried, NOT burned on the first attempt", async () => {
    vi.stubGlobal("fetch", htmlServer());
    const { drainTasks } = await import("../agent/executor");

    const out = await drainTasks(cfg);
    expect(out[0].status).toBe("deferred");
    expect(completeTask).not.toHaveBeenCalled(); // the row stays "queued" — that IS the retry
    expect(parkCards).not.toHaveBeenCalled();
  });

  it("keeps retrying up to the attempt budget, then dead-letters (never a silent burn)", async () => {
    vi.stubGlobal("fetch", htmlServer());
    const { drainTasks, MAX_ATTEMPTS } = await import("../agent/executor");

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect((await drainTasks(cfg))[0].status).toBe("deferred");
    }
    const last = await drainTasks(cfg);
    expect(last[0].status).toBe("dead-lettered");
    expect(parkCards).toHaveBeenCalledOnce(); // cards on disk BEFORE the row is closed
  });

  it("does not classify the malformed response as permanent", async () => {
    vi.stubGlobal("fetch", htmlServer());
    const { ankiInvoke } = await import("../agent/anki");
    const { isPermanent } = await import("../agent/failure");

    const err = await ankiInvoke("http://localhost:8765", "version", {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isPermanent(err)).toBe(false);
  });

  it("still quarantines a genuinely refused note (the permanent allowlist is untouched)", async () => {
    // Guard against over-correcting: an Anki-level rejection must still be per-note permanent.
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ result: null, error: "cannot create note because it is a duplicate" }),
    ));
    const { addCards } = await import("../agent/anki");
    const r = await addCards(cfg.ankiUrl, cfg.ankiDeck, [
      { headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "" },
    ]);
    expect(r.failed).toHaveLength(1);
  });
});
