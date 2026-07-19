import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const getQueuedActions = vi.fn();
vi.mock("@/lib/notion", () => ({ getQueuedActions }));

const get = (auth = "Bearer agent-secret") =>
  new Request("http://x/api/agent/tasks", { headers: { authorization: auth } });

describe("GET /api/agent/tasks", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    vi.resetModules();
    getQueuedActions.mockReset();
  });

  it("401s on bad bearer", async () => {
    const { GET } = await import("@/app/api/agent/tasks/route");
    expect((await GET(get("Bearer WRONG"))).status).toBe(401);
  });

  it("returns only locally-executable tasks", async () => {
    getQueuedActions.mockResolvedValue([
      { id: "A1", type: "create_anki_cards", payload: '{"cards":[]}' },
      { id: "A2", type: "update_plan", payload: "{}" },
    ]);
    const { GET } = await import("@/app/api/agent/tasks/route");
    const res = await GET(get());
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("A1");
  });
});
