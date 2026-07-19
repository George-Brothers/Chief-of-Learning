/**
 * Live model-routing verification for the direct-provider setup (post-gateway).
 *
 * Confirms that EVERY structured-output path produces a schema-valid object against the real models —
 * the #1 risk of moving off Claude (DeepSeek/Gemini are less bulletproof than Claude on deeply nested
 * Zod schemas). The primary model per role is constructed exactly as the app does, via lib/models.ts.
 *
 * This is intentionally NOT part of `npm test` (it costs money and needs live provider access).
 * Run it on demand:
 *
 *   DEEPSEEK_API_KEY=... npx tsx scripts/verify-models.ts
 *   # add the Google key to also exercise the vision / long-context (Gemini) role:
 *   DEEPSEEK_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... npx tsx scripts/verify-models.ts
 *   # optional: exercise the vision path against a real screenshot/photo
 *   DEEPSEEK_API_KEY=... GOOGLE_GENERATIVE_AI_API_KEY=... npx tsx scripts/verify-models.ts ./materials/sample-srs.jpg
 *
 * Exit code is non-zero if any path fails to produce a valid object.
 */
import { readFileSync } from "node:fs";
import { generateObject, generateText, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { modelsFor, slugFor, type Role } from "../lib/models";
import { DistilledSchema, DailySchema, WeeklySchema } from "../lib/ai";
import { LessonNoteSchema, LessonFeedbackSchema } from "../lib/lesson";
import { COACH_SYSTEM } from "../lib/prompts";
// Imported, not re-declared: these used to be inlined here "to stay free of command.ts's module-load
// imports", and the copy silently rotted (it still listed a long-dead "other" intent, so the script
// was verifying a schema the app no longer uses). command.ts reads env lazily via getEnv(), so
// importing it costs nothing at module load and the check now runs against the real schemas.
import { IntentSchema, CardsResultSchema } from "../lib/command";

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error("Set DEEPSEEK_API_KEY (and optionally GOOGLE_GENERATIVE_AI_API_KEY) to verify live.");
}

let failures = 0;
/** The primary model for a role, constructed exactly as the app does (skips unconfigured providers). */
const model = (role: Role): LanguageModel => modelsFor(role)[0];

async function runObject(role: Role, schema: z.ZodTypeAny, prompt: string | ModelMessage[]): Promise<unknown> {
  const base = { model: model(role), schema, system: COACH_SYSTEM };
  const { object } = await generateObject(
    typeof prompt === "string" ? { ...base, prompt } : { ...base, messages: prompt },
  );
  return object;
}

async function exercise(name: string, fn: () => Promise<unknown>): Promise<void> {
  process.stdout.write(`  ${name} … `);
  try {
    const obj = await fn();
    console.log(`✓  keys: ${Object.keys(obj as object).join(", ")}`);
  } catch (err) {
    failures++;
    console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const hasGoogle = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  console.log(`\nConfigured role → model:`);
  for (const role of ["chat", "reason", "classify", "long", "vision"] as Role[]) {
    console.log(`  ${role.padEnd(9)} ${slugFor(role)}`);
  }
  if (!hasGoogle) console.log("(GOOGLE_GENERATIVE_AI_API_KEY unset — long falls back to DeepSeek; vision is skipped)");

  const imagePath = process.argv[2];
  console.log(`\nExercising every generateObject / generateText path:`);

  // vision (DistilledSchema) — only when the Google key is present (it's the sole vision provider).
  if (hasGoogle) {
    await exercise("distillEvidence (vision)", () => {
      const content: Array<
        { type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }
      > = [
        { type: "text", text: "Distill this study check-in into the schema." },
        { type: "text", text: "Did 30 min of characters today; tones on 忙 still shaky." },
      ];
      if (imagePath) {
        content.push({ type: "image", image: new Uint8Array(readFileSync(imagePath)), mediaType: "image/jpeg" });
      } else {
        console.log("(text-only — pass an image path as argv[1] to exercise real OCR) ");
      }
      return runObject("vision", DistilledSchema, [{ role: "user", content }]);
    });
  }

  await exercise("answerQuestion (chat)", async () => {
    const { text } = await generateText({
      model: model("chat"),
      system: COACH_SYSTEM,
      prompt: "Learner asks: what's the difference between 了 and 过? Answer in ≤3 lines with one example.",
    });
    return { text };
  });

  await exercise("classifyCommand (classify)", () =>
    runObject("classify", IntentSchema, "Classify intent.\n\nMESSAGE: make me lesson 5 flashcards"));

  await exercise("buildCardsForRequest (reason)", () =>
    runObject("reason", CardsResultSchema, "Make 3 HSK1 flashcards for hobbies. Give source, label, cards."));

  await exercise("runDailyCoach (reason)", () =>
    runObject("reason", DailySchema, "Write today's post-it, a Daily Log entry, newVocab, and ledgerNotes for an HSK1 learner who studied 40 min."));

  await exercise("runWeeklyReview (long)", () =>
    runObject("long", WeeklySchema, "Write a weekly report, weekFocus, gradebookUpdate, and scorecardChecklist for an HSK1 learner after a 3-day week."));

  await exercise("distillLesson (long)", () =>
    runObject("long", LessonNoteSchema, "Distill this lesson transcript into the note schema:\nTutor reviewed hobbies, practiced 喜欢, corrected 你是喜欢跳舞 → 你喜欢跳舞. HW: 5 sentences with 喜欢. 55 min."));

  await exercise("runLessonFeedback (reason)", () =>
    runObject("reason", LessonFeedbackSchema, "Give post-lesson feedback (≤4 lines, one phrase tag) plus any typed actions for a learner who keeps putting 是 before verbs."));

  console.log(`\n${failures === 0 ? "✓ ALL PATHS PASSED" : `✗ ${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
