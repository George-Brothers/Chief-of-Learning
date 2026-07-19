// The recorder bridge (agent/recorder/) turns a finished OBS recording into a .srt in the daemon's
// watched folder. These tests drive the whole pipeline against a REAL temp filesystem but with a
// STUBBED external-process seam (`Run`) standing in for ffmpeg + whisper.cpp — no audio, no binaries,
// so it runs in CI. They assert the two invariants that matter: (1) a transcribed lesson lands as a
// daemon-consumable .srt and the source is kept (never deleted); (2) any failure preserves the
// recording in quarantine rather than dropping the lesson's only copy.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { isAudio, isManaged, scanRecordings, transcribeOne, type Run } from "../agent/recorder/transcribe";
import type { RecorderConfig } from "../agent/recorder/config";
import { toMarkdown } from "../agent/convert";

const FFMPEG = "ffmpeg-fake";
const WHISPER = "whisper-fake";

const SRT = [
  "1",
  "00:00:00,000 --> 00:00:03,000",
  "今天我们学跳舞",
  "",
  "2",
  "00:00:03,000 --> 00:00:05,000",
  "Very good!",
  "",
].join("\n");

/**
 * A fake `Run`: ffmpeg writes a stub WAV at its output path (ffmpeg's last arg); whisper writes a
 * `.srt` at `<-of value>.srt`. Either can be told to fail with a non-zero exit code.
 */
function makeRun(opts: { ffCode?: number; whCode?: number; srt?: string } = {}): Run {
  return async (bin, args) => {
    if (bin === FFMPEG) {
      if (opts.ffCode) return { code: opts.ffCode, stderr: "ffmpeg: boom" };
      await writeFile(args[args.length - 1], "RIFF....fake-wav");
      return { code: 0, stderr: "" };
    }
    if (bin === WHISPER) {
      if (opts.whCode) return { code: opts.whCode, stderr: "whisper: boom" };
      const of = args[args.indexOf("-of") + 1];
      await writeFile(`${of}.srt`, opts.srt ?? SRT, "utf8");
      return { code: 0, stderr: "" };
    }
    throw new Error(`unexpected binary ${bin}`);
  };
}

let dir: string;
let cfg: RecorderConfig;

/** Drop a recording into the recordings dir and return its path. */
async function recording(name = "lesson-2026-07-18.mkv"): Promise<string> {
  const p = join(cfg.recordingsDir, name);
  await mkdir(cfg.recordingsDir, { recursive: true });
  await writeFile(p, "fake container bytes");
  return p;
}

