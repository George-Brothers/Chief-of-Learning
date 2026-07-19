import { getEnv } from "@/lib/env";
import { getQueuedActions } from "@/lib/notion";

export const runtime = "nodejs";

const LOCAL_TYPES = new Set(["create_anki_cards"]);

export async function GET(req: Request): Promise<Response> {
  const env = getEnv();
  if (req.headers.get("authorization") !== `Bearer ${env.AGENT_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const all = await getQueuedActions();
  return Response.json({ tasks: all.filter((t) => LOCAL_TYPES.has(t.type)) });
}
