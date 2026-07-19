import { join } from "node:path";

/**
 * Config for the recorder bridge (`agent/recorder/`). This is a SEPARATE process from the ingest
 * daemon (`agent/index.ts`): it turns finished lesson recordings into transcript files and drops them
 * into the daemon's watched folder, so the proven ingest path stays untouched and the heavy
 * transcription can never stall the ingest/executor loops.
 *
 * `WATCH_DIR` is shared with the daemon — it is the recorder's OUTPUT and the daemon's INPUT.
 */
export type RecorderConfig = {
  /** OBS output dir we watch for finished recordings (the recorder's input). */
  recordingsDir: string;
  /** Lucy's watched folder — where we drop the finished `.srt` (the ingest daemon's input). */
  transcriptsDir: string;
  /** whisper.cpp CLI (`whisper-cli`) and the ggml model file it loads. */
  whisperBin: string;
  whisperModel: string;
  /** Forced transcription language. Default "zh": a Mandarin lesson, where auto-detect can flip the
   *  whole file to English on an English opening. Set WHISPER_LANG=auto to let Whisper decide. */
  whisperLang: string;
  /** ffmpeg, used to extract a 16 kHz mono WAV from OBS's container. Default "ffmpeg" (on PATH). */
  ffmpegBin: string;
  /** Where a successfully transcribed recording is moved — kept, never deleted. */
  archiveDir: string;
  /** Where a recording we could not transcribe is moved, preserved for inspection/replay. */
  failedAudioDir: string;
  /** Scratch dir for the intermediate WAV + raw whisper output. Kept OUT of transcriptsDir on purpose,
   *  so the daemon never sees a half-written `.srt`. */
  workDir: string;
};

export function loadRecorderConfig(): RecorderConfig {
  const req = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`recorder: missing required env ${k}`);
    return v;
  };
  const recordingsDir = req("RECORDINGS_DIR");
  return {
    recordingsDir,
    transcriptsDir: req("WATCH_DIR"),
    whisperBin: req("WHISPER_BIN"),
    whisperModel: req("WHISPER_MODEL"),
    whisperLang: process.env.WHISPER_LANG ?? "zh",
    ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
    archiveDir: process.env.ARCHIVE_DIR ?? join(recordingsDir, ".done"),
    failedAudioDir: process.env.FAILED_AUDIO_DIR ?? join(recordingsDir, ".failed-audio"),
    workDir: process.env.RECORDER_WORK_DIR ?? join(recordingsDir, ".work"),
  };
}
