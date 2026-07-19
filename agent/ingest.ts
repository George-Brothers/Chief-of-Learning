import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "./config";
import { contentHash } from "./hash";
import { isTranscript, toMarkdown } from "./convert";
import { pushTranscript, type PushOpts } from "./push";
import { listParked, park, readParked, unpark } from "./deadletter";

export type IngestOutcome =
  | { status: "empty" }
  | { status: "pushed"; lessonId?: string; alreadySeen: boolean }
  | { status: "parked"; file: string; error: string }
  /** Scan-level: this file couldn't be stat'd/processed; the rest of the scan continues past it. */
  | { status: "skipped"; file: string; error: string };

/**
 * Watcher path: read a transcript, convert it, push it up. The watcher fires exactly once per file,
 * so this is the lesson's only chance to reach the cloud — anything that can't land is parked in the
 * dead-letter dir for sweepParked() to replay, never just logged and dropped (R2). That covers both a
 * failed push *and* a read that fails outright (EBUSY/EPERM on a WSL/Windows mount): the read is done
 * inside the guard so a transient read error parks a source envelope instead of dropping the lesson.
 */
export async function ingestTranscript(
  cfg: AgentConfig, path: string, date: string, opts: PushOpts = {},
): Promise<IngestOutcome> {
  let md: string;
  try {
    md = toMarkdown(path, await readFile(path, "utf8"));
  } catch (e) {
    const file = await park(cfg.failedDir, { date, source: path });
    return { status: "parked", file, error: (e as Error).message };
  }
  if (!md) return { status: "empty" };
  const hash = contentHash(md);
  try {
    const res = await pushTranscript(cfg, md, hash, date, opts);
    return { status: "pushed", lessonId: res.lessonId, alreadySeen: Boolean(res.skipped) };
  } catch (e) {
    const error = (e as Error).message;
    const file = await park(cfg.failedDir, { markdown: md, hash, date, source: path });
    return { status: "parked", file, error };
  }
}

/**
 * Boot catch-up. The watcher is edge-triggered (`ignoreInitial: true`) with no level-triggered
 * backstop, so a transcript that landed while the agent was down — the normal case on a laptop, and
 * worse under the README's WSL caveat — is never ingested at all. Rescan on startup.
 *
 * Safe by construction: the cloud dedups on the content hash, so re-offering a lesson it already has
 * comes back "skipped" rather than duplicating it.
 *
 * Bounded to a recent window on purpose: a lesson missed by an outage is by definition recent, while
 * an unbounded rescan would re-offer the entire transcript archive on every pm2 restart. Files older
 * than the window are reported as skipped rather than dropped quietly.
 *
 * Robust by file: one file that can't be stat'd (an ENOENT race with a recorder writing then removing
 * a temp file) is recorded and stepped over, never aborting the whole catch-up. And only real
 * transcript extensions are handed on, so an audio sidecar dropped beside a transcript isn't pushed as
 * a bogus lesson.
 *
 * In-flight files are settled by the scan itself, not deferred to the watcher: the watcher runs with
 * `ignoreInitial: true`, so it never emits `add` for a file that already existed at boot — a transcript
 * being finalized at the boot instant would be dropped by both. Instead, a file whose mtime is inside
 * the quiet window is re-stat'd after that window elapses: an unchanged mtime means the write settled
 * and the scan ingests it; a changed one means it is genuinely still being written (a brand-new file
 * the watcher's awaitWriteFinish will catch on its own `add`), so it is left as inFlight.
 */
export async function scanWatchDir(
  cfg: AgentConfig, now: Date, opts: PushOpts & { windowDays?: number; quietMs?: number } = {},
): Promise<{ outcomes: IngestOutcome[]; tooOld: number; inFlight: number }> {
  const cutoff = now.getTime() - (opts.windowDays ?? 7) * 86_400_000;
  const quietMs = opts.quietMs ?? 2000;
  const wait = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const outcomes: IngestOutcome[] = [];
  let tooOld = 0;
  let inFlight = 0;
  for (const e of await readdir(cfg.watchDir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    if (path.startsWith(cfg.failedDir)) continue; // parked envelopes are not transcripts
    if (!isTranscript(path)) continue; // and neither are notes or audio sidecars
    try {
      let mtime = (await stat(path)).mtime;
      if (mtime.getTime() < cutoff) {
        tooOld++;
        continue;
      }
      if (now.getTime() - mtime.getTime() < quietMs) {
        // Possibly mid-write. Wait out the quiet window and re-stat: settled → ingest here; still
        // changing → genuinely in flight, leave it (the watcher's awaitWriteFinish covers a new file).
        await wait(quietMs);
        const settled = (await stat(path)).mtime;
        if (settled.getTime() !== mtime.getTime()) {
          inFlight++;
          continue;
        }
        mtime = settled;
      }
      // Date the lesson from the file, not from now — a catch-up run must not re-date a transcript
      // that landed two days ago as today's lesson.
      outcomes.push(await ingestTranscript(cfg, path, mtime.toISOString().slice(0, 10), opts));
    } catch (err) {
      outcomes.push({ status: "skipped", file: path, error: (err as Error).message });
    }
  }
  return { outcomes, tooOld, inFlight };
}

/**
 * Replay every parked push. Idempotent by construction: the cloud dedups on the content hash, so a
 * transcript that actually landed before the response was lost is skipped rather than duplicated.
 * One attempt each — the sweep's own cadence is the retry loop, and a long outage shouldn't be hammered.
 */
export async function sweepParked(cfg: AgentConfig): Promise<{ replayed: number; failed: number }> {
  let replayed = 0;
  let failed = 0;
  for (const file of await listParked(cfg.failedDir)) {
    const p = await readParked(file);
    if (!p) {
      failed++;
      console.error(`dead-letter: ${file} is unreadable — leaving it for inspection`);
      continue;
    }
    try {
      // A source park (read failed at ingest time) carries no content — re-read it now. If the file
      // is gone or now empty, there is nothing to replay: drop the envelope.
      let { markdown, hash } = p;
      if (!markdown) {
        markdown = toMarkdown(p.source, await readFile(p.source, "utf8"));
        if (!markdown) {
          await unpark(file);
          replayed++;
          continue;
        }
        hash = contentHash(markdown);
      }
      await pushTranscript(cfg, markdown, hash as string, p.date, { attempts: 1 });
      await unpark(file);
      replayed++;
    } catch (e) {
      failed++;
      console.error(`dead-letter: ${file} still failing:`, (e as Error).message);
    }
  }
  return { replayed, failed };
}
