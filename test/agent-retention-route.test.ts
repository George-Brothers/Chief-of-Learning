import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";
const writeRetained = vi.fn();
vi.mock("@/lib/notion", () => ({ writeRetained }));
const post = (body: unknown, auth = "Bearer agent-secret") =>
  new Request("http://x/api/agent/retention", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
describe("POST /api/agent/retention", () => {
  beforeEach(() => { Object.assign(process.env, FULL_ENV); vi.resetModules(); writeRetained.mockReset(); });
  it("401 on bad bearer", async () => {
    const { POST } = await import("@/app/api/agent/retention/route");
    expect((await POST(post({ words: [] }, "Bearer NO"))).status).toBe(401);
  });
  it("writes retained words", async () => {
    writeRetained.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/agent/retention/route");
    const res = await POST(post({ words: ["跳舞", "唱歌"] }));
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    expect(writeRetained).toHaveBeenCalledWith("跳舞 唱歌");
  });
});
