/**
 * Failure classification for the card pipeline — shared by agent/anki.ts (per-card quarantine) and
 * agent/executor.ts (retry / dead-letter), which is why it lives in its own module rather than in
 * either of them.
 *
 * THE RULE IS INVERTED FROM WHAT IT USED TO BE. The old classifier asked "is this transient?" and
 * answered yes only for a connection error or an `anki <action> failed: 5xx`. Everything else — a
 * 404 because something else owns the port, a 401, a proxy's 502-shaped-as-404, an error message
 * nobody had seen before — was treated as permanent, and permanent means `completeTask(ok=false)`
 * → Notion Status "error" → `getQueuedActions()` never returns the row again → the cards are gone.
 * There is no path back from "error", so that classification destroys work.
 *
 * So the question is now "can we PROVE this will fail identically forever?". Only a small allowlist
 * of payload rejections can. Everything else retries, and (see the executor) anything unexplained
 * gets a bounded number of attempts and is then parked on disk rather than dropped.
 */

type ErrLike = { message?: string; name?: string; cause?: { code?: string } };

const NET_CODES = [
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
];

/**
 * A failure that is purely "the other end isn't there right now": Anki closed, laptop asleep, the
 * host mid-restart. On a laptop this is the NORMAL state, not a defect, so these retry forever and
 * must never consume the bounded attempt budget.
 */
export function isConnectivity(e: unknown): boolean {
  const err = e as ErrLike;
  if (NET_CODES.includes(err?.cause?.code ?? "")) return true;
  const m = err?.message ?? "";
  if (/fetch failed|network error|socket hang up|connect(ion)? (refused|reset)|timed? ?out/i.test(m)) return true;
  // AnkiConnect (or a proxy in front of it) reachable but erroring server-side.
  return /failed: 5\d\d/i.test(m);
}

/**
 * Payloads Anki rejects the same way on every attempt. Deliberately short and literal: anything not
 * on this list is retried, because a wrong "permanent" verdict costs the learner their vocab while a
 * wrong "transient" verdict costs only a few pointless HTTP calls before the dead-letter catches it.
 */
const PERMANENT_PATTERNS = [
  /cannot create note because it is (a duplicate|empty)/i,
  /model (was )?not found/i,
  /^model '.*' not found/i,
  /\bmodel\b.*\bnot found\b/i,
  /field .* not found/i,
];

export function isPermanent(e: unknown): boolean {
  // NOTE: there is deliberately no rule here for a JSON parse failure.
  //
  // There used to be (`err.name === "SyntaxError"` → permanent), written for the one case where it
  // is true: a task PAYLOAD WE stored that isn't JSON never will be. But this module is shared, and
  // `ankiInvoke` parses the RESPONSE of a remote service with the same primitive — so anything
  // answering the Anki port with `200` + non-JSON (exactly what the service squatting on the old
  // port did) raised a SyntaxError, was classified permanent, and burned the queue row on attempt 1
  // with zero retries. A malformed answer from a remote process is a TRANSPORT failure: the same
  // request can succeed the moment the right service is listening, so it must be retried (and, if
  // it never recovers, dead-lettered by the executor's attempt budget — never silently destroyed).
  //
  // The genuinely permanent case keeps its own handling AT ITS CALL SITE (agent/executor.ts parses
  // task.payload in its own try/catch and burns there without consulting this function), which is
  // where the distinction between "our stored payload" and "their response" actually exists.
  if (isConnectivity(e)) return false;
  const err = e as ErrLike;
  const m = err?.message ?? "";
  return PERMANENT_PATTERNS.some((p) => p.test(m));
}

/** The fail-safe default: retry unless we can prove retrying is pointless. */
export function isTransient(e: unknown): boolean {
  return !isPermanent(e);
}
