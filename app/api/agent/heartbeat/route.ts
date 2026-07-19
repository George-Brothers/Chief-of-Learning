import { getEnv } from "@/lib/env";
import { recordAgentHeartbeat } from "@/lib/notion";

export const runtime = "nodejs";

/**
 * Liveness ping from the laptop agent.
 *
 * The agent has no Notion credentials — it only ever knows CLOUD_URL and AGENT_SECRET — so the write
 * happens here. The timestamp is the SERVER's, not the client's: a laptop with a wrong clock could
 * otherwise report itself alive for the next decade, which is exactly the silent-failure mode this
 * whole route exists to close.
 *
 * `ankiReachable` is the agent's own last probe of AnkiConnect, carried through so the brief and the
 * dashboard can tell "agent down" apart from "agent up, Anki closed" — two very different fixes.
 */
export async function POST(req: Request): Promise<Response> {
  const env = getEnv();
  if (req.headers.get("authorization") !== `Bearer ${env.AGENT_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  let ankiReachable: boolean | undefined;
  try {
    const body = (await req.json()) as { ankiReachable?: unknown };
    if (typeof body?.ankiReachable === "boolean") ankiReachable = body.ankiReachable;
  } catch {
    /* a body-less ping is still a heartbeat */
  }
  const lastSeenIso = new Date().toISOString();
  await recordAgentHeartbeat({ lastSeenIso, ankiReachable });
  return Response.json({ ok: true, lastSeenIso });
}
