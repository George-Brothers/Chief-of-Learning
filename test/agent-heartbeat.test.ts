import { describe, it, expect, vi } from "vitest";
import { makeHeartbeat } from "../agent/heartbeat";
import type { AgentConfig } from "../agent/config";

const cfg = {
  ankiUrl: "http://localhost:8766",
  heartbeatMs: 60_000,
} as AgentConfig;

function harness(over: { probe?: () => Promise<boolean>; send?: () => Promise<void> } = {}) {
  let t = 1_000_000;
  const send = vi.fn(over.send ?? (async () => {}));
  const probe = vi.fn(over.probe ?? (async () => true));
  const beat = makeHeartbeat(cfg, { send, probe, now: () => t });
  return { beat, send, probe, advance: (ms: number) => (t += ms) };
}

/**
 * The heartbeat is the whole difference between "the agent has been down for a week" and "there was
 * nothing to study this week". These tests pin the two properties that make it trustworthy: it keeps
 * firing while the process lives, and it never records a ping that didn't land.
 */
describe("makeHeartbeat", () => {
  it("pings on the first cycle and reports whether Anki answered", async () => {
    const { beat, send, probe } = harness({ probe: async () => false });
    expect(await beat()).toBe(true);
    expect(probe).toHaveBeenCalledWith("http://localhost:8766");
    expect(send).toHaveBeenCalledWith(cfg, { ankiReachable: false });
  });

  it("throttles the 5-second poll loop down to one ping per heartbeat window", async () => {
    const { beat, send, advance } = harness();
    await beat();
    for (let i = 0; i < 11; i++) {
      advance(5_000);
      await beat();
    }
    expect(send).toHaveBeenCalledTimes(1);
    advance(5_000); // now 60s past the first ping
    await beat();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps beating for the life of the process, not just once at boot", async () => {
    // A boot-only heartbeat is indistinguishable from a crashed process, which is the exact failure
    // being closed here.
    const { beat, send, advance } = harness();
    for (let i = 0; i < 5; i++) {
      await beat();
      advance(cfg.heartbeatMs);
    }
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("does not treat a FAILED ping as a ping — it retries on the very next cycle", async () => {
    let fail = true;
    const send = vi.fn(async () => {
      if (fail) throw new Error("cloud 503");
    });
    const { beat, advance } = harness({ send });
    await expect(beat()).rejects.toThrow("cloud 503");
    fail = false;
    advance(1_000); // well inside the throttle window
    expect(await beat()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("can be forced past the throttle", async () => {
    const { beat, send } = harness();
    await beat();
    expect(await beat(true)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
