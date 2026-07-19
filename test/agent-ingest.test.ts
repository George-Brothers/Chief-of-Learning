// R2 / P0-2: the watcher fires exactly once per transcript file, so a push that fails is a lesson
// lost — no card, no lesson row, no warning. These tests drive the failure modes (transient blip,
// permanent rejection, exhausted retries) against a real temp dir and assert the transcript survives.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestTranscript, scanWatchDir, sweepParked } from "../agent/ingest";
import { listParked, park, readParked } from "../agent/deadletter";

// Real fs throughout, with two synthetic stat() behaviours the scan needs to exercise:
//   - "broken.vtt" throws ENOENT — the race when a recorder writes then removes a temp file between
//     the scan's readdir and its stat.
//   - "writing.vtt" reports an mtime that advances on every stat — a file still being written, so the
//     scan's settle re-stat sees it change and treats it as in-flight.
const H = vi.hoisted(() => ({ writingStatN: 0, WRITING_BASE: Date.UTC(2026, 6, 17, 12, 0, 0) }));
vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (p: any, ...rest: any[]) => {
      const s = String(p);
      if (s.endsWith("broken.vtt")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (s.endsWith("writing.vtt")) return { mtime: new Date(H.WRITING_BASE + H.writingStatN++ * 1000) } as any;
      return (actual.stat as any)(p, ...rest);
    },
  };
});

let dir: string;
let cfg: Parameters<typeof ingestTranscript>[0];

/** Retry with the same policy, minus the real backoff sleeps. */
const FAST = { baseDelayMs: 1 };

const ok = (body: unknown = { ok: true, lessonId: "L1" }) =>
  new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number) => new Response("upstream said no", { status });

