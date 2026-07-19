import { join } from "node:path";

export type AgentConfig = {
  watchDir: string; cloudUrl: string; secret: string;
  ankiUrl: string; ankiDeck: string; pollMs: number;
  retentionMs: number;
  /** Minimum gap between liveness pings to the cloud. See agent/index.ts. */
  heartbeatMs: number;
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
    // 8765 is AnkiConnect's stock port but it is TAKEN on this machine by another local service that
    // answers 404 to everything — which is precisely the failure that used to burn queue rows. The
    // defaults here mirror .env.agent so a missing env var degrades to the right place, not the trap.
    ankiUrl: process.env.ANKI_URL ?? "http://localhost:8766",
    ankiDeck: process.env.ANKI_DECK ?? "Chinese::Lucy",
    pollMs: Number(process.env.POLL_MS ?? "5000"),
    retentionMs: Number(process.env.RETENTION_MS ?? "1800000"),
    // Optional, and defaulted: the poll loop runs every 5s, but one Notion write per 5s purely to say
    // "still here" would be most of this agent's API budget. A minute of resolution is far finer than
    // the 12h the brief alerts on and the 10min the "did these cards land" wording uses.
    heartbeatMs: Number(process.env.HEARTBEAT_MS ?? "60000"),
  };
}
