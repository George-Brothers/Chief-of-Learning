import { describe, it, expect, vi, beforeEach } from "vitest";
import { chunkText, syncIndex, retrieveContext, type SourceDoc } from "../lib/retrieval";
import { memoryStore, cosineDistance, toVectorLiteral } from "../lib/vector-store";
import type { Embedder } from "../lib/embeddings";
import { FULL_ENV } from "./helpers";

// A deterministic, network-free embedder: each dimension counts a keyword's occurrences, so cosine
// similarity reflects topical overlap and rankings are fully predictable.
const VOCAB = ["tone", "grammar", "vocab", "listening", "character"] as const;
function vec(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((w) => lower.split(w).length - 1);
}
const fakeEmbed: Embedder = async (texts) => texts.map(vec);

const src = (id: string, text: string): SourceDoc => ({ id, source: "lesson", title: id, text });

describe("chunkText", () => {
  it("packs lines greedily within the budget", () => {
    const chunks = chunkText("line one\nline two\nline three", 12);
    expect(chunks).toEqual(["line one", "line two", "line three"]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
  });

  it("hard-splits a single over-long line so no chunk exceeds the budget", () => {
    expect(chunkText("x".repeat(25), 10)).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  });

  it("returns [] for empty/whitespace text", () => {
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("")).toEqual([]);
  });
});

describe("cosineDistance + toVectorLiteral", () => {
  it("scores identical direction 0, orthogonal 1, opposite 2, zero-vector 2", () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2);
    expect(cosineDistance([0, 0], [1, 0])).toBe(2);
  });

  it("renders a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });
});

describe("syncIndex (Notion → index, one-way + idempotent)", () => {
  it("indexes every source on first run, one embed batch per changed page", async () => {
    const store = memoryStore();
    const embed = vi.fn(fakeEmbed);
    const sources = [src("a", "tone tone"), src("b", "grammar"), src("c", "listening")];
    const s = await syncIndex({ store, embed, sources });
    expect(s.upserted).toBe(3);
    expect(s.unchanged).toBe(0);
    expect(s.deleted).toBe(0);
    expect(s.embedCalls).toBe(3);
    expect((await store.listPages()).map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("is idempotent: a second run with unchanged sources does zero work", async () => {
    const store = memoryStore();
    const embed = vi.fn(fakeEmbed);
    const sources = [src("a", "tone tone"), src("b", "grammar")];
    await syncIndex({ store, embed, sources });
    embed.mockClear();

    const second = await syncIndex({ store, embed, sources });
    expect(second.upserted).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(second.deleted).toBe(0);
    expect(second.embedCalls).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it("re-embeds changed sources and deletes ones that vanished from Notion", async () => {
    const store = memoryStore();
    const embed = vi.fn(fakeEmbed);
    await syncIndex({ store, embed, sources: [src("a", "tone"), src("b", "grammar")] });
    embed.mockClear();

    // 'a' changed, 'b' removed, 'c' added.
    const s = await syncIndex({ store, embed, sources: [src("a", "tone tone changed"), src("c", "listening")] });
    expect(s.upserted).toBe(2); // a (changed) + c (new)
    expect(s.deleted).toBe(1); // b
    expect(s.unchanged).toBe(0);
    expect(embed).toHaveBeenCalledTimes(2);
    expect((await store.listPages()).map((p) => p.id).sort()).toEqual(["a", "c"]);
  });
});

describe("retrieveContext ranking", () => {
  it("returns the nearest chunks first, labeled by source", async () => {
    const store = memoryStore();
    const sources = [
      src("a", "tone tone tone drills"),
      src("b", "grammar grammar structure"),
      src("c", "listening listening comprehension"),
    ];
    await syncIndex({ store, embed: fakeEmbed, sources });

    const ctx = await retrieveContext("help me with tone", { store, embed: fakeEmbed, k: 2 });
    const lines = ctx.split("\n");
    expect(lines).toHaveLength(2); // top-k honored
    expect(lines[0]).toContain("tone"); // closest chunk ranked first
    expect(lines[0]).toContain("[lesson]"); // source-labeled
    expect(ctx).not.toContain("comprehension"); // the least-related chunk is excluded at k=2
  });
});

describe("retrieveContext fallback (never breaks the bot)", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
  });

  it("returns '' on an empty index", async () => {
    const ctx = await retrieveContext("anything", { store: memoryStore(), embed: fakeEmbed });
    expect(ctx).toBe("");
  });

  it("returns '' (does not throw) when the store errors", async () => {
    const store = {
      ...memoryStore(),
      search: async () => {
        throw new Error("db unreachable");
      },
    };
    await expect(retrieveContext("q", { store, embed: fakeEmbed })).resolves.toBe("");
  });

  it("returns '' when no DATABASE_URL is configured and no store is injected", async () => {
    delete process.env.DATABASE_URL;
    await expect(retrieveContext("q")).resolves.toBe("");
  });

  it("returns '' when DATABASE_URL is set but OPENAI_API_KEY is not", async () => {
    process.env.DATABASE_URL = "postgres://localhost/x";
    delete process.env.OPENAI_API_KEY;
    await expect(retrieveContext("q")).resolves.toBe("");
    delete process.env.DATABASE_URL;
  });

  it("returns '' for an empty query", async () => {
    await expect(retrieveContext("   ", { store: memoryStore(), embed: fakeEmbed })).resolves.toBe("");
  });
});