/** Write a transcript into the watch dir and return its path. */
async function transcript(name = "lesson.txt", text = "今天我们学跳舞"): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, text, "utf8");
  return p;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  H.writingStatN = 0;
  dir = await mkdtemp(join(tmpdir(), "lucy-agent-"));
  cfg = {
    watchDir: dir, cloudUrl: "http://cloud", secret: "s",
    ankiUrl: "", ankiDeck: "", pollMs: 5000, retentionMs: 0,
    failedDir: join(dir, ".failed"),
  };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("ingestTranscript", () => {
  it("pushes a transcript and parks nothing on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const r = await ingestTranscript(cfg, await transcript(), "2026-07-17");
    expect(r).toEqual({ status: "pushed", lessonId: "L1", alreadySeen: false });
    expect(await listParked(cfg.failedDir)).toEqual([]);
  });

  it("rides out a transient failure instead of losing the lesson", async () => {
    // The exact R2 scenario: one blip. Previously this dropped the transcript on the floor.
    const spy = vi.fn()
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", spy);
    const r = await ingestTranscript(cfg, await transcript(), "2026-07-17", FAST);
    expect(r.status).toBe("pushed");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await listParked(cfg.failedDir)).toEqual([]);
  });

  it("parks the transcript when the push never lands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(503)));
    const path = await transcript("lesson.txt", "今天我们学跳舞");
    const r = await ingestTranscript(cfg, path, "2026-07-17", FAST);

    expect(r.status).toBe("parked");
    const parked = await listParked(cfg.failedDir);
    expect(parked).toHaveLength(1);
    // The lesson is recoverable in full — content, its original date, and where it came from.
    const p = await readParked(parked[0]);
    expect(p?.markdown).toBe("今天我们学跳舞");
    expect(p?.date).toBe("2026-07-17");
    expect(p?.source).toBe(path);
  });

  it("parks a permanently-rejected push without burning retries on it", async () => {
    // A wrong AGENT_SECRET will never succeed; park it immediately rather than backing off 3 times.
    const spy = vi.fn(async () => fail(401));
    vi.stubGlobal("fetch", spy);
    const r = await ingestTranscript(cfg, await transcript(), "2026-07-17");
    expect(r.status).toBe("parked");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("parks the same failing transcript once, not once per attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(401)));
    const path = await transcript();
    await ingestTranscript(cfg, path, "2026-07-17");
    await ingestTranscript(cfg, path, "2026-07-17");
    expect(await listParked(cfg.failedDir)).toHaveLength(1);
  });

  it("ignores an empty file", async () => {
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    expect(await ingestTranscript(cfg, await transcript("blank.txt", "   "), "2026-07-17"))
      .toEqual({ status: "empty" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("parks a source it cannot read instead of dropping the lesson", async () => {
    // Reading a directory throws EISDIR — a stand-in for the EBUSY/EPERM read errors on a WSL mount.
    // The read now happens inside the park guard, so a transient read failure costs no lesson.
    const { mkdir } = await import("node:fs/promises");
    const p = join(dir, "locked.txt");
    await mkdir(p);
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);

    const r = await ingestTranscript(cfg, p, "2026-07-17");
    expect(r.status).toBe("parked");
    expect(spy).not.toHaveBeenCalled(); // never even got to the push
    expect(await listParked(cfg.failedDir)).toHaveLength(1);
  });
});

// §2.3: the watcher is edge-triggered (ignoreInitial), so a transcript that landed while the agent
// was down was never ingested at all — reproduced as "Files the agent ingested: []".
describe("scanWatchDir (boot catch-up)", () => {
  const NOW = new Date("2026-07-17T12:00:00Z");
  /** Backdate a file's mtime, standing in for "this landed while the agent was down". */
  const age = (path: string, days: number) =>
    utimes(path, new Date(NOW.getTime() - days * 86_400_000), new Date(NOW.getTime() - days * 86_400_000));

  it("ingests a lesson that landed while the agent was down", async () => {
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    const path = await transcript("missed.vtt", "今天我们学跳舞");
    await age(path, 2);

    const { outcomes, tooOld } = await scanWatchDir(cfg, NOW);
    expect(outcomes).toEqual([{ status: "pushed", lessonId: "L1", alreadySeen: false }]);
    expect(tooOld).toBe(0);
    // Dated from the file, not from the scan — a 2-day-old lesson isn't today's lesson.
    expect(JSON.parse((spy.mock.calls[0] as any)[1].body).date).toBe("2026-07-15");
  });

  it("re-offers an already-ingested lesson without duplicating it", async () => {
    // Safe by construction: the cloud dedups on content hash, so every boot re-offer is a no-op.
    vi.stubGlobal("fetch", vi.fn(async () => ok({ ok: true, skipped: true })));
    await age(await transcript("seen.vtt"), 1);
    const { outcomes } = await scanWatchDir(cfg, NOW);
    expect(outcomes).toEqual([{ status: "pushed", lessonId: undefined, alreadySeen: true }]);
  });

  it("parks a caught-up lesson the cloud still won't take", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(503)));
    await age(await transcript("missed.vtt"), 1);
    const { outcomes } = await scanWatchDir(cfg, NOW, FAST);
    expect(outcomes[0].status).toBe("parked");
    expect(await listParked(cfg.failedDir)).toHaveLength(1);
  });

  it("bounds the rescan to a recent window instead of re-offering the whole archive", async () => {
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    await age(await transcript("recent.vtt", "recent lesson"), 2);
    await age(await transcript("ancient.vtt", "lesson from january"), 90);

    const { outcomes, tooOld } = await scanWatchDir(cfg, NOW);
    expect(outcomes).toHaveLength(1);
    expect(tooOld).toBe(1); // reported, not silently dropped
    expect(spy).toHaveBeenCalledOnce();
  });

  it("does not mistake its own parked envelopes for transcripts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(401)));
    const t = await transcript();
    await ingestTranscript(cfg, t, "2026-07-17"); // parks one
    await age(t, 1); // settle it outside the quiet window so the scan picks it up
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);

    const { outcomes } = await scanWatchDir(cfg, NOW);
    // Only the real transcript is scanned; the .failed/*.push.json envelope is skipped.
    expect(outcomes).toHaveLength(1);
    const pushed = JSON.parse((spy.mock.calls[0] as any)[1].body);
    expect(pushed.markdown).toBe("今天我们学跳舞");
  });

  it("finds transcripts in subfolders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "2026-07"), { recursive: true });
    await age(await transcript(join("2026-07", "nested.vtt"), "nested lesson"), 1);
    expect((await scanWatchDir(cfg, NOW)).outcomes).toHaveLength(1);
  });

  it("settles and ingests a file finished just before boot, rather than dropping it", async () => {
    // A transcript whose mtime is inside the quiet window but is NOT actually still being written must
    // be ingested by the scan itself — the watcher (ignoreInitial) would never emit 'add' for it, so
    // the old skip-and-defer behaviour dropped it. Re-stat shows a stable mtime → ingest.
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    const fresh = await transcript("just-landed.vtt", "finished lesson");
    await utimes(fresh, new Date(NOW.getTime() - 1000), new Date(NOW.getTime() - 1000)); // 1s before boot

    const { outcomes, inFlight } = await scanWatchDir(cfg, NOW, { quietMs: 2000, sleepFn: async () => {} });
    expect(inFlight).toBe(0);
    expect(outcomes).toEqual([{ status: "pushed", lessonId: "L1", alreadySeen: false }]);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("leaves a file whose mtime is still advancing as in-flight (genuinely mid-write)", async () => {
    // "writing.vtt" reports a moving mtime (see the module mock): the settle re-stat sees it change, so
    // it's a new file still being written — leave it for the watcher's awaitWriteFinish, do not truncate.
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    await transcript("writing.vtt", "half a transcr");

    const { outcomes, inFlight } = await scanWatchDir(cfg, NOW, { quietMs: 2000, sleepFn: async () => {} });
    expect(inFlight).toBe(1);
    expect(outcomes).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled(); // never pushed a truncated half
  });

  it("ignores notes and audio sidecars, ingesting only real transcripts", async () => {
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    await age(await transcript("lesson.vtt", "real lesson"), 1);
    await age(await transcript("lesson.m4a", "binary audio bytes"), 1);
    await age(await transcript("note.pdf", "not a transcript"), 1);

    const { outcomes } = await scanWatchDir(cfg, NOW);
    expect(outcomes).toHaveLength(1); // only the .vtt
    expect(spy).toHaveBeenCalledOnce();
  });

  it("isolates a per-file error and keeps scanning the rest", async () => {
    // One file's stat() throws (see the module mock). That must not abort the whole catch-up and
    // silently skip every remaining transcript — the error is recorded and the scan continues.
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    await transcript("broken.vtt", "loses the stat race");
    await age(await transcript("good.vtt", "real lesson"), 1);

    const { outcomes } = await scanWatchDir(cfg, NOW);
    expect(outcomes.some((o) => o.status === "skipped")).toBe(true);
    expect(outcomes.some((o) => o.status === "pushed")).toBe(true);
  });
});

