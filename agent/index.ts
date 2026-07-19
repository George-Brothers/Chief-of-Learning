import { watch } from "chokidar";
import { loadConfig } from "./config";
import { isTranscript } from "./convert";
import { ingestTranscript, scanWatchDir, sweepParked } from "./ingest";
import { drainTasks } from "./executor";
import { makeHeartbeat } from "./heartbeat";
import { syncRetention } from "./retention";

const cfg = loadConfig();

/** How often to replay dead-lettered pushes. Slow enough that a real outage isn't hammered. */
const SWEEP_MS = 5 * 60_000;

// --- Watcher: new transcript file → convert → push up (parked in failedDir if it can't land).
// failedDir is skipped: it sits under watchDir by default, and its parked *.push.json envelopes
// would otherwise be picked up as if they were transcripts.
watch(cfg.watchDir, {
  ignoreInitial: true,
  awaitWriteFinish: true,
  ignored: (p: string) => p.startsWith(cfg.failedDir),
}).on("add", async (path) => {
  if (!isTranscript(path)) return; // a note or an audio sidecar is not a transcript
  try {
    const date = new Date().toISOString().slice(0, 10);
    const r = await ingestTranscript(cfg, path, date);
    if (r.status === "pushed") {
      console.log(`pushed ${path}:`, r.alreadySeen ? "already seen" : `lesson ${r.lessonId}`);
    } else if (r.status === "parked") {
      console.error(`push failed for ${path} — parked at ${r.file}, will retry: ${r.error}`);
    }
  } catch (e) {
    console.error(`watch/push error for ${path}:`, (e as Error).message);
  }
});

// --- Dead-letter: replay transcripts whose push never landed, so a blip can't cost a lesson.
async function sweep(): Promise<void> {
  try {
    const { replayed, failed } = await sweepParked(cfg);
    if (replayed || failed) console.log(`dead-letter sweep: ${replayed} replayed, ${failed} still failing`);
  } catch (e) {
    console.error("dead-letter sweep error:", (e as Error).message);
  }
}
setInterval(sweep, SWEEP_MS);
void sweep();

// --- Executor: drain the action queue.
/** Tasks already logged as deferred, so a closed Anki doesn't reprint the same line every poll. */
const deferred = new Set<string>();

/**
 * Liveness. This runs after the queue drain, on every cycle that got that far, so the cloud can tell
 * "this agent is down" from "there was nothing to do" — the distinction the daily brief and the
 * dashboard both alarm on.
 */
const beat = makeHeartbeat(cfg);

async function drain(): Promise<void> {
  try {
    for (const r of await drainTasks(cfg)) {
      if (r.status === "done") {
        deferred.delete(r.id);
        console.log(`task ${r.id}: +${r.added} cards`);
      } else if (r.status === "deferred") {
        if (!deferred.has(r.id)) {
          deferred.add(r.id);
          console.warn(`task ${r.id}: ${r.error} — still queued, retrying every ${cfg.pollMs}ms`);
        }
      } else if (r.status === "burned") {
        console.error(`task ${r.id} failed permanently:`, r.error);
      }
    }
  } catch (e) {
    console.error("poll error:", (e as Error).message);
    return; // a cycle that couldn't reach the cloud is not a cycle that proves this agent is healthy
  }
  try {
    await beat();
  } catch (e) {
    console.error("heartbeat failed:", (e as Error).message);
  }
}

console.log(`Lucy agent up. Watching ${cfg.watchDir}, polling ${cfg.cloudUrl} every ${cfg.pollMs}ms.`);
setInterval(drain, cfg.pollMs);
void drain();

// --- Catch-up: the watcher only sees files that land while it's running, so rescan recent
// transcripts at boot. Hash-dedup server-side makes a re-offer a no-op.
async function catchUp(): Promise<void> {
  try {
    const { outcomes, tooOld, inFlight } = await scanWatchDir(cfg, new Date());
    const fresh = outcomes.filter((o) => o.status === "pushed" && !o.alreadySeen).length;
    const parked = outcomes.filter((o) => o.status === "parked").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    console.log(
      `catch-up scan: ${outcomes.length} recent file(s), ${fresh} newly ingested, ${parked} parked, ` +
        `${skipped} unreadable, ${inFlight} still being written, ${tooOld} outside the scan window`,
    );
  } catch (e) {
    console.error("catch-up scan error:", (e as Error).message);
  }
}
void catchUp();

// --- Retention: sync Anki mature cards up as "retained" words.
async function retain(): Promise<void> {
  try {
    const n = await syncRetention(cfg);
    console.log(`retention sync: ${n} mature words`);
  } catch (e) {
    console.error("retention error:", (e as Error).message);
  }
}
setInterval(retain, cfg.retentionMs);
void retain();
