import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { RecorderConfig } from "./config";

/** Container/audio extensions a recorder might drop. Everything else in the dir is ignored — this is
 *  the mirror of the daemon's `isTranscript` (agent/convert.ts): there, transcripts; here, recordings. */
const AUDIO_EXTS = new Set([
  ".mkv", ".mka", ".mp4", ".m4a", ".mov", ".webm", ".mp3", ".wav", ".flac", ".ogg", ".opus", ".aac",
]);

export function isAudio(path: string): boolean {
  return AUDIO_EXTS.has(extname(path).toLowerCase());
}

export type RunResult = { code: number; stderr: string };
/** The single external-process seam. The real impl spawns ffmpeg/whisper; tests inject a fake that
 *  writes fixture output, so the whole pipeline is exercised without real audio or binaries. */
export type Run = (bin: string, args: string[]) => Promise<RunResult>;

/** Spawn a child, resolving with its exit code + captured stderr. Rejects only on spawn failure
 *  (e.g. ENOENT: a mis-configured binary path) — which the caller treats as a per-file failure. */
export const spawnRun: Run = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });

export type TranscribeOutcome =
  | { status: "transcribed"; src: string; srt: string }
  /** The transcript already existed — re-transcription skipped (idempotent), source archived. */
  | { status: "exists"; src: string; srt: string }
  /** ffmpeg/whisper failed or produced nothing — the recording is quarantined, never dropped. */
  | { status: "failed"; src: string; error: string };

export type TranscribeOpts = { run?: Run };

/** In-flight source paths, guarding against the boot scan and the live watcher double-processing the
 *  same recording (both would otherwise spawn a duplicate, minutes-long ffmpeg+whisper run and race on
 *  the shared scratch paths). A second call for an already-running source reports `exists` and no-ops. */
const inFlightSources = new Set<string>();

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Move a file into `dir`, creating it. Falls back to copy+unlink across a filesystem boundary
 *  (EXDEV), so recordingsDir and its archive/quarantine dirs can live on different volumes. */
async function moveInto(dir: string, src: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const dest = join(dir, basename(src));
  try {
    await rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await copyFile(src, dest);
    await rm(src, { force: true });
  }
}

/**
 * Transcribe one recording and publish its `.srt` into the daemon's watched folder.
 *
 * Contract with the daemon (agent/convert.ts, agent/ingest.ts): we only ever drop a `.srt` — an
 * extension the daemon already accepts and whose cue numbers + timestamps it already strips — and we
 * publish it atomically (write a `.partial` temp beside the target, then rename), so the daemon's
 * watcher never sees a half-written file. The daemon needs no change to consume this.
 *
 * Safety: the recording is a lesson's only copy until a transcript lands, so a failure never deletes
 * it — it is moved to `failedAudioDir` for inspection/replay. Idempotent: a transcript that already
 * exists short-circuits, and the server dedups on content hash anyway, so a re-run cannot duplicate.
 */
export async function transcribeOne(
  cfg: RecorderConfig, src: string, opts: TranscribeOpts = {},
): Promise<TranscribeOutcome> {
  const base = basename(src, extname(src));
  const finalSrt = join(cfg.transcriptsDir, `${base}.srt`);

  // In-flight guard: the boot scan and the live watcher can both see a recording that finishes in the
  // boot window. Without this, both spawn ffmpeg+whisper on the same source and race on the shared
  // scratch paths. A second concurrent call no-ops and reports the source as already handled.
  if (inFlightSources.has(src)) return { status: "exists", src, srt: finalSrt };
  inFlightSources.add(src);
  try {
    return await transcribeInner(cfg, src, opts, base, finalSrt);
  } finally {
    inFlightSources.delete(src);
  }
}