const ls = (d: string) => readdir(d).catch(() => [] as string[]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucy-recorder-"));
  cfg = {
    recordingsDir: join(dir, "recordings"),
    transcriptsDir: join(dir, "transcripts"),
    whisperBin: WHISPER,
    whisperModel: "/models/ggml-large-v3-q5_0.bin",
    whisperLang: "zh",
    ffmpegBin: FFMPEG,
    archiveDir: join(dir, "recordings", ".done"),
    failedAudioDir: join(dir, "recordings", ".failed-audio"),
    workDir: join(dir, "recordings", ".work"),
  };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("isAudio", () => {
  it("accepts recording containers, rejects transcripts and notes", () => {
    for (const p of ["a.mkv", "a.MP4", "a.m4a", "a.mka", "a.wav", "a.webm", "a.mp3"]) {
      expect(isAudio(p)).toBe(true);
    }
    for (const p of ["a.srt", "a.txt", "a.vtt", "a.pdf", "a"]) expect(isAudio(p)).toBe(false);
  });
});

describe("transcribeOne", () => {
  it("transcribes a recording into a daemon-consumable .srt and keeps the source", async () => {
    const src = await recording();
    const r = await transcribeOne(cfg, src, { run: makeRun() });

    expect(r.status).toBe("transcribed");
    const out = join(cfg.transcriptsDir, "lesson-2026-07-18.srt");
    expect(await readFile(out, "utf8")).toBe(SRT);

    // The daemon's own converter must reduce our .srt to just the spoken lines (no timestamps/cue #s).
    expect(toMarkdown(out, SRT)).toBe("今天我们学跳舞\nVery good!");

    // Source kept (never deleted): moved into the archive, out of the recordings root.
    expect(await ls(cfg.recordingsDir)).not.toContain("lesson-2026-07-18.mkv");
    expect(await ls(cfg.archiveDir)).toContain("lesson-2026-07-18.mkv");
    // Scratch cleaned; no half-written temp left in the transcripts dir.
    expect(await ls(cfg.workDir)).toEqual([]);
    expect(await ls(cfg.transcriptsDir)).toEqual(["lesson-2026-07-18.srt"]);
  });

  it("is idempotent: an existing transcript is not re-transcribed, and the source is archived", async () => {
    await mkdir(cfg.transcriptsDir, { recursive: true });
    await writeFile(join(cfg.transcriptsDir, "lesson-2026-07-18.srt"), "already here", "utf8");
    const src = await recording();

    let ran = false;
    const spyRun: Run = async (...a) => { ran = true; return makeRun()(...a); };
    const r = await transcribeOne(cfg, src, { run: spyRun });

    expect(r.status).toBe("exists");
    expect(ran).toBe(false); // never invoked ffmpeg/whisper
    expect(await readFile(join(cfg.transcriptsDir, "lesson-2026-07-18.srt"), "utf8")).toBe("already here");
    expect(await ls(cfg.archiveDir)).toContain("lesson-2026-07-18.mkv");
  });

  it("quarantines the recording (never drops it) when ffmpeg fails", async () => {
    const src = await recording();
    const r = await transcribeOne(cfg, src, { run: makeRun({ ffCode: 1 }) });

    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/ffmpeg exited 1/);
    // No transcript written; the audio is preserved for inspection/replay.
    expect(await ls(cfg.transcriptsDir)).toEqual([]);
    expect(await ls(cfg.failedAudioDir)).toContain("lesson-2026-07-18.mkv");
    expect(await ls(cfg.recordingsDir)).not.toContain("lesson-2026-07-18.mkv");
  });

  it("quarantines the recording when whisper fails", async () => {
    const src = await recording();
    const r = await transcribeOne(cfg, src, { run: makeRun({ whCode: 2 }) });

    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/whisper exited 2/);
    expect(await ls(cfg.transcriptsDir)).toEqual([]);
    expect(await ls(cfg.failedAudioDir)).toContain("lesson-2026-07-18.mkv");
  });

  it("quarantines a recording that transcribes to nothing rather than writing an empty lesson", async () => {
    const src = await recording();
    const r = await transcribeOne(cfg, src, { run: makeRun({ srt: "   \n\n" }) });

    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/empty transcript/);
    expect(await ls(cfg.transcriptsDir)).toEqual([]);
    expect(await ls(cfg.failedAudioDir)).toContain("lesson-2026-07-18.mkv");
  });

  it("preserves the recording when the binary itself cannot be spawned (ENOENT)", async () => {
    const src = await recording();
    const boom: Run = async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
    const r = await transcribeOne(cfg, src, { run: boom });

    expect(r.status).toBe("failed");
    expect(await ls(cfg.failedAudioDir)).toContain("lesson-2026-07-18.mkv");
  });

  it("passes the forced language and model through to whisper", async () => {
    const src = await recording();
    let whisperArgs: string[] = [];
    const capture: Run = async (bin, args) => {
      if (bin === WHISPER) whisperArgs = args;
      return makeRun()(bin, args);
    };
    await transcribeOne(cfg, src, { run: capture });

    expect(whisperArgs).toContain("-l");
    expect(whisperArgs[whisperArgs.indexOf("-l") + 1]).toBe("zh");
    expect(whisperArgs[whisperArgs.indexOf("-m") + 1]).toBe("/models/ggml-large-v3-q5_0.bin");
  });
});

