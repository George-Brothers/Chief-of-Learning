import type { AgentConfig } from "./config";
import { fetchTasks, completeTask } from "./poll";
import { addCards, type AnkiCard } from "./anki";
import { isConnectivity, isPermanent, isTransient } from "./failure";
import { parkCards } from "./deadletter";

export { isTransient, isPermanent, isConnectivity };

export type TaskOutcome =
  | { id: string; status: "done"; added: number; skipped: number }
  /** Some notes landed, some were refused. The refused ones are parked; the row is closed honestly. */
  | { id: string; status: "partial"; added: number; skipped: number; failed: number; parked: string }
  /** Transient failure: left queued on purpose, so a later drain picks it up. */
  | { id: string; status: "deferred"; error: string }
  /** Provably permanent: burned — but only after the cards are on disk. */
  | { id: string; status: "burned"; error: string; parked: string }
  /** Unexplained and out of attempts: burned, cards on disk, needs a human. */
  | { id: string; status: "dead-lettered"; error: string; parked: string }
  | { id: string; status: "ignored" };

/**
 * How many times an UNEXPLAINED failure is retried before the task is parked and closed.
 *
 * Connectivity failures don't count against this (see below) — a closed Anki is the normal state of
 * a laptop and must retry forever. This budget exists for the failure the audit caught live: with
 * something else answering on the AnkiConnect port, every call returned `404`, which is neither
 * connectivity nor a provable rejection. Retrying it forever would spin silently; burning it on the
 * first try (what the code used to do) destroyed the cards. Bounded retries, then a dead letter.
 */
export const MAX_ATTEMPTS = 5;

/** taskId → consecutive unexplained failures. Cleared on success; in-memory by design (a restart
 *  simply gives the task a fresh budget, which errs toward keeping cards rather than dropping them). */
const attempts = new Map<string, number>();

/**
 * Park a task's cards, then close its queue row. ORDER IS LOAD-BEARING: `markActionDone(ok=false)`
 * writes Status "error" and nothing ever reads the row again, so the disk copy must exist first.
 */
async function parkAndBurn(
  cfg: AgentConfig,
  task: { id: string },
  p: { label?: string; cards: unknown[]; rawPayload?: string },
  reason: string,
): Promise<string> {
  const parked = await parkCards(cfg.failedDir, { taskId: task.id, reason, ...p });
  await completeTask(cfg, task.id, `${reason} — cards parked at ${parked}`, false);
  attempts.delete(task.id);
  return parked;
}

/**
 * Drain the action queue once. Returns what happened to each task so the caller can log it; the
 * queue row itself is the durable state, and this never closes a row without either succeeding or
 * writing the cards somewhere they can be recovered from.
 */
export async function drainTasks(cfg: AgentConfig): Promise<TaskOutcome[]> {
  const out: TaskOutcome[] = [];
  for (const task of await fetchTasks(cfg)) {
    if (task.type !== "create_anki_cards") {
      out.push({ id: task.id, status: "ignored" });
      continue;
    }

    let cards: AnkiCard[];
    let label: string | undefined;
    try {
      const parsed = JSON.parse(task.payload) as { cards?: AnkiCard[]; label?: string };
      cards = parsed.cards ?? [];
      label = parsed.label;
    } catch (e) {
      // A string that isn't JSON never will be. Keep it verbatim so nothing is unrecoverable.
      const error = (e as Error).message;
      const parked = await parkAndBurn(cfg, task, { cards: [], rawPayload: task.payload }, error);
      out.push({ id: task.id, status: "burned", error, parked });
      continue;
    }

    let r: Awaited<ReturnType<typeof addCards>>;
    try {
      r = await addCards(cfg.ankiUrl, cfg.ankiDeck, cards, label);
    } catch (e) {
      const error = (e as Error).message;
      if (isPermanent(e)) {
        const parked = await parkAndBurn(cfg, task, { cards, label }, error);
        out.push({ id: task.id, status: "burned", error, parked });
        continue;
      }
      if (isConnectivity(e)) {
        // Anki closed / laptop asleep. Unlimited retries: leave the row queued, spend no budget.
        out.push({ id: task.id, status: "deferred", error });
        continue;
      }
      // Unexplained (a 404 from the wrong port, a 401, something new). Retry a bounded number of
      // times, then dead-letter rather than either spinning forever or discarding the vocab.
      const n = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, n);
      if (n < MAX_ATTEMPTS) {
        out.push({ id: task.id, status: "deferred", error });
        continue;
      }
      const parked = await parkAndBurn(cfg, task, { cards, label }, `${error} (after ${n} attempts)`);
      out.push({ id: task.id, status: "dead-lettered", error, parked });
      continue;
    }

    attempts.delete(task.id);

    // The cards are in Anki. Reporting completion is a *separate* concern: if that cloud call throws
    // (a Vercel 5xx mid-redeploy), the work already succeeded, so we must never burn the task or fire a
    // false failure. Leave the row "queued" to re-report — addCards is idempotent via findNotes, so the
    // next drain re-adds nothing and just reports again.
    try {
      if (r.failed.length > 0) {
        // Partial success, reported as partial. The refused notes are parked first; `ok:false` means
        // the learner's Telegram ping says ⚠️ with the real numbers instead of a false ✅.
        const parked = await parkCards(cfg.failedDir, {
          taskId: task.id,
          label,
          reason: `refused by Anki: ${r.failed.map((f) => f.error).join("; ")}`,
          cards: r.failed.map((f) => f.card),
        });
        await completeTask(
          cfg, task.id,
          `added ${r.added}, skipped ${r.skipped}, failed ${r.failed.length} (parked at ${parked})`,
          false,
        );
        out.push({ id: task.id, status: "partial", added: r.added, skipped: r.skipped, failed: r.failed.length, parked });
        continue;
      }
      await completeTask(cfg, task.id, `added ${r.added}, skipped ${r.skipped}`, true);
      out.push({ id: task.id, status: "done", added: r.added, skipped: r.skipped });
    } catch (e) {
      out.push({ id: task.id, status: "deferred", error: (e as Error).message });
    }
  }
  return out;
}
