import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const recordAgentHeartbeat = vi.fn(async () => {});
vi.mock("@/lib/notion", () => ({ recordAgentHeartbeat }));

const post = (body: unknown, auth = "Bearer agent-secret") =>
  new Request("http://x/api/agent/heartbeat", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /api/agent/heartbeat", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV);
    vi.resetModules();
    recordAgentHeartbeat.mockClear();
  });

  it("401s on a bad bearer and records nothing", async () => {
    const { POST } = await import("@/app/api/agent/heartbeat/route");
    expect((await POST(post({}, "Bearer WRONG"))).status).toBe(401);
    expect(recordAgentHeartbeat).not.toHaveBeenCalled();
  });

  it("records the ping with Anki reachability", async () => {
    const { POST } = await import("@/app/api/agent/heartbeat/route");
    const res = await POST(post({ ankiReachable: false }));
    expect(res.status).toBe(200);
    expect(recordAgentHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ ankiReachable: false }),
    );
  });

  it("stamps SERVER time, ignoring anything the laptop claims", async () => {
    // A laptop with a wrong clock could otherwise report itself alive until 2099 — the precise
    // silent-failure mode this route exists to close.
    const { POST } = await import("@/app/api/agent/heartbeat/route");
    await POST(post({ ankiReachable: true, lastSeenIso: "2099-01-01T00:00:00.000Z" }));
    const arg = recordAgentHeartbeat.mock.calls[0][0] as unknown as { lastSeenIso: string };
    expect(arg.lastSeenIso).not.toContain("2099");
    expect(Math.abs(Date.parse(arg.lastSeenIso) - Date.now())).toBeLessThan(10_000);
  });

  it("accepts a body-less ping rather than 500ing on it", async () => {
    const { POST } = await import("@/app/api/agent/heartbeat/route");
    const res = await POST(post(undefined));
    expect(res.status).toBe(200);
    expect(recordAgentHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ ankiReachable: undefined }),
    );
  });

  it("refuses a non-boolean ankiReachable instead of storing junk", async () => {
    const { POST } = await import("@/app/api/agent/heartbeat/route");
    await POST(post({ ankiReachable: "yes" }));
    expect(recordAgentHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ ankiReachable: undefined }),
    );
  });
});