async function transcribeInner(
  cfg: RecorderConfig, src: string, opts: TranscribeOpts, base: string, finalSrt: string,
): Promise<TranscribeOutcome> {
  const run = opts.run ?? spawnRun;

  // Idempotent: if the transcript already exists, don't re-transcribe. Still archive the source so it
  // stops reappearing on every boot scan, then report it as already done.
  if (await pathExists(finalSrt)) {
    await moveInto(cfg.archiveDir, src).catch(() => {});
    return { status: "exists", src, srt: finalSrt };
  }

  const wav = join(cfg.workDir, `${base}.wav`);
  const workBase = join(cfg.workDir, base);
  const workSrt = `${workBase}.srt`;
  const partial = join(cfg.transcriptsDir, `.${base}.srt.partial`);
  try {
    await mkdir(cfg.workDir, { recursive: true });
    await mkdir(cfg.transcriptsDir, { recursive: true });

    // 1. Extract a 16 kHz mono WAV — Whisper's native input — dropping any video track (-vn).
    const ff = await run(cfg.ffmpegBin, ["-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav]);
    if (ff.code !== 0) throw new Error(`ffmpeg exited ${ff.code}: ${ff.stderr.trim().slice(-400)}`);

    // 2. Transcribe. whisper.cpp writes `${workBase}.srt`. Language is forced (see config).
    const wh = await run(cfg.whisperBin, [
      "-m", cfg.whisperModel, "-l", cfg.whisperLang, "-osrt", "-of", workBase, wav,
    ]);
    if (wh.code !== 0) throw new Error(`whisper exited ${wh.code}: ${wh.stderr.trim().slice(-400)}`);

    const srtText = await readFile(workSrt, "utf8").catch(() => "");
    if (!srtText.trim()) throw new Error("transcription produced an empty transcript");

    // 3. Publish atomically. Copy into a hidden temp beside the target (sharing the target's
    //    filesystem — WATCH_DIR may be a different volume than the recordings), then rename within
    //    that dir. `.partial` isn't a transcript extension, so a half-copied temp is never ingested.
    await copyFile(workSrt, partial);
    await rename(partial, finalSrt);

    // 4. Keep the (now transcribed) source and clean scratch. Archiving is best-effort: the transcript
    //    is already published, so a failed move must not flip this to `failed` — the next scan re-archives.
    await moveInto(cfg.archiveDir, src).catch(() => {});
    await rm(wav, { force: true });
    await rm(workSrt, { force: true });
    return { status: "transcribed", src, srt: finalSrt };
  } catch (e) {
    // Preserve the recording rather than retry it forever or drop it: it is the lesson's only copy.
    await rm(wav, { force: true }).catch(() => {});
    await rm(workSrt, { force: true }).catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
    await moveInto(cfg.failedAudioDir, src).catch(() => {});
    return { status: "failed", src, error: (e as Error).message };
  }
}

export type ScanOpts = TranscribeOpts & {
  windowDays?: number;
  quietMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
};

/**
 * Boot catch-up, mirroring the daemon's `scanWatchDir` (agent/ingest.ts): the live watcher is
 * edge-triggered, so a recording that landed while the recorder was down is only picked up by a
 * rescan. Bounded to a recent window (a missed lesson is by definition recent), it skips its own
 * archive/quarantine/scratch dirs, and settles a file whose mtime is inside the quiet window — an
 * unchanged mtime means the write finished, a changed one means OBS is still writing (leave it for
 * the watcher's awaitWriteFinish). Idempotent by construction (transcribeOne short-circuits).
 */
export async function scanRecordings(
  cfg: RecorderConfig, now: Date, opts: ScanOpts = {},
): Promise<{ outcomes: TranscribeOutcome[]; tooOld: number; inFlight: number }> {
  const cutoff = now.getTime() - (opts.windowDays ?? 7) * 86_400_000;
  const quietMs = opts.quietMs ?? 2000;
  const wait = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const outcomes: TranscribeOutcome[] = [];
  let tooOld = 0;
  let inFlight = 0;

  let entries: Dirent[];
  try {
    entries = await readdir(cfg.recordingsDir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcomes, tooOld, inFlight };
    throw e;
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    if (isManaged(cfg, path)) continue; // our archive/quarantine/scratch, not inputs
    if (!isAudio(path)) continue;
    try {
      let mtime = (await stat(path)).mtime;
      if (mtime.getTime() < cutoff) {
        tooOld++;
        continue;
      }
      if (now.getTime() - mtime.getTime() < quietMs) {
        await wait(quietMs);
        const settled = (await stat(path)).mtime;
        if (settled.getTime() !== mtime.getTime()) {
          inFlight++;
          continue;
        }
        mtime = settled;
      }
      outcomes.push(await transcribeOne(cfg, path, opts));
    } catch (err) {
      outcomes.push({ status: "failed", src: path, error: (err as Error).message });
    }
  }
  return { outcomes, tooOld, inFlight };
}

/** A path the recorder itself owns (archive/quarantine/scratch) — never re-ingested as an input. */
export function isManaged(cfg: RecorderConfig, path: string): boolean {
  return (
    path.startsWith(cfg.workDir) ||
    path.startsWith(cfg.archiveDir) ||
    path.startsWith(cfg.failedAudioDir)
  );
}
