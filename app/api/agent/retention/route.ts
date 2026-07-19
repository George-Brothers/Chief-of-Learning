import { getEnv } from "@/lib/env";
import { writeRetained } from "@/lib/notion";
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response> {
  const env = getEnv();
  if (req.headers.get("authorization") !== `Bearer ${env.AGENT_SECRET}`) return new Response("unauthorized", { status: 401 });
  const body = (await req.json()) as { words?: string[] };
  const words = Array.isArray(body.words) ? body.words.filter((w) => typeof w === "string" && w.trim()) : [];
  await writeRetained(words.join(" "));
  return Response.json({ ok: true, count: words.length });
}
