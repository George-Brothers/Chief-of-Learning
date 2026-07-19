import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const markActionDone = vi.fn();
const getAction = vi.fn();
vi.mock("@/lib/notion", () => ({ markActionDone, getAction }));

const sendMessage = vi.fn();
vi.mock("@/lib/telegram", () => ({ sendMessage }));

const post = (id: string, body: unknown, auth = "Bearer agent-secret") =>
  new Request(`http://x/api/agent/tasks/${id}/done`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });

describe("POST /api/agent/tasks/[id]/done", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    vi.resetModules();
    markActionDone.mockReset();
    getAction.mockReset();
    sendMessage.mockReset();
  });

  it("marks the action done", async () => {
    markActionDone.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/agent/tasks/[id]/done/route");
    const res = await POST(post("A1", { result: "created 3 cards", ok: true }), {
      params: Promise.resolve({ id: "A1" }),
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(markActionDone).toHaveBeenCalledWith("A1", "created 3 cards", true);
  });

  it("texts a completion message when the action was flagged notify", async () => {
    markActionDone.mockResolvedValue(undefined);
    getAction.mockResolvedValue({ type: "create_anki_cards", payload: '{"notify":true,"label":"Lesson 5"}', status: "done" });
    const { POST } = await import("@/app/api/agent/tasks/[id]/done/route");
    const res = await POST(post("A1", { result: "added 8, skipped 3", ok: true }), { params: Promise.resolve({ id: "A1" }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(sendMessage.mock.calls[0][1]).toContain("Lesson 5");
    expect(sendMessage.mock.calls[0][1]).toContain("added 8, skipped 3");
  });

  it("stays silent when the action has no notify flag", async () => {
    markActionDone.mockResolvedValue(undefined);
    getAction.mockResolvedValue({ type: "create_anki_cards", payload: '{}', status: "done" });
    const { POST } = await import("@/app/api/agent/tasks/[id]/done/route");
    await POST(post("A2", { result: "added 2", ok: true }), { params: Promise.resolve({ id: "A2" }) });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
