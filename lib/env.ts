import { z } from "zod";

const Schema = z.object({
  // AI providers, called DIRECTLY (no Vercel AI Gateway). DeepSeek powers the chat/reason/classify
  // roles and is required — the app can't reason without it. `.min(1)` so an empty key fails at boot
  // rather than 401'ing every model call at runtime.
  DEEPSEEK_API_KEY: z.string().min(1),
  // Google/Gemini powers the long-context + vision roles. Optional: when unset those roles fall back
  // to DeepSeek where they can (see lib/models.ts) and the vision path is simply unavailable. The
  // chat path never needs it — do NOT make the whole app require the Google key.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  // Per-role model overrides (all optional + defaulted in lib/models.ts). Set any to reroute one task
  // to another `deepseek/<id>` or `google/<id>` slug without a code change.
  MODEL_CHAT: z.string().optional(),
  MODEL_REASON: z.string().optional(),
  MODEL_CLASSIFY: z.string().optional(),
  MODEL_LONG: z.string().optional(),
  MODEL_VISION: z.string().optional(),
  // M3 semantic retrieval index (Neon Postgres + pgvector). Both OPTIONAL by design: the retrieval
  // layer is purely ADDITIVE over the Notion source of truth, so an unconfigured index must never
  // break the bot — it silently falls back to today's Notion-only behavior (see lib/retrieval.ts).
  // DATABASE_URL is the Neon connection string (the derived read-index; Notion stays authoritative).
  DATABASE_URL: z.string().optional(),
  // OpenAI key for embeddings (direct call, no gateway). Optional at boot; the embeddings module
  // fails CLOSED with a clear message only when actually invoked without it (ingestion/retrieval),
  // so the app still boots and runs Notion-only when it's unset.
  OPENAI_API_KEY: z.string().optional(),
  // Optional override of the embedding model id. Default is text-embedding-3-small (1536 dims), which
  // MUST match the vector(1536) column — do not point this at a model with different dimensions.
  EMBEDDING_MODEL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  NOTION_EVIDENCE_DB_ID: z.string().min(1),
  NOTION_TODAY_PAGE_ID: z.string().min(1),
  NOTION_DECKS_DB_ID: z.string().min(1),
  NOTION_SYLLABUS_DB_ID: z.string().min(1),
  // The four-doc brain (created by scripts/seed-knowledge.ts):
  NOTION_LEDGER_PAGE_ID: z.string().min(1),
  NOTION_STUDYMAP_PAGE_ID: z.string().min(1),
  NOTION_DAILYLOG_PAGE_ID: z.string().min(1),
  NOTION_GRADEBOOK_PAGE_ID: z.string().min(1),
  // HSK Scorecard doc (created by scripts/setup-notion.ts): computed coverage + teacher checklist.
  NOTION_SCORECARD_PAGE_ID: z.string().min(1),
  NOTION_LESSONS_DB_ID: z.string().min(1),
  NOTION_ACTIONQUEUE_DB_ID: z.string().min(1),
  NOTION_RETAINED_PAGE_ID: z.string().min(1),
  NOTION_ASSIGNMENTS_DB_ID: z.string().min(1),
  NOTION_LISTENING_PAGE_ID: z.string().min(1),
  // .min(1) is load-bearing, not cosmetic: the agent routes authorize on `Bearer ${AGENT_SECRET}`,
  // so an empty secret would let a bare `Authorization: Bearer ` through. Fail at boot instead.
  AGENT_SECRET: z.string().min(1),
  CRON_SECRET: z.string().min(1),
  // Web dashboard single-user gate. Optional: when unset, the dashboard + /api/chat stay locked
  // (fail closed) so Lucy's brain is never exposed unauthenticated. See lib/auth.ts.
  DASHBOARD_PASSWORD: z.string().optional(),
  TIMEZONE: z.string().default("America/Chicago"),
  QUIET_DAYS_THRESHOLD: z.coerce.number().default(2),
});

export type Env = z.infer<typeof Schema>;

/** Parse + validate process.env on every call so tests can mutate env freely. */
export function getEnv(): Env {
  return Schema.parse(process.env);
}

/**
 * Env for a MAINTENANCE SCRIPT that uses a small slice of the app.
 *
 * getEnv() validates the WHOLE schema, and lib/notion calls it on every read and write — so a script
 * that only rewrites two Notion pages could not run without DEEPSEEK_API_KEY, NOTION_SCORECARD_PAGE_ID
 * and every other production var being present. `npm run migrate:brain` was unrunnable for exactly
 * that reason: it died on unrelated missing vars before touching Notion.
 *
 * So: validate the keys the script ACTUALLY uses strictly (missing ones still fail immediately, with
 * their names), then fill any other required key with an inert placeholder purely to satisfy the
 * shared schema when getEnv() is called deep inside lib/notion. Nothing reads those placeholders — a
 * script that used one would be talking to a provider it just declared it doesn't need. Call this
 * BEFORE the first getEnv() (i.e. before any Notion IO).
 */
const SCRIPT_PLACEHOLDER = "unset-not-used-by-this-script";

export function requireEnvForScript<K extends keyof Env>(keys: readonly K[]): Pick<Env, K> {
  const mask = Object.fromEntries(keys.map((k) => [k, true as const]));
  const picked = Schema.pick(mask as never).parse(process.env) as Pick<Env, K>;
  for (const [name, field] of Object.entries(Schema.shape)) {
    if ((keys as readonly string[]).includes(name)) continue;
    if (process.env[name] !== undefined) continue;
    // Required means "rejects undefined" — optional/defaulted fields are left alone.
    if (!field.safeParse(undefined).success) process.env[name] = SCRIPT_PLACEHOLDER;
  }
  return picked;
}