describe("sweepParked", () => {
  it("replays a parked transcript once the cloud is back, then drops it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(401))); // park it first
    await ingestTranscript(cfg, await transcript(), "2026-07-17");
    expect(await listParked(cfg.failedDir)).toHaveLength(1);

    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);
    expect(await sweepParked(cfg)).toEqual({ replayed: 1, failed: 0 });
    expect(await listParked(cfg.failedDir)).toEqual([]);
    // Replayed verbatim: the lesson keeps the date it was recorded on, not the date it was replayed.
    expect(JSON.parse((spy.mock.calls[0] as any)[1].body)).toMatchObject({
      markdown: "今天我们学跳舞", date: "2026-07-17",
    });
  });

  it("keeps a parked transcript when the replay fails again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(401)));
    await ingestTranscript(cfg, await transcript(), "2026-07-17");
    expect(await sweepParked(cfg)).toEqual({ replayed: 0, failed: 1 });
    expect(await listParked(cfg.failedDir)).toHaveLength(1); // still there for the next sweep
  });

  it("treats an already-ingested replay as done (server hash dedup)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(401)));
    await ingestTranscript(cfg, await transcript(), "2026-07-17");

    // The original push may have landed before the response was lost; the cloud says "skipped".
    vi.stubGlobal("fetch", vi.fn(async () => ok({ ok: true, skipped: true })));
    expect(await sweepParked(cfg)).toEqual({ replayed: 1, failed: 0 });
    expect(await listParked(cfg.failedDir)).toEqual([]);
  });

  it("is a no-op when nothing has ever failed", async () => {
    expect(await sweepParked(cfg)).toEqual({ replayed: 0, failed: 0 });
  });

  it("replays a read-failure park by re-reading the source once it's readable", async () => {
    // A source park carries no content (the read failed at ingest time). The sweep re-reads the file,
    // converts it, and pushes — so a transient read error costs no lesson.
    const p = await transcript("late.txt", "今天我们学跳舞");
    await park(cfg.failedDir, { source: p, date: "2026-07-17" });
    const spy = vi.fn(async () => ok());
    vi.stubGlobal("fetch", spy);

    expect(await sweepParked(cfg)).toEqual({ replayed: 1, failed: 0 });
    expect(await listParked(cfg.failedDir)).toEqual([]);
    expect(JSON.parse((spy.mock.calls[0] as any)[1].body)).toMatchObject({
      markdown: "今天我们学跳舞", date: "2026-07-17",
    });
  });

  it("leaves a corrupt parked file alone for the owner to inspect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cfg.failedDir, { recursive: true });
    await writeFile(join(cfg.failedDir, "2026-07-17-abc.push.json"), "{ truncated", "utf8");
    expect(await sweepParked(cfg)).toEqual({ replayed: 0, failed: 1 });
    expect(await readdir(cfg.failedDir)).toHaveLength(1);
  });
});