describe("scanRecordings (boot catch-up)", () => {
  const NOW = new Date("2026-07-18T12:00:00Z");
  const age = (p: string, days: number) => {
    const t = new Date(NOW.getTime() - days * 86_400_000);
    return utimes(p, t, t);
  };
  const settled = { quietMs: 2000, sleepFn: async () => {} };

  it("transcribes a recording that landed while the recorder was down", async () => {
    await age(await recording("missed.mkv"), 1);
    const { outcomes, tooOld } = await scanRecordings(cfg, NOW, { run: makeRun(), ...settled });
    expect(outcomes.map((o) => o.status)).toEqual(["transcribed"]);
    expect(tooOld).toBe(0);
    expect(await ls(cfg.transcriptsDir)).toEqual(["missed.srt"]);
  });

  it("bounds the rescan to a recent window instead of reprocessing the whole archive", async () => {
    await age(await recording("recent.mkv"), 2);
    await age(await recording("ancient.mkv"), 90);
    const { outcomes, tooOld } = await scanRecordings(cfg, NOW, { run: makeRun(), ...settled });
    expect(outcomes).toHaveLength(1);
    expect(tooOld).toBe(1); // reported, not silently dropped
  });

  it("ignores its own archive/quarantine/scratch dirs and non-audio files", async () => {
    await mkdir(cfg.archiveDir, { recursive: true });
    await age(join(cfg.archiveDir, "old.mkv"), 1).catch(() => {});
    await writeFile(join(cfg.archiveDir, "old.mkv"), "x");
    await age(join(cfg.archiveDir, "old.mkv"), 1);
    await writeFile(join(cfg.recordingsDir, "notes.txt"), "not audio");
    await age(join(cfg.recordingsDir, "notes.txt"), 1);
    await age(await recording("real.mkv"), 1);

    const { outcomes } = await scanRecordings(cfg, NOW, { run: makeRun(), ...settled });
    expect(outcomes).toHaveLength(1); // only real.mkv
    expect(await ls(cfg.transcriptsDir)).toEqual(["real.srt"]);
  });

  it("finds recordings in subfolders", async () => {
    await mkdir(join(cfg.recordingsDir, "2026-07"), { recursive: true });
    const p = join(cfg.recordingsDir, "2026-07", "nested.mkv");
    await writeFile(p, "x");
    await age(p, 1);
    const { outcomes } = await scanRecordings(cfg, NOW, { run: makeRun(), ...settled });
    expect(outcomes).toHaveLength(1);
  });

  it("leaves a recording whose mtime is still advancing as in-flight (OBS still writing)", async () => {
    const p = await recording("writing.mkv");
    // mtime is inside the quiet window and keeps moving: the settle re-stat sees it change.
    await utimes(p, new Date(NOW.getTime() - 500), new Date(NOW.getTime() - 500));
    let n = 0;
    const advancingSleep = async () => { await utimes(p, new Date(NOW.getTime() + ++n * 1000), new Date(NOW.getTime() + n * 1000)); };
    const { outcomes, inFlight } = await scanRecordings(cfg, NOW, { run: makeRun(), quietMs: 2000, sleepFn: advancingSleep });
    expect(inFlight).toBe(1);
    expect(outcomes).toHaveLength(0);
  });

  it("returns empty when the recordings dir does not exist yet", async () => {
    const { outcomes, tooOld, inFlight } = await scanRecordings(cfg, NOW, { run: makeRun() });
    expect({ outcomes, tooOld, inFlight }).toEqual({ outcomes: [], tooOld: 0, inFlight: 0 });
  });
});

describe("isManaged", () => {
  it("flags the recorder's own dirs, not real recordings", () => {
    expect(isManaged(cfg, join(cfg.workDir, "x.wav"))).toBe(true);
    expect(isManaged(cfg, join(cfg.archiveDir, "x.mkv"))).toBe(true);
    expect(isManaged(cfg, join(cfg.failedAudioDir, "x.mkv"))).toBe(true);
    expect(isManaged(cfg, join(cfg.recordingsDir, "x.mkv"))).toBe(false);
  });
});

// A tiny guard so the helper fixtures stay honest about the base-name math transcribeOne relies on.
describe("base-name derivation", () => {
  it("strips only the final extension", () => {
    expect(basename("a.b.mkv", extname("a.b.mkv"))).toBe("a.b");
  });
});
