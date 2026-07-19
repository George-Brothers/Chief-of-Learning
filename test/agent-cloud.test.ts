import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg = { cloudUrl: "http://cloud", secret: "s" };

describe("agent cloud client", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pushTranscript posts markdown + hash with bearer", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true, lessonId: "L1" })));
    vi.stubGlobal("fetch", spy);
    const { pushTranscript } = await import("../agent/push");
    const res = await pushTranscript(cfg, "md", "h", "2026-07-14");
    expect(res.lessonId).toBe("L1");
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://cloud/api/ingest/transcript");
    expect((opts.headers as Record<string, string>).authorization).toBe("Bearer s");
    expect(JSON.parse(opts.body as string)).toEqual({ markdown: "md", hash: "h", date: "2026-07-14" });
  });

  // P0-2: pushTranscript is the lesson's only trip to the cloud, so its retry policy decides whether
  // a blip costs a lesson. Retry what can recover; fail fast on what never will.
  it("retries transient failures with backoff, then succeeds", async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, lessonId: "L1" })));
    vi.stubGlobal("fetch", spy);
    const slept: number[] = [];
    const { pushTranscript } = await import("../agent/push");

    const res = await pushTranscript(cfg, "md", "h", "d", {
      sleepFn: async (ms) => void slept.push(ms),
    });
    expect(res.lessonId).toBe("L1");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([1000, 2000]); // exponential, and only between attempts
  });

  it("retries a dropped connection", async () => {
    const spy = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, lessonId: "L1" })));
    vi.stubGlobal("fetch", spy);
    const { pushTranscript } = await import("../agent/push");
    expect((await pushTranscript(cfg, "md", "h", "d", { sleepFn: async () => {} })).lessonId).toBe("L1");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejection that can never succeed", async () => {
    const spy = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", spy);
    const { pushTranscript } = await import("../agent/push");
    await expect(pushTranscript(cfg, "md", "h", "d", { sleepFn: async () => {} }))
      .rejects.toThrow(/401/);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("gives up after its attempt budget so the caller can dead-letter", async () => {
    const spy = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", spy);
    const { pushTranscript } = await import("../agent/push");
    await expect(pushTranscript(cfg, "md", "h", "d", { attempts: 3, sleepFn: async () => {} }))
      .rejects.toThrow(/503/);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("fetchTasks returns the tasks array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ tasks: [{ id: "A1", type: "create_anki_cards", payload: "{}" }] }))));
    const { fetchTasks } = await import("../agent/poll");
    expect((await fetchTasks(cfg))[0].id).toBe("A1");
  });

  it("completeTask posts the result", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", spy);
    const { completeTask } = await import("../agent/poll");
    await completeTask(cfg, "A1", "added 2", true);
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://cloud/api/agent/tasks/A1/done");
    expect(JSON.parse(opts.body as string)).toEqual({ result: "added 2", ok: true });
  });
});
