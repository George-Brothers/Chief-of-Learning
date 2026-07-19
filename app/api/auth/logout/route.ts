import { clearSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

/** Log out: clear the session cookie. */
export async function POST(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": clearSessionCookie() },
  });
}
