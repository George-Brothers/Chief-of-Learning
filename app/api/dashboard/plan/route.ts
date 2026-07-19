import { isAuthed } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { getEnv } from "@/lib/env";
import { addEvidence, getRecentActivity, readToday } from "@/lib/notion";
import {
  completedPlanBlockIds,
  parseTodayPlan,
  planBlockLabel,
  PLAN_DONE_SUMMARY_PREFIX,
} from "@/lib/dashboard";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Tick a block of today's plan off the dashboard. This writes to the SAME Evidence Inbox the Telegram
 * path writes to, so a checked box is indistinguishable from texting Lucy "did it" — tomorrow's brief
 * sees the evidence and stops carrying the task.
 *
 * The client sends only a block id: the route re-reads the Today page and resolves the id against the
 * parsed plan itself, so the text that lands in Notion is always Lucy's own, never whatever a caller
 * chose to post. Auth is the same session-cookie gate as /api/chat — the Evidence Inbox is the
 * owner's brain and must never be writable unauthenticated.
 *
 * IDEMPOTENT per block per day. The tick has no state of its own: it is a row in an append-only
 * inbox, so a second POST for the same block would append a second "Done: …" row, and the brief and
 * scorecard read that stream as a count of things the learner did. Re-ticking (a reload, a double
 * tap, a retry after a timeout that actually succeeded) must therefore be a no-op, not a write. The
 * check is scoped to the learner's local day for the same reason `completedPlanBlockIds` is — the
 * same post-it line legitimately recurs tomorrow and must be tickable again.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });
  const forged = csrfGuard(req);
  if (forged) return forged;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const blockId = (body as { blockId?: unknown })?.blockId;
  if (typeof blockId !== "string" || !blockId.trim()) {
    return Response.json({ error: "blockId required" }, { status: 400 });
  }

  try {
    const plan = parseTodayPlan(await readToday());
    const block = plan.blocks.find((b) => b.id === blockId);
    if (!block) return Response.json({ error: "unknown block" }, { status: 404 });

    const now = new Date();
    // Not fail-soft on purpose: if the inbox can't be read, we cannot know whether this is a repeat,
    // and a 500 the learner can retry is better than a duplicate row that silently inflates his log.
    const already = completedPlanBlockIds(await getRecentActivity(30), now, getEnv().TIMEZONE);
    // Already logged today: report success (the box IS ticked) without a second row.
    if (already.includes(block.id)) return Response.json({ ok: true, block, alreadyLogged: true });

    const label = planBlockLabel(block);
    await addEvidence({
      type: "check-in",
      rawText: `Done: ${label}`,
      source: "dashboard",
      // Shaped like DistilledSchema so the daily brief folds it in without a second model call.
      distilled: JSON.stringify({
        type: "check-in",
        // The prefix is the read side's only handle on its own writes — see PLAN_DONE_SUMMARY_PREFIX.
        summary: `${PLAN_DONE_SUMMARY_PREFIX}${label}`,
        newVocab: [],
        weakSignals: [],
      }),
    });
    return Response.json({ ok: true, block });
  } catch (err) {
    console.error("plan-done route error", err);
    return Response.json({ error: "could not record that" }, { status: 500 });
  }
}
