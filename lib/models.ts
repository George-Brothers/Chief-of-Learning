import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getEnv } from "./env";

/**
 * Single source of truth for model routing.
 *
 * Roles, not versions: call sites pick a *role* (chat/reason/classify/long/vision) and this module
 * maps it to a concrete `provider/model-id` slug, then constructs the model against the provider's
 * DIRECT API (not the Vercel AI Gateway). Slugs drift, so each role is overridable via an env var and
 * the defaults live in one place — swapping a model is an env change.
 *
 * Providers are the AI SDK's direct DeepSeek + Google + OpenAI packages, keyed by `DEEPSEEK_API_KEY`,
 * `GOOGLE_GENERATIVE_AI_API_KEY`, and `OPENAI_API_KEY`. Construction is lazy + fail-closed per
 * provider: a role only needs the key(s) for the provider(s) it actually routes to, so the chat path
 * runs on DeepSeek alone. (OpenAI's key already backs embeddings; it also serves as the vision fallback.)
 *
 * Routing policy: DeepSeek V4 Flash for chat/reasoning/classification (Chinese-native, cheap, long
 * ctx); Gemini Flash for long-context compression and the one multimodal path. See
 * docs/ARCHITECTURE.md and the M1 build plan for the per-call-site rationale.
 */
export type Role = "chat" | "reason" | "classify" | "long" | "vision";

/**
 * Thrown by `modelsFor` when NO provider for a role is configured (every candidate slug's key is
 * absent). Distinct type so callers can tell "nothing is wired for this role" apart from a transient
 * provider error and degrade honestly — e.g. the vision path answers "I couldn't read that image"
 * instead of surfacing a raw 500 (see lib/ai.ts + app/api/telegram/route.ts).
 */
export class NoProviderError extends Error {
  constructor(public readonly role: Role, message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

/**
 * Default slug per role, as `provider/model-id`. The provider prefix selects the direct SDK provider;
 * the remainder is the provider's own API model id (verify against the provider's docs — they drift):
 *   - `deepseek-v4-flash` is DeepSeek's current chat/reasoning id (the legacy `deepseek-chat` /
 *     `deepseek-reasoner` aliases are being sunset).
 *   - `gemini-2.5-flash` is Google's current stable Flash id.
 */
export const MODEL_DEFAULTS: Record<Role, string> = {
  chat: "deepseek/deepseek-v4-flash",
  reason: "deepseek/deepseek-v4-flash",
  classify: "deepseek/deepseek-v4-flash",
  long: "google/gemini-2.5-flash",
  vision: "google/gemini-2.5-flash",
};

/** Env var that overrides each role (all optional + defaulted; see lib/env.ts + .env.example). */
const ENV_OVERRIDE: Record<Role, "MODEL_CHAT" | "MODEL_REASON" | "MODEL_CLASSIFY" | "MODEL_LONG" | "MODEL_VISION"> = {
  chat: "MODEL_CHAT",
  reason: "MODEL_REASON",
  classify: "MODEL_CLASSIFY",
  long: "MODEL_LONG",
  vision: "MODEL_VISION",
};

/**
 * Per-role ordered fallback slugs: if the primary model errors, the wrapper (lib/ai.ts) tries the
 * next one. Text roles cross to the other provider. Vision falls back to another MULTIMODAL model
 * (OpenAI's cheap `gpt-4o-mini`) — never a text-only one, which would hallucinate on an image. This
 * is what keeps the handwriting-photo path alive when the Google key is absent but OpenAI's is set;
 * with both keys gone, `modelsFor("vision")` fails closed and the caller degrades honestly (lib/ai.ts,
 * app/api/telegram/route.ts). Overridable via `MODEL_VISION`. (Under the gateway this was
 * `providerOptions.gateway.models`; with direct providers the failover is done in code — see
 * `modelsFor` + lib/ai.ts.)
 */
export const FALLBACK: Record<Role, string[]> = {
  chat: ["google/gemini-2.5-flash"],
  reason: ["google/gemini-2.5-flash"],
  classify: ["google/gemini-2.5-flash"],
  long: ["deepseek/deepseek-v4-flash"],
  vision: ["openai/gpt-4o-mini"],
};

type ProviderId = "deepseek" | "google" | "openai";

/** Human-readable env var name a provider is keyed by — used in fail-closed error messages. */
const PROVIDER_ENV: Record<ProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** The credential for a provider, or undefined when it isn't wired. Drives per-provider fail-closed. */
function keyFor(provider: ProviderId): string | undefined {
  const env = getEnv();
  const key =
    provider === "deepseek"
      ? env.DEEPSEEK_API_KEY
      : provider === "google"
        ? env.GOOGLE_GENERATIVE_AI_API_KEY
        : env.OPENAI_API_KEY;
  return key && key.trim() ? key : undefined;
}

/** Split a `provider/model-id` slug; throws on an unknown provider so a typo fails loudly, not silently. */
function parseSlug(slug: string): { provider: ProviderId; modelId: string } {
  const idx = slug.indexOf("/");
  const provider = idx === -1 ? "" : slug.slice(0, idx);
  const modelId = idx === -1 ? "" : slug.slice(idx + 1);
  if ((provider !== "deepseek" && provider !== "google" && provider !== "openai") || !modelId) {
    throw new Error(`Invalid model slug "${slug}" — expected "deepseek/<id>", "google/<id>", or "openai/<id>".`);
  }
  return { provider, modelId };
}

/** Construct a direct-provider LanguageModel for a slug. Throws if the provider's key is missing. */
function buildModel(slug: string): LanguageModel {
  const { provider, modelId } = parseSlug(slug);
  const apiKey = keyFor(provider);
  if (!apiKey) {
    throw new Error(`${PROVIDER_ENV[provider]} is not set; cannot construct "${slug}".`);
  }
  switch (provider) {
    case "deepseek":
      return createDeepSeek({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
  }
}

/** Resolve the concrete slug for a role, honoring the MODEL_* env override when set (non-empty). */
export function slugFor(role: Role): string {
  const override = getEnv()[ENV_OVERRIDE[role]];
  return override && override.trim() ? override : MODEL_DEFAULTS[role];
}

/**
 * Ordered list of constructable models for a role: primary first, then fallbacks, deduped. Any slug
 * whose provider credential is absent is skipped — so a role fails closed on an unconfigured provider
 * yet still uses whatever provider *is* wired (chat runs on DeepSeek alone; `long`/`vision` fall back
 * to DeepSeek when the Google key isn't set). Throws only when NO provider for the role is available.
 */
export function modelsFor(role: Role): LanguageModel[] {
  const models: LanguageModel[] = [];
  const seen = new Set<string>();
  for (const slug of [slugFor(role), ...FALLBACK[role]]) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (!keyFor(parseSlug(slug).provider)) continue;
    models.push(buildModel(slug));
  }
  if (models.length === 0) {
    throw new NoProviderError(
      role,
      `No AI provider configured for role "${role}". Set DEEPSEEK_API_KEY (required) and/or GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY.`,
    );
  }
  return models;
}
