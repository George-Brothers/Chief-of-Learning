import { getEnv } from "@/lib/env";
import { markActionDone, getAction } from "@/lib/notion";
import { sendMessage } from "@/lib/telegram";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const env = getEnv();
  if (req.headers.get("authorization") !== `Bearer ${env.AGENT_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const { id } = await ctx.params;
  const body = (await req.json()) as { result?: string; ok?: boolean };
  const ok = body.ok ?? true;
  await markActionDone(id, body.result ?? "", ok);

  // Two-stage report-back: ping the learner if this was a command they're waiting on.
  try {
    const action = await getAction(id);
    const payload = action ? (JSON.parse(action.payload || "{}") as { notify?: boolean; label?: string }) : {};
    if (payload.notify) {
      const label = payload.label ?? "your cards";
      const msg = ok
        ? `✅ ${label} — ${body.result || "done"}`
        : `⚠️ ${label} — failed: ${body.result || "error"}`;
      await sendMessage(env.TELEGRAM_ALLOWED_CHAT_ID, msg);
    }
  } catch {
    /* notify is best-effort; never fail the request over it */
  }
  return Response.json({ ok: true });
}
