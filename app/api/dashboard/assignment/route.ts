import { isAuthed } from "@/lib/auth";
import { csrfGuard } from "@/lib/csrf";
import { getOpenAssignments, markAssignmentDone } from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Close an open assignment from the dashboard, through the same markAssignmentDone the Telegram path
 * uses. Same session-cookie gate as /api/chat, plus the same-origin/JSON guard in lib/csrf.ts —
 * SameSite=Lax is not enough on its own (a sibling origin is still "same-site", and it is a browser
 * behaviour the server cannot verify); see the header comment in lib/csrf.ts.
 *
 * The id is checked against the currently-open set before any write: a Notion page id is the only
 * thing needed to mutate a page, so accepting one unverified would turn this into a general-purpose
 * "set Status=done on any page in the workspace" endpoint.
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

  const id = (body as { id?: unknown })?.id;
  if (typeof id !== "string" || !id.trim()) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  try {
    const open = await getOpenAssignments();
    const target = open.find((a) => a.id === id);
    if (!target) return Response.json({ error: "unknown assignment" }, { status: 404 });
    await markAssignmentDone(target.id);
    return Response.json({ ok: true, id: target.id });
  } catch (err) {
    console.error("assignment-done route error", err);
    return Response.json({ error: "could not close that" }, { status: 500 });
  }
}
