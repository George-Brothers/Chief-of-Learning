import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const distillLesson = vi.fn();
const lessonExists = vi.fn();
const addLesson = vi.fn();
const enqueueAction = vi.fn();

vi.mock("@/lib/lesson", () => ({ distillLesson }));
vi.mock("@/lib/notion", () => ({ lessonExists, addLesson, enqueueAction }));

const post = (body: unknown, auth = "Bearer agent-secret") =>
  new Request("http://x/api/ingest/transcript", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });

describe("POST /api/ingest/transcript", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    vi.resetModules();
    for (const f of [distillLesson, lessonExists, addLesson, enqueueAction]) f.mockReset();
  });

  it("rejects a bad bearer", async () => {
    const { POST } = await import("@/app/api/ingest/transcript/route");
    expect((await POST(post({ markdown: "x", hash: "h" }, "Bearer WRONG"))).status).toBe(401);
  });

  // R5: auth compares against `Bearer ${AGENT_SECRET}`, so an empty secret would make a bare
  // `Authorization: Bearer ` a valid credential. lib/env.ts refuses to parse an empty secret, so the
  // route fails closed (throws → 500) instead of ingesting an unauthenticated transcript.
  it("fails closed on an empty AGENT_SECRET rather than accepting a bare bearer", async () => {
    Object.assign(process.env, FULL_ENV, { AGENT_SECRET: "" });
    const { POST } = await import("@/app/api/ingest/transcript/route");
    await expect(POST(post({ markdown: "x", hash: "h" }, "Bearer "))).rejects.toThrow();
    expect(lessonExists).not.toHaveBeenCalled();
  });

  it("skips a hash it has already seen", async () => {
    lessonExists.mockResolvedValue(true);
    const { POST } = await import("@/app/api/ingest/transcript/route");
    const res = await POST(post({ markdown: "x", hash: "h" }));
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(distillLesson).not.toHaveBeenCalled();
  });

  it("distills, stores, and queues cards for a new lesson", async () => {
    lessonExists.mockResolvedValue(false);
    distillLesson.mockResolvedValue({
      summary: "s", vocabIntroduced: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
      errors: [], grammarPoints: [], couldNotSay: [], homeworkAssigned: "", durationMinutes: 50,
    });
    addLesson.mockResolvedValue("L1");
    enqueueAction.mockResolvedValue("A1");
    const { POST } = await import("@/app/api/ingest/transcript/route");
    const res = await POST(post({ markdown: "transcript", hash: "h", date: "2026-07-14" }));
    expect(await res.json()).toEqual({ ok: true, lessonId: "L1" });
    expect(addLesson).toHaveBeenCalledOnce();
    expect(enqueueAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "create_anki_cards" }),
    );
  });

  // §2.2: the done route only reports back when payload.notify is set. This path enqueued {cards}
  // with no notify, so the primary lesson pipeline failed *silently* — cards could vanish with no
  // signal, while the README promised a ⚠️. Nobody watches this enqueue, so it needs notify most.
  it("asks for a report-back so a card failure can't be silent", async () => {
    lessonExists.mockResolvedValue(false);
    distillLesson.mockResolvedValue({
      summary: "s", vocabIntroduced: [{ headword: "跳舞", pinyin: "tiàowǔ", definition: "dance", example: "我喜欢跳舞。" }],
      errors: [], grammarPoints: [], couldNotSay: [], homeworkAssigned: "", durationMinutes: 50,
    });
    addLesson.mockResolvedValue("L1");
    const { POST } = await import("@/app/api/ingest/transcript/route");
    await POST(post({ markdown: "transcript", hash: "h", date: "2026-07-14" }));

    const payload = JSON.parse(enqueueAction.mock.calls.at(-1)![0].payload);
    expect(payload.notify).toBe(true);
    expect(payload.label).toBe("lesson 2026-07-14");
    expect(payload.cards).toHaveLength(1);
  });
});
