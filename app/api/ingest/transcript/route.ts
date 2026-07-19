import { getEnv } from "@/lib/env";
import { distillLesson } from "@/lib/lesson";
import { lessonExists, addLesson } from "@/lib/notion";
import { enqueueCards } from "@/lib/actions";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  const env = getEnv();
  if (req.headers.get("authorization") !== `Bearer ${env.AGENT_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = (await req.json()) as { markdown?: string; hash?: string; date?: string };
  const markdown = body.markdown ?? "";
  const hash = body.hash ?? "";
  if (!markdown || !hash) return new Response("bad request", { status: 400 });

  if (await lessonExists(hash)) return Response.json({ ok: true, skipped: true });

  const note = await distillLesson(markdown);
  const date = body.date ?? new Date().toISOString().slice(0, 10);
  const lessonId = await addLesson({
    date,
    hash,
    summary: note.summary,
    weakSignals: note.errors.map((e) => `${e.kind}: ${e.quote} → ${e.correction}`).join("; "),
    homework: note.homeworkAssigned,
    vocabCount: note.vocabIntroduced.length,
    noteJson: JSON.stringify(note),
    transcript: markdown,
  });

  // enqueueCards is the shared producer: it de-dupes against what is already carded, normalises a
  // missing example, and sets notify:true — which is what makes the done route report back (it gates
  // on payload.notify). Without that report-back this path — the primary lesson pipeline — failed
  // silently: cards could vanish with no signal to anyone. Nobody is watching this enqueue happen, so
  // it needs the report-back *more* than the /cards command does, not less.
  await enqueueCards(note.vocabIntroduced, `lesson ${date}`);
  return Response.json({ ok: true, lessonId });
}
