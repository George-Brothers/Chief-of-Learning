// Single-user auth for the web dashboard + /api/chat. Lucy's brain (Notion + the model) must never
// be reachable without this gate. The owner sets DASHBOARD_PASSWORD; a successful login sets an
// httpOnly cookie whose value is an HMAC of the password keyed by CRON_SECRET — so the raw password
// is never stored in the cookie and the token can't be forged without the server secret.
//
// Fail-closed: if DASHBOARD_PASSWORD is unset the dashboard stays locked (login refuses, guards deny).

import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

export const SESSION_COOKIE = "lucy_session";

/** Constant-time string compare that tolerates length mismatch without leaking it via throw. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The opaque session token for a valid login. Derived, never the password itself. */
export function sessionToken(): string {
  const env = getEnv();
  if (!env.DASHBOARD_PASSWORD) return "";
  return createHmac("sha256", env.CRON_SECRET).update(env.DASHBOARD_PASSWORD).digest("hex");
}

/** True only when the dashboard is configured (a password is set). */
export function dashboardEnabled(): boolean {
  return Boolean(getEnv().DASHBOARD_PASSWORD);
}

/** Verify a submitted password against DASHBOARD_PASSWORD (constant-time). */
export function verifyPassword(submitted: string): boolean {
  const expected = getEnv().DASHBOARD_PASSWORD;
  if (!expected) return false; // fail closed
  return safeEqual(submitted, expected);
}

/** Parse the session cookie value out of a Cookie header string. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** True when the request carries a valid session cookie. Fails closed when unconfigured. */
export function isAuthed(req: Request): boolean {
  const token = sessionToken();
  if (!token) return false;
  const cookie = readSessionCookie(req.headers.get("cookie"));
  return Boolean(cookie) && safeEqual(cookie as string, token);
}

/** True when a raw cookie value (e.g. from next/headers) is a valid session. Fails closed. */
export function isValidSessionValue(value: string | undefined | null): boolean {
  const token = sessionToken();
  if (!token || !value) return false;
  return safeEqual(value, token);
}

/** Set-Cookie header value for a successful login (httpOnly, SameSite=Lax, 30 days). */
export function sessionCookie(token: string): string {
  const maxAge = 60 * 60 * 24 * 30;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`;
}

/** Set-Cookie header value that clears the session (logout). */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}
