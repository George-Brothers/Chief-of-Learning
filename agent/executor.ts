import type { AgentConfig } from "./config";
import { fetchTasks, completeTask } from "./poll";
import { addCards, type AnkiCard } from "./anki";

export type TaskOutcome =
  | { id: string; status: "done"; added: number; skipped: number }
  /** Transient failure: left queued on purpose, so a later drain picks it up. */
  | { id: string; status: "deferred"; error: string }
  /** Permanent failure: burned, because no amount of retrying would change the outcome. */
  | { id: string; status: "burned"; error: string }
  | { id: string; status: "ignored" };

/**
 * Is this failure worth another attempt?
 *
 * The distinction is the whole point of the fix: `markActionDone(ok=false)` writes status "error",
 * and `getQueuedActions()` only ever returns "queued" rows — there is no path back. Burning a task
 * is therefore permanent and must be reserved for failures that can never succeed.
 *
 * Anki being closed is the *normal* case on a laptop, not a defect: AnkiConnect refuses the
 * connection, fetch throws, and the cards would be gone forever. That's transient. A payload Anki
 * actively rejects (a malformed note, a missing model) fails identically on every attempt, so it burns.
 */
export function isTransient(e: unknown): boolean {
  const err = e as { message?: string; cause?: { code?: string } };
  const code = err?.cause?.code ?? "";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  const m = err?.message ?? "";
  // fetch() rejects with a bare "fetch failed" when Anki isn't listening at all.
  if (/fetch failed|network|socket hang up|ECONNREFUSED|ETIMEDOUT|timeout/i.test(m)) return true;
  // AnkiConnect reachable but unhappy (`anki <action> failed: 5xx`) — its own transient tier.
  return /anki \w+ failed: 5\d\d/i.test(m);
}

/**
 * Drain the action queue once. Returns what happened to each task so the caller can log it; the
 * queue row itself is the durable state, and this never burns a task it could retry instead.
 */
export async function drainTasks(cfg: AgentConfig): Promise<TaskOutcome[]> {
  const out: TaskOutcome[] = [];
  for (const task of await fetchTasks(cfg)) {
    if (task.type !== "create_anki_cards") {
      out.push({ id: task.id, status: "ignored" });
      continue;
    }
    let r: { added: number; skipped: number };
    try {
      const { cards } = JSON.parse(task.payload) as { cards: AnkiCard[] };
      r = await addCards(cfg.ankiUrl, cfg.ankiDeck, cards);
    } catch (e) {
      const error = (e as Error).message;
      if (isTransient(e)) {
        // Leave the row "queued" — untouched state is the retry. Open Anki and the cards land.
        out.push({ id: task.id, status: "deferred", error });
        continue;
      }
      await completeTask(cfg, task.id, error, false);
      out.push({ id: task.id, status: "burned", error });
      continue;
    }
    // The cards are in Anki. Reporting completion is a *separate* concern: if that cloud call throws
    // (a Vercel 5xx mid-redeploy), the work already succeeded, so we must never burn the task or fire a
    // false failure. Leave the row "queued" to re-report — addCards is idempotent via findNotes, so the
    // next drain re-adds nothing and just reports again.
    try {
      await completeTask(cfg, task.id, `added ${r.added}, skipped ${r.skipped}`, true);
      out.push({ id: task.id, status: "done", added: r.added, skipped: r.skipped });
    } catch (e) {
      out.push({ id: task.id, status: "deferred", error: (e as Error).message });
    }
  }
  return out;
}
