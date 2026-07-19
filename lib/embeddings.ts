import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { getEnv } from "./env";

/**
 * Direct OpenAI embeddings for the M3 retrieval index (no Vercel AI Gateway — same direct-provider
 * policy as lib/models.ts). We pin `text-embedding-3-small`: it is natively 1536-dim, which MUST match
 * the `embedding vector(1536)` column in db/schema.sql. Do not point EMBEDDING_MODEL at a model with a
 * different dimensionality without also migrating the column.
 */
export const EMBEDDING_MODEL_DEFAULT = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

/** The embedding model id, honoring the optional EMBEDDING_MODEL override. */
export function embeddingModelId(): string {
  const override = getEnv().EMBEDDING_MODEL;
  return override && override.trim() ? override : EMBEDDING_MODEL_DEFAULT;
}

/** A function that turns texts into vectors — injectable so tests can supply a deterministic stub. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * Embed a batch of texts with OpenAI. Fails CLOSED with a clear message when OPENAI_API_KEY is unset —
 * this is the only place the key is required, so the app still boots without it and callers that can
 * degrade (retrieval) catch and fall back to Notion-only behavior.
 */
export const embedTexts: Embedder = async (texts) => {
  if (texts.length === 0) return [];
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot compute embeddings for the retrieval index. Set it to an " +
        "OpenAI API key (used only for embeddings), or leave the Neon index unconfigured to skip retrieval.",
    );
  }
  const model = createOpenAI({ apiKey }).textEmbeddingModel(embeddingModelId());
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
};
