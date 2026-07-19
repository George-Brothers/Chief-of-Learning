import { generateObject, generateText, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { getEnv } from "./env";
import { modelsFor, type Role } from "./models";
import type { VocabCard } from "./pleco";
import {
  COACH_SYSTEM,
  DISTILL_PROMPT,
  DAILY_PROMPT,
  WEEKLY_PROMPT,
} from "./prompts";

const VocabSchema = z.object({
  headword: z.string(),
  pinyin: z.string(),
  definition: z.string(),
  traditional: z.string().optional(),
  // An Anki card back is `pinyin — definition` plus this. Without the field the photo/daily paths
  // could only ever produce cards whose back read "…\n\nundefined"; optional because plenty of words
  // (a bare noun off a tutor slide) have no natural example, and an invented one teaches nothing.
  example: z.string().optional(),
});

export const DistilledSchema = z.object({
  type: z.enum(["lesson-note", "homework", "check-in", "srs-screenshot", "question"]),
  summary: z.string(),
  newVocab: z.array(VocabSchema),
  weakSignals: z.array(z.string()),
});
export type Distilled = z.infer<typeof DistilledSchema>;

export const DailySchema = z.object({
  todayPostit: z.string(),
  dailyLogEntry: z.string(),
  newVocab: z.array(VocabSchema),
  ledgerNotes: z.array(z.string()),
});
export type DailyResult = z.infer<typeof DailySchema>;

export const WeeklySchema = z.object({
  weeklyReport: z.string(),
  weekFocus: z.string(),
  gradebookUpdate: z.string(),
  scorecardChecklist: z.string(),
});
export type WeeklyResult = z.infer<typeof WeeklySchema>;

// --- Provider wrapper: model selection + fallback + retry, in one place ---------------------
//
// Every model call in the app goes through runObject/runText. They centralize:
//   - role → slug routing (lib/models.ts, env-overridable),
//   - provider fallback: the role's models (primary → fallbacks) are tried in order — this is now
//     done in code, since the direct providers have no gateway-native `models` failover,
//   - a small jittered retry per model for transient / JSON-schema failures.
// This is also what closes the audit's missing retry/fallback gap (P1-4).
//
// `feature` is retained on the call sites (and for future telemetry) but is no longer a gateway
// spend tag — direct providers bill on their own dashboards.

type PromptArgs = { system?: string; prompt?: string; messages?: ModelMessage[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying up to `attempts` times with a small jittered backoff on any error. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep((100 + Math.floor(Math.random() * 200)) * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * Run `fn` across the role's models (primary → fallbacks from lib/models.ts). Each model gets the
 * jittered retry; only after it exhausts its retries do we fall to the next provider. Preserves M1's
 * retry + provider failover now that the gateway's native model-level fallback is gone.
 */
async function withModelFallback<T>(role: Role, fn: (model: LanguageModel) => Promise<T>): Promise<T> {
  const models = modelsFor(role);
  let lastErr: unknown;
  for (const model of models) {
    try {
      return await withRetry(() => fn(model));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function runObject<S extends z.ZodTypeAny>(
  role: Role,
  feature: string,
  args: { schema: S } & PromptArgs,
): Promise<z.infer<S>> {
  getEnv();
  void feature;
  const { object } = await withModelFallback(role, (model) =>
    args.messages !== undefined
      ? generateObject({ model, schema: args.schema, system: args.system, messages: args.messages })
      : generateObject({ model, schema: args.schema, system: args.system, prompt: args.prompt ?? "" }),
  );
  return object;
}

export async function runText(role: Role, feature: string, args: PromptArgs): Promise<string> {
  getEnv();
  void feature;
  const { text } = await withModelFallback(role, (model) =>
    args.messages !== undefined
      ? generateText({ model, system: args.system, messages: args.messages })
      : generateText({ model, system: args.system, prompt: args.prompt ?? "" }),
  );
  return text;
}

/**
 * Compact one-line-per-item digest of evidence — keeps prompts (and cost) small vs raw JSON.
 * New vocab is already captured in decks/ledger at ingestion, so it's omitted here.
 */
function digestEvidence(items: Distilled[], max = 40): string {
  if (!items.length) return "(nothing new)";
  return items
    .slice(0, max)
    .map((e) => `- ${e.type}: ${e.summary}${e.weakSignals.length ? ` [weak: ${e.weakSignals.join("; ")}]` : ""}`)
    .join("\n");
}

// --- Evidence distillation (vision + text) -------------------------------------------

/**
 * Distills one piece of evidence, routing by input modality:
 *   - text-only check-ins → the `reason` role (DeepSeek), so the bot's default fall-through works
 *     with only DEEPSEEK_API_KEY and never needs the optional Google key,
 *   - homework photos + Pleco SRS screenshots → the `vision` role (Gemini Flash), the ONE multimodal
 *     path (no fallback — a non-multimodal model would hallucinate on an image).
 * An image is passed as raw bytes, NOT a URL — the Telegram file URL embeds the bot token, and
 * sending that URL would leak the token to a third-party provider (audit P2-2).
 */
export async function distillEvidence(input: {
  text?: string;
  image?: { data: Uint8Array; mediaType: string };
}): Promise<Distilled> {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }
  > = [{ type: "text", text: DISTILL_PROMPT }];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.image) content.push({ type: "image", image: input.image.data, mediaType: input.image.mediaType });

  return runObject(input.image ? "vision" : "reason", "distill-evidence", {
    schema: DistilledSchema,
    system: COACH_SYSTEM,
    messages: [{ role: "user", content }],
  });
}

// --- Live question answering (scoped to the learner's level) -------------------------

export async function answerQuestion(question: string, brainContext: string): Promise<string> {
  return runText("chat", "answer-question", {
    system: COACH_SYSTEM,
    prompt: `Here is what you know about where the learner is right now:\n${brainContext}\n\nThey ask: ${question}\n\nAnswer concisely and at their level (approaching HSK 1). Give an example they can actually use. If it's off-topic, answer in one line then point them back to studying.`,
  });
}

// --- Daily coach: today's post-it + Daily Log entry ----------------------------------

export type DailyContext = {
  dailyLog: string;
  studyMap: string;
  ledger: string;
  weekFocus: string;
  scorecard: string; // computed HSK coverage block + next-words sample
  dayNote: string; // e.g. "Today is a lesson day (class tonight)."
  evidence: Distilled[];
  openAssignments?: string; // open Assignments rows, one "- [kind] description" per line
  budgetMinutes: number; // today's real self-study budget (lib/rhythm.ts studyPlanShape)
  listeningOptions?: string; // named, real listening sources picked by code — one per line
};

export async function runDailyCoach(ctx: DailyContext): Promise<DailyResult> {
  return runObject("reason", "daily-coach", {
    schema: DailySchema,
    system: COACH_SYSTEM,
    prompt: `${DAILY_PROMPT}

THIS WEEK'S FOCUS (from the head teacher): ${ctx.weekFocus || "(not set yet)"}
${ctx.dayNote}
TODAY'S TIME BUDGET: ${ctx.budgetMinutes} minutes of self-study.

=== TODAY'S LISTENING OPTIONS (real, pick from these only) ===
${ctx.listeningOptions || "(none available today — do not invent listening material)"}

=== DAILY LOG (newest first) ===
${ctx.dailyLog || "(empty — first day)"}

=== STUDY MAP ===
${ctx.studyMap || "(empty)"}

=== KNOWLEDGE LEDGER ===
${ctx.ledger || "(empty)"}

=== HSK SCORECARD (computed) ===
${ctx.scorecard || "(not computed yet)"}

=== NEW EVIDENCE SINCE YESTERDAY ===
${digestEvidence(ctx.evidence)}

=== OPEN ASSIGNMENTS (nag only these) ===
${ctx.openAssignments || ""}`,
  });
}

// --- Weekly head-teacher review (Sundays, long-context) ------------------------------

export type WeeklyContext = {
  weekLog: string;
  gradebook: string;
  ledger: string;
  scorecard: string; // computed HSK coverage block
  grammarPoints: string; // canonical HSK 1–3 grammar list (checklist anchor)
  evidence: Distilled[];
};

export async function runWeeklyReview(ctx: WeeklyContext): Promise<WeeklyResult> {
  // Long-context role (Gemini Flash primary, DeepSeek fallback — and DeepSeek-only until the Google
  // key is wired); the wrapper handles retry + failover, so the old Opus→Sonnet try/catch is gone.
  return runObject("long", "weekly-review", {
    schema: WeeklySchema,
    system: COACH_SYSTEM,
    prompt: `${WEEKLY_PROMPT}

=== LAST 7 DAYS — DAILY LOG ===
${ctx.weekLog || "(empty)"}

=== GRADEBOOK ===
${ctx.gradebook || "(empty)"}

=== KNOWLEDGE LEDGER ===
${ctx.ledger || "(empty)"}

=== HSK SCORECARD (computed) ===
${ctx.scorecard || "(not computed yet)"}

=== CANONICAL HSK 1–3 GRAMMAR POINTS (fill each one's state) ===
${ctx.grammarPoints || "(none)"}

=== THIS WEEK'S EVIDENCE ===
${digestEvidence(ctx.evidence)}`,
  });
}

export type { VocabCard };
