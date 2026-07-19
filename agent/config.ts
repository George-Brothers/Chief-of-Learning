import { join } from "node:path";

export type AgentConfig = {
  watchDir: string; cloudUrl: string; secret: string;
  ankiUrl: string; ankiDeck: string; pollMs: number;
  retentionMs: number;
  /** Where pushes that exhausted their retries are parked so no lesson is lost. See agent/deadletter.ts. */
  failedDir: string;
};

export function loadConfig(): AgentConfig {
  const req = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`agent: missing required env ${k}`);
    return v;
  };
  const watchDir = req("WATCH_DIR");
  return {
    watchDir,
    cloudUrl: req("CLOUD_URL").replace(/\/$/, ""),
    secret: req("AGENT_SECRET"),
    failedDir: process.env.FAILED_DIR ?? join(watchDir, ".failed"),
    ankiUrl: process.env.ANKI_URL ?? "http://localhost:8765",
    ankiDeck: process.env.ANKI_DECK ?? "Chinese::Lessons",
    pollMs: Number(process.env.POLL_MS ?? "5000"),
    retentionMs: Number(process.env.RETENTION_MS ?? "1800000"),
  };
}
