import type { AgentConfig } from "./config";
import { isAnkiReachable } from "./anki";
import { sendHeartbeat } from "./poll";

export type HeartbeatDeps = {
  probe: (url: string) => Promise<boolean>;
  send: (cfg: AgentConfig, hb: { ankiReachable: boolean }) => Promise<void>;
  now: () => number;
};

const DEFAULTS: HeartbeatDeps = {
  probe: isAnkiReachable,
  send: sendHeartbeat,
  now: () => Date.now(),
};

/**
 * A throttled liveness pinger.
 *
 * Called from the poll loop after EVERY successful cycle — not once at boot — because "it started
 * three days ago" says nothing about whether it is still running now, and a boot-only heartbeat is
 * indistinguishable from a crashed process. The throttle keeps that from becoming a Notion write
 * every 5 seconds.
 *
 * `last` advances only after a ping actually lands, so a cloud blip retries on the next cycle rather
 * than opening a `heartbeatMs`-wide hole in the record. Errors propagate: the caller logs them, and
 * nothing here ever pretends a failed ping succeeded.
 */
export function makeHeartbeat(
  cfg: AgentConfig,
  deps: Partial<HeartbeatDeps> = {},
): (force?: boolean) => Promise<boolean> {
  const d = { ...DEFAULTS, ...deps };
  let last = Number.NEGATIVE_INFINITY;
  return async function beat(force = false): Promise<boolean> {
    const t = d.now();
    if (!force && t - last < cfg.heartbeatMs) return false;
    const ankiReachable = await d.probe(cfg.ankiUrl);
    await d.send(cfg, { ankiReachable });
    last = t;
    return true;
  };
}
