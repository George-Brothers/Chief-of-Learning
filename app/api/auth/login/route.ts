import { dashboardEnabled, verifyPassword, sessionToken, sessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

/** Log in to the dashboard: exchange the shared password for a session cookie. */
export async function POST(req: Request): Promise<Response> {
  if (!dashboardEnabled()) {
    return Response.json({ error: "Dashboard is not configured." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const password = (body as { password?: unknown })?.password;
  if (typeof password !== "string" || !verifyPassword(password)) {
    return Response.json({ error: "Wrong password." }, { status: 401 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionCookie(sessionToken()) },
  });
}
