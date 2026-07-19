/**
 * What the cloud knows about the local Anki agent — and, from that, how to describe queued cards
 * WITHOUT lying about them.
 *
 * Why this module exists: `enqueueCards` does not put anything in Anki. It writes a row to the
 * Notion Action Queue. The cards only become real when the laptop agent polls that queue AND Anki is
 * open. As of this branch that has never once happened (the Action Queue has zero rows, ever), so a
 * message saying "added to your Anki deck" at enqueue time would be a fabrication — the exact class
 * of bug already caught once here. Every automatic path routes its confirmation through
 * `cardsQueuedMessage` so the claim is decided by code and observed state, not by prose.
 *
 * The heartbeat now EXISTS: the laptop agent POSTs /api/agent/heartbeat on every successful poll
 * cycle and the cloud stores it as one self-updating Notion row (lib/notion.ts). This module reads it
 * through a seam — `setHeartbeatReader` — so tests can drive presence without Notion, and so a
 * heartbeat read that throws degrades to "unknown" rather than to a false "online". The default
 * reader is loaded lazily on first use: nothing in this file needs Notion at import time, which keeps
 * it importable from pure/unit contexts.
 */

export type AgentPresence =
  /** A heartbeat is installed and fresh: the agent is polling right now. */
  | "online"
  /** A heartbeat is installed but stale (or absent): the agent is not running. */
  | "offline"
  /** No heartbeat source is wired up at all — we genuinely do not know. Never claim delivery. */
  | "unknown";

export type Heartbeat = { lastSeenIso: string; ankiReachable?: boolean };
export type AgentStatus = { presence: AgentPresence; lastSeenIso?: string; ankiReachable?: boolean };
export type HeartbeatReader = () => Promise<Heartbeat | null>;

/**
 * The agent polls every 5s (`.env.agent` POLL_MS). Ten minutes of silence is far past any normal
 * jitter, redeploy or Notion hiccup, so treating it as "not running" is honest rather than alarmist.
 */
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;

/**
 * The production source: the heartbeat row in Notion. Imported dynamically so this module has no
 * static Notion dependency — and so a context where Notion is unconfigured or mocked away throws
 * inside `getAgentStatus`'s try, which is already the honest "unknown" path.
 */
const notionHeartbeatReader: HeartbeatReader = async () => {
  const { readAgentHeartbeat } = await import("./notion");
  return readAgentHeartbeat();
};

let reader: HeartbeatReader | null = notionHeartbeatReader;

/** Install (or clear, with `null`) the heartbeat source. `null` forces the honest "unknown". */
export function setHeartbeatReader(r: HeartbeatReader | null): void {
  reader = r;
}

/** Pure: turn a heartbeat (or its absence) into a presence verdict. */
export function classifyHeartbeat(hb: Heartbeat | null, nowMs: number): AgentStatus {
  if (!hb) return { presence: "offline" };
  const seen = Date.parse(hb.lastSeenIso);
  if (!Number.isFinite(seen)) return { presence: "unknown" };
  const fresh = nowMs - seen < HEARTBEAT_STALE_MS && nowMs - seen > -HEARTBEAT_STALE_MS;
  return {
    presence: fresh ? "online" : "offline",
    lastSeenIso: hb.lastSeenIso,
    ankiReachable: hb.ankiReachable,
  };
}

/**
 * Current presence. Fail-safe in the truthful direction: no reader, or a reader that throws, yields
 * "unknown" — never "online".
 */
export async function getAgentStatus(nowMs: number = Date.now()): Promise<AgentStatus> {
  if (!reader) return { presence: "unknown" };
  try {
    return classifyHeartbeat(await reader(), nowMs);
  } catch {
    return { presence: "unknown" };
  }
}

/** "3 minutes ago" / "2 days ago" — coarse on purpose; this is a chat line, not a log. */
function ago(iso: string | undefined, nowMs: number): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

/**
 * The ONE confirmation line for automatically created cards.
 *
 * It replaces the Pleco .txt that every automatic path used to send. The learner's instruction was
 * explicit — "I don't want to get a msg with words to add, I want it to go directly to Anki" — so
 * this is never a file, never a list to type in, and never a chore. It is also never a claim that
 * the cards are in the deck unless a live heartbeat says the agent that puts them there is running,
 * and even then it says "should land", because only the agent's own ✅ report-back (the `notify`
 * ping from /api/agent/tasks/[id]/done) can confirm delivery.
 */
