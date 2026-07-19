import { describe, it, expect, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";
import { SESSION_COOKIE } from "../lib/auth";

function post(body: unknown) {
  return new Request("http://x/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/auth/login", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV, { CRON_SECRET: "sign-key", DASHBOARD_PASSWORD: "hunter2" });
  });

  it("sets a session cookie for the right password", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(post({ password: "hunter2" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
  });

  it("rejects the wrong password with 401 and no cookie", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(post({ password: "wrong" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("503s when the dashboard is not configured", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(post({ password: "hunter2" }));
    expect(res.status).toBe(503);
  });
});
