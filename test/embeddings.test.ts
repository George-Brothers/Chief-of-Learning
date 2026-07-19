import { describe, it, expect, beforeEach } from "vitest";
import { embedTexts, embeddingModelId, EMBEDDING_MODEL_DEFAULT, EMBEDDING_DIMENSIONS } from "../lib/embeddings";
import { FULL_ENV } from "./helpers";

describe("embeddings", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_MODEL;
  });

  it("pins the exact model id and matching dimensions", () => {
    expect(EMBEDDING_MODEL_DEFAULT).toBe("text-embedding-3-small");
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it("fails closed with a clear message when OPENAI_API_KEY is unset", async () => {
    await expect(embedTexts(["hello"])).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("returns [] for no input without requiring a key", async () => {
    await expect(embedTexts([])).resolves.toEqual([]);
  });

  it("defaults to text-embedding-3-small and honors the EMBEDDING_MODEL override", () => {
    expect(embeddingModelId()).toBe("text-embedding-3-small");
    process.env.EMBEDDING_MODEL = "text-embedding-3-large";
    expect(embeddingModelId()).toBe("text-embedding-3-large");
  });
});