export function cardsQueuedMessage(
  count: number,
  status: AgentStatus,
  nowMs: number = Date.now(),
): string {
  const n = `${count} new word${count === 1 ? "" : "s"}`;
  if (status.presence === "online" && status.ankiReachable !== false) {
    return `📇 ${n} → your Anki deck. The laptop agent is up, so they should land in the next minute — I'll confirm.`;
  }
  if (status.presence === "online") {
    // Agent alive but Anki itself unreachable — the cards wait in the queue, not in the deck.
    return `📇 ${n} queued for Anki. Anki isn't open on your laptop, so they're waiting — they go in as soon as you open it.`;
  }
  if (status.presence === "offline") {
    const last = ago(status.lastSeenIso, nowMs);
    const since = last ? `last checked in ${last}` : `hasn't checked in`;
    return `📇 ${n} queued for Anki — not in your deck yet: the laptop agent ${since}. They're waiting and go in the moment it and Anki are running.`;
  }
  return `📇 ${n} queued for Anki. I can't see your laptop agent from here, so I can't promise they've landed — they're safe in the queue and I'll confirm when they're added.`;
}

// ---- Loud failure: the queue, and the alarm that fires when nothing is draining it ---------------

/** What is sitting in the Action Queue right now, counted in the units the learner thinks in. */
export type CardQueueSummary = {
  /** Queued `create_anki_cards` rows — batches, not cards. */
  tasks: number;
  /** Cards inside those rows. 0 when every payload is unreadable; the task count still stands. */
  cards: number;
  /** Rows that ended in Status "error". Dead until something re-drives them. */
  erroredTasks: number;
};

export const CARD_TASK_TYPE = "create_anki_cards";

/** Pure: fold `getActionRows()` output into the two counts everything else reports. */
export function summarizeCardQueue(
  rows: ReadonlyArray<{ type: string; payload: string; status?: string }>,
): CardQueueSummary {
  let tasks = 0, cards = 0, erroredTasks = 0;
  for (const r of rows) {
    if (r.type !== CARD_TASK_TYPE) continue;
    if (r.status === "error") {
      erroredTasks += 1;
      continue;
    }
    tasks += 1;
    try {
      const parsed = JSON.parse(r.payload) as { cards?: unknown[] };
      if (Array.isArray(parsed?.cards)) cards += parsed.cards.length;
    } catch {
      // An unreadable payload is still a real queued batch. Count the batch, not imaginary cards.
    }
  }
  return { tasks, cards, erroredTasks };
}

/**
 * How long the agent may be silent before the morning message says so.
 *
 * Deliberately far longer than HEARTBEAT_STALE_MS: 10 minutes of silence is a closed lid and is the
 * right threshold for "don't claim these cards just landed", but it is the wrong threshold for
 * shouting in the daily brief. 12 hours means the agent has not been up since roughly the previous
 * brief — that is a real outage, not a laptop asleep overnight, and the cards have missed a day.
 */
export const AGENT_ALERT_STALE_MS = 12 * 60 * 60 * 1000;

/** "14 hours" / "3 days" — the alert only ever fires past 12h, so minutes never need a word. */
function downFor(ms: number): string {
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs < 48) return `${hrs} hours`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * THE alarm. Pure, and owned by code — not by a prompt — precisely so it cannot be paraphrased into
 * something softer or hallucinated on a day when everything is fine.
 *
 * Fires only when BOTH are true: the agent has been silent past the threshold, AND there is work
 * stuck behind it. With an empty queue a down agent costs the learner nothing today, so saying so
 * would be a nag; `null` is returned and the brief carries no extra line at all.
 */
export function agentDownAlert(
  status: AgentStatus,
  queue: CardQueueSummary,
  nowMs: number = Date.now(),
): string | null {
  if (queue.tasks <= 0) return null;
  const seen = status.lastSeenIso ? Date.parse(status.lastSeenIso) : NaN;
  const silentMs = Number.isFinite(seen) ? nowMs - seen : Number.POSITIVE_INFINITY;
  if (silentMs < AGENT_ALERT_STALE_MS) return null;

  const waiting =
    queue.cards > 0
      ? `${queue.cards} card${queue.cards === 1 ? "" : "s"} ${queue.cards === 1 ? "is" : "are"} waiting`
      : `${queue.tasks} batch${queue.tasks === 1 ? "" : "es"} of cards ${queue.tasks === 1 ? "is" : "are"} waiting`;
  const how = Number.isFinite(silentMs)
    ? `has been offline ${downFor(silentMs)}`
    : `has never checked in`;
  return `⚠️ Your Anki agent ${how}; ${waiting}. Start it on your laptop and I'll flush them.`;
}

/**
 * The second half of loud: rows that already FAILED. These close with Status "error" and were, until
 * now, read by nothing — vocab could die in the queue in total silence. This says so, and points at
 * the one command that puts them back.
 */
export function queueErrorAlert(queue: CardQueueSummary): string | null {
  if (queue.erroredTasks <= 0) return null;
  const n = queue.erroredTasks;
  return `⚠️ ${n} card batch${n === 1 ? "" : "es"} failed and ${n === 1 ? "is" : "are"} stuck. Send /agent retry to put ${n === 1 ? "it" : "them"} back in the queue.`;
}
