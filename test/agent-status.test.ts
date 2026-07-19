import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  classifyHeartbeat,
  cardsQueuedMessage,
  getAgentStatus,
  setHeartbeatReader,
  summarizeCardQueue,
  agentDownAlert,
  queueErrorAlert,
  HEARTBEAT_STALE_MS,
  AGENT_ALERT_STALE_MS,
} from "../lib/agent-status";

// The module now defaults to the real Notion reader, so every test that cares about presence must
// say explicitly which source it is testing against. `null` = "no source", the honest-unknown path.
beforeEach(() => setHeartbeatReader(null));
afterEach(() => setHeartbeatReader(null));

const NOW = Date.parse("2026-07-19T12:00:00Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

describe("classifyHeartbeat", () => {
  it("is offline when nothing has ever checked in", () => {
    expect(classifyHeartbeat(null, NOW)).toEqual({ presence: "offline" });
  });

  it("is online only inside the staleness window", () => {
    expect(classifyHeartbeat({ lastSeenIso: isoAgo(60_000) }, NOW).presence).toBe("online");
    expect(classifyHeartbeat({ lastSeenIso: isoAgo(HEARTBEAT_STALE_MS + 1) }, NOW).presence).toBe("offline");
  });

  it("carries lastSeen and Anki reachability through", () => {
    const s = classifyHeartbeat({ lastSeenIso: isoAgo(1000), ankiReachable: false }, NOW);
    expect(s).toMatchObject({ presence: "online", ankiReachable: false });
    expect(s.lastSeenIso).toBe(isoAgo(1000));
  });

  it("refuses to guess on an unparseable timestamp", () => {
    expect(classifyHeartbeat({ lastSeenIso: "whenever" }, NOW).presence).toBe("unknown");
  });
});

describe("getAgentStatus", () => {
  it("is 'unknown' — never 'online' — with no heartbeat source at all", async () => {
    // The seam can be emptied (in tests, or if a future caller clears it). Emptying it must promise
    // nothing rather than assume a working pipeline.
    expect(await getAgentStatus(NOW)).toEqual({ presence: "unknown" });
  });

  it("uses an installed reader", async () => {
    setHeartbeatReader(async () => ({ lastSeenIso: isoAgo(5_000), ankiReachable: true }));
    expect((await getAgentStatus(NOW)).presence).toBe("online");
  });

  it("degrades to 'unknown' when the reader throws, rather than claiming delivery", async () => {
    setHeartbeatReader(async () => { throw new Error("notion 502"); });
    expect(await getAgentStatus(NOW)).toEqual({ presence: "unknown" });
  });
});

/**
 * The confirmation line that replaced the Pleco .txt on every automatic path. Its whole job is to be
 * TRUE: the cards are in a Notion queue row, and only the local agent can turn that into an Anki
 * note. The Action Queue has never had a single row drained, so a message reading "added to your
 * Anki deck" at enqueue time would be a fabrication.
 */
describe("cardsQueuedMessage", () => {
  const claimsDelivered = (s: string) => /(added to your|now in your|are in your).{0,20}deck/i.test(s);
  const asksForWork = (s: string) => /import|Pleco|\.txt|add (these|them)|type (these|them)/i.test(s);

  it("never claims the cards are in the deck, in ANY state", () => {
    const states = [
      { presence: "online" as const, lastSeenIso: isoAgo(1000), ankiReachable: true },
      { presence: "online" as const, lastSeenIso: isoAgo(1000), ankiReachable: false },
      { presence: "offline" as const, lastSeenIso: isoAgo(3 * 3600_000) },
      { presence: "offline" as const },
      { presence: "unknown" as const },
    ];
    for (const s of states) {
      const m = cardsQueuedMessage(6, s, NOW);
      expect(m).toContain("6 new words");
      expect(claimsDelivered(m), m).toBe(false);
      expect(asksForWork(m), m).toBe(false);
    }
  });

  it("says the cards are waiting, and since when, if the agent is offline", () => {
    const m = cardsQueuedMessage(3, { presence: "offline", lastSeenIso: isoAgo(3 * 3600_000) }, NOW);
    expect(m).toMatch(/waiting/);
    expect(m).toMatch(/not in your deck yet/);
    expect(m).toMatch(/3h ago/);
  });

  it("says the agent has never checked in when there is no lastSeen", () => {
    expect(cardsQueuedMessage(1, { presence: "offline" }, NOW)).toMatch(/hasn't checked in/);
  });

  it("distinguishes agent-up from Anki-closed", () => {
    const up = cardsQueuedMessage(2, { presence: "online", lastSeenIso: isoAgo(1000), ankiReachable: true }, NOW);
    expect(up).toMatch(/should land/);
    const ankiClosed = cardsQueuedMessage(2, { presence: "online", lastSeenIso: isoAgo(1000), ankiReachable: false }, NOW);
    expect(ankiClosed).toMatch(/Anki isn't open/);
  });

  it("admits it cannot see the agent when presence is unknown", () => {
    const m = cardsQueuedMessage(1, { presence: "unknown" }, NOW);
    expect(m).toMatch(/can't see your laptop agent/);
    expect(m).toMatch(/1 new word\b/); // singular, not "1 new words"
  });
});

// ---- The alarm ------------------------------------------------------------------------------

const cardTask = (n: number, status = "queued") => ({
  type: "create_anki_cards",
  status,
  payload: JSON.stringify({ cards: Array.from({ length: n }, (_, i) => ({ headword: `w${i}` })), label: "L4" }),
});

describe("summarizeCardQueue", () => {
  it("counts batches and the cards inside them, ignoring other task types", () => {
    expect(
      summarizeCardQueue([cardTask(7), cardTask(5), { type: "something_else", status: "queued", payload: "{}" }]),
    ).toEqual({ tasks: 2, cards: 12, erroredTasks: 0 });
  });

  it("separates errored batches out of the waiting count", () => {
    expect(summarizeCardQueue([cardTask(3), cardTask(4, "error")])).toEqual({
      tasks: 1,
      cards: 3,
      erroredTasks: 1,
    });
  });

  it("still counts a batch whose payload is unreadable, rather than dropping it", () => {
    // A row we cannot parse is still a real row holding real vocab. Losing it from the count is how
    // work becomes invisible — count the batch and admit to 0 known cards.
    expect(summarizeCardQueue([{ type: "create_anki_cards", status: "queued", payload: "not json" }])).toEqual({
      tasks: 1,
      cards: 0,
      erroredTasks: 0,
    });
  });
});

/**
 * The line that had to exist: for weeks a down agent and a quiet week looked identical. It is
 * computed here — in code — so no prompt can soften it, drop it, or invent it.
 */
describe("agentDownAlert", () => {
  const down = (h: number) => ({ presence: "offline" as const, lastSeenIso: isoAgo(h * 3600_000) });

  it("names the outage length and the exact number of cards stuck behind it", () => {
    const m = agentDownAlert(down(72), { tasks: 2, cards: 12, erroredTasks: 0 }, NOW);
    expect(m).toContain("3 days");
    expect(m).toContain("12 cards are waiting");
    expect(m).toMatch(/Start it/);
  });

  it("says nothing at all when nothing is waiting — a down agent with an empty queue is not a nag", () => {
    expect(agentDownAlert(down(240), { tasks: 0, cards: 0, erroredTasks: 0 }, NOW)).toBeNull();
    expect(agentDownAlert({ presence: "unknown" }, { tasks: 0, cards: 0, erroredTasks: 0 }, NOW)).toBeNull();
  });

  it("says nothing while the agent is checking in, however full the queue is", () => {
    const live = { presence: "online" as const, lastSeenIso: isoAgo(30_000), ankiReachable: true };
    expect(agentDownAlert(live, { tasks: 5, cards: 99, erroredTasks: 0 }, NOW)).toBeNull();
  });

  it("holds fire below the threshold and fires above it", () => {
    const q = { tasks: 1, cards: 4, erroredTasks: 0 };
    const justUnder = { presence: "offline" as const, lastSeenIso: isoAgo(AGENT_ALERT_STALE_MS - 60_000) };
    const justOver = { presence: "offline" as const, lastSeenIso: isoAgo(AGENT_ALERT_STALE_MS + 60_000) };
    expect(agentDownAlert(justUnder, q, NOW)).toBeNull();
    expect(agentDownAlert(justOver, q, NOW)).not.toBeNull();
  });

  it("is louder, not quieter, when the agent has NEVER checked in", () => {
    // Today's real state on this branch. An absent heartbeat must never read as "recently seen".
    const m = agentDownAlert({ presence: "offline" }, { tasks: 1, cards: 6, erroredTasks: 0 }, NOW);
    expect(m).toContain("has never checked in");
    expect(m).toContain("6 cards are waiting");
  });

  it("falls back to batches when the payloads were unreadable", () => {
    const m = agentDownAlert(down(72), { tasks: 2, cards: 0, erroredTasks: 0 }, NOW);
    expect(m).toContain("2 batches of cards are waiting");
  });
});

describe("queueErrorAlert", () => {
  it("surfaces burned batches and names the command that re-drives them", () => {
    const m = queueErrorAlert({ tasks: 0, cards: 0, erroredTasks: 3 });
    expect(m).toContain("3 card batches failed");
    expect(m).toContain("/agent retry");
  });

  it("is silent when nothing has failed", () => {
    expect(queueErrorAlert({ tasks: 4, cards: 9, erroredTasks: 0 })).toBeNull();
  });
});
