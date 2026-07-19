import { z } from "zod";
import { runObject } from "./ai";
import { COACH_SYSTEM, DISTILL_LESSON_PROMPT, LESSON_FEEDBACK_PROMPT } from "./prompts";
import { ActionSchema, type Action } from "./actions";
import type { LessonRow } from "./notion";

export const LessonNoteSchema = z.object({
  summary: z.string(),
  vocabIntroduced: z.array(z.object({
    headword: z.string(),
    pinyin: z.string(),
    definition: z.string(),
    example: z.string(),
  })),
  errors: z.array(z.object({
    quote: z.string(),
    kind: z.enum(["tone", "grammar", "vocab", "listening"]),
    correction: z.string(),
  })),
  grammarPoints: z.array(z.string()),
  couldNotSay: z.array(z.string()),
  homeworkAssigned: z.string(),
  durationMinutes: z.number(),
});
export type LessonNote = z.infer<typeof LessonNoteSchema>;

export async function distillLesson(transcript: string): Promise<LessonNote> {
  // Full-transcript compression → long-context role (Gemini Flash).
  return runObject("long", "distill-lesson", {
    schema: LessonNoteSchema,
    system: COACH_SYSTEM,
    prompt: `${DISTILL_LESSON_PROMPT}\n\n=== TRANSCRIPT ===\n${transcript}`,
  });
}

export const LessonFeedbackSchema = z.object({
  feedback: z.string(),
  actions: z.array(ActionSchema),
});
export type LessonFeedbackResult = z.infer<typeof LessonFeedbackSchema>;

export async function runLessonFeedback(ctx: {
  lessons: LessonRow[]; studyMap: string; ledger: string; weekFocus: string;
}): Promise<LessonFeedbackResult> {
  const notes = ctx.lessons
    .map((l) => {
      let extra = "";
      try {
        const n = JSON.parse(l.noteJson) as LessonNote;
        if (n.grammarPoints.length) extra += `\n    grammar: ${n.grammarPoints.join(", ")}`;
        if (n.couldNotSay.length) extra += `\n    couldn't say: ${n.couldNotSay.join("; ")}`;
      } catch {
        // Digest-only fallback if the note JSON is unavailable.
      }
      return `- ${l.date}: ${l.summary}${l.weakSignals ? ` [weak: ${l.weakSignals}]` : ""}${l.homework ? ` [hw: ${l.homework}]` : ""}${extra}`;
    })
    .join("\n");
  // Reasoning feedback → reason role (DeepSeek).
  return runObject("reason", "lesson-feedback", {
    schema: LessonFeedbackSchema,
    system: COACH_SYSTEM,
    prompt: `${LESSON_FEEDBACK_PROMPT}

THIS WEEK'S FOCUS: ${ctx.weekFocus || "(not set)"}

=== LESSON NOTE(S) SINCE LAST BRIEF ===
${notes || "(none)"}

=== STUDY MAP ===
${ctx.studyMap || "(empty)"}

=== KNOWLEDGE LEDGER ===
${ctx.ledger || "(empty)"}`,
  });
}
