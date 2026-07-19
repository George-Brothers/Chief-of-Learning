import { describe, it, expect, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";
import {
  SESSION_COOKIE,
  sessionToken,
  verifyPassword,
  isAuthed,
  isValidSessionValue,
  dashboardEnabled,
  readSessionCookie,
  sessionCookie,
  clearSessionCookie,
} from "../lib/auth";

function withCookie(value: string): Request {
  return new Request("http://x/dashboard", { headers: { cookie: `${SESSION_COOKIE}=${value}; other=1` } });
}

describe("dashboard auth", () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV, { CRON_SECRET: "sign-key", DASHBOARD_PASSWORD: "hunter2" });
  });

  it("dashboardEnabled reflects whether a password is set", () => {
    expect(dashboardEnabled()).toBe(true);
    delete process.env.DASHBOARD_PASSWORD;
    expect(dashboardEnabled()).toBe(false);
  });

  it("verifyPassword is exact and fails closed when unconfigured", () => {
    expect(verifyPassword("hunter2")).toBe(true);
    expect(verifyPassword("nope")).toBe(false);
    delete process.env.DASHBOARD_PASSWORD;
    expect(verifyPassword("hunter2")).toBe(false);
  });

  it("sessionToken is deterministic, non-empty, and password-bound", () => {
    const a = sessionToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionToken()).toBe(a);
    process.env.DASHBOARD_PASSWORD = "different";
    expect(sessionToken()).not.toBe(a);
    delete process.env.DASHBOARD_PASSWORD;
    expect(sessionToken()).toBe("");
  });

  it("readSessionCookie extracts the session value", () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=abc; x=y`)).toBe("abc");
    expect(readSessionCookie("x=y")).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });

  it("isValidSessionValue accepts only the real token", () => {
    const t = sessionToken();
    expect(isValidSessionValue(t)).toBe(true);
    expect(isValidSessionValue("forged")).toBe(false);
    expect(isValidSessionValue(undefined)).toBe(false);
  });

  it("isAuthed accepts a valid cookie and rejects the rest", () => {
    const t = sessionToken();
    expect(isAuthed(withCookie(t))).toBe(true);
    expect(isAuthed(withCookie("forged"))).toBe(false);
    expect(isAuthed(new Request("http://x/dashboard"))).toBe(false);
  });

  it("fails closed for every check when no password is configured", () => {
    const t = sessionToken();
    delete process.env.DASHBOARD_PASSWORD;
    expect(isAuthed(withCookie(t))).toBe(false);
    expect(isValidSessionValue(t)).toBe(false);
  });

  it("cookie headers are httpOnly and clear on logout", () => {
    expect(sessionCookie("tok")).toContain("HttpOnly");
    expect(sessionCookie("tok")).toContain(`${SESSION_COOKIE}=tok`);
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
