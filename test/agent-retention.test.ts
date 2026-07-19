import { describe, it, expect, vi, beforeEach } from "vitest";

describe("agent retention", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("getMatureFronts keeps only CJK fronts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, opts: any) => {
      const b = JSON.parse(opts.body);
      if (b.action === "findCards") return new Response(JSON.stringify({ result: [1, 2], error: null }));
      return new Response(JSON.stringify({ result: [
        { fields: { Front: { value: "跳舞" } } },
        { fields: { Front: { value: "hello" } } },
      ], error: null }));
    }));
    const { getMatureFronts } = await import("../agent/anki");
    expect(await getMatureFronts("http://anki")).toEqual(["跳舞"]);
  });

  it("syncRetention posts the words with bearer", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: any) => {
      const b = JSON.parse(opts.body); calls.push([url, b]);
      if (b.action === "findCards") return new Response(JSON.stringify({ result: [1], error: null }));
      if (b.action === "cardsInfo") return new Response(JSON.stringify({ result: [{ fields: { Front: { value: "唱歌" } } }], error: null }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    const { syncRetention } = await import("../agent/retention");
    const n = await syncRetention({ cloudUrl: "http://cloud", secret: "s", ankiUrl: "http://anki" } as any);
    expect(n).toBe(1);
    const post = calls.find(([u]) => u === "http://cloud/api/agent/retention");
    expect(post[1]).toEqual({ words: ["唱歌"] });
  });
});
