import { isAuthed } from "@/lib/auth";
import { respondToMessage } from "@/lib/webchat";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Talk-to-Lucy web chat. Gated behind the single-user session cookie, then runs the SAME brain the
 * Telegram webhook uses (see lib/webchat). Never expose this unauthenticated — it reads and writes
 * the owner's Notion and spends model tokens.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const message = (body as { message?: unknown })?.message;
  if (typeof message !== "string" || !message.trim()) {
    return Response.json({ error: "message required" }, { status: 400 });
  }

  try {
    const { reply, handledAs } = await respondToMessage(message);
    return Response.json({ reply, handledAs });
  } catch (err) {
    console.error("chat route error", err);
    return Response.json(
      { reply: "Something broke on my end. Try that again in a sec." },
      { status: 500 },
    );
  }
}
