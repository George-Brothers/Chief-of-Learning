import { watch } from "chokidar";
import { loadRecorderConfig } from "./config";
import { isAudio, isManaged, scanRecordings, transcribeOne, type TranscribeOutcome } from "./transcribe";

const cfg = loadRecorderConfig();

function logOutcome(path: string, r: TranscribeOutcome): void {
  if (r.status === "transcribed") console.log(`transcribed ${path} → ${r.srt}`);
  else if (r.status === "exists") console.log(`skipped ${path}: transcript already exists`);
  else console.error(`transcription failed for ${path} — quarantined in ${cfg.failedAudioDir}: ${r.error}`);
}

// --- Watcher: a finished recording → extract audio → transcribe → drop a .srt into WATCH_DIR, which
// the ingest daemon (agent/index.ts) then picks up. Our own archive/quarantine/scratch dirs are ignored.
watch(cfg.recordingsDir, {
  ignoreInitial: true,
  awaitWriteFinish: true,
  ignored: (p: string) => isManaged(cfg, p),
}).on("add", async (path) => {
  if (!isAudio(path)) return; // a note or sidecar in the recordings dir is not a recording
  try {
    logOutcome(path, await transcribeOne(cfg, path));
  } catch (e) {
    console.error(`recorder: error handling ${path}:`, (e as Error).message);
  }
});

// --- Catch-up: the watcher only sees recordings that land while it runs, so rescan recent files at
// boot. Idempotent (transcribeOne short-circuits an existing transcript; the cloud dedups by hash).
async function catchUp(): Promise<void> {
  try {
    const { outcomes, tooOld, inFlight } = await scanRecordings(cfg, new Date());
    const done = outcomes.filter((o) => o.status === "transcribed").length;
    const already = outcomes.filter((o) => o.status === "exists").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    console.log(
      `catch-up scan: ${outcomes.length} recent recording(s), ${done} transcribed, ${already} already done, ` +
        `${failed} quarantined, ${inFlight} still being written, ${tooOld} outside the scan window`,
    );
  } catch (e) {
    console.error("catch-up scan error:", (e as Error).message);
  }
}

console.log(
  `Lucy recorder up. Watching ${cfg.recordingsDir}, transcripts → ${cfg.transcriptsDir} ` +
    `(model ${cfg.whisperModel}, lang ${cfg.whisperLang}).`,
);
void catchUp();
