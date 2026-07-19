/**
 * Cross-site request forgery guard for the dashboard's session-cookie-authenticated POST routes.
 *
 * The session cookie is SameSite=Lax. Lax withholds the cookie from *every* cross-site subresource
 * request — a form POST, a `fetch`, a `sendBeacon` — and sends it only on a top-level cross-site GET
 * navigation, so on a browser that enforces it a forged POST arrives with no cookie and is already
 * dead at the auth check. What Lax does NOT cover, and this guard does:
 *
 *   - "Same-site" is the registrable domain, not the origin. Any other origin under the same site —
 *     a sibling subdomain, a preview deployment, a `http://` version of the host — is same-site, so
 *     Lax happily attaches the cookie to its `fetch`. Only an origin check catches that.
 *   - SameSite is a browser behaviour, not a server one: an old or non-conforming client (Safari's
 *     documented Lax bugs, embedded webviews, anything with the default overridden) may still send
 *     the cookie cross-site, and the server cannot tell.
 *   - It is a single point of failure. If the cookie's attributes are ever loosened (SameSite=None
 *     for an embed, say), every route silently loses its only CSRF defence at once.
 *
 * The write is the whole attack: a cross-origin `fetch` with `content-type: text/plain` is a CORS
 * "simple request", so the browser sends it with no preflight, and although the attacker cannot read
 * the response, these routes have already written to the learner's Notion by then.
 *
 * Two checks, each of which would be sufficient on its own on a conforming browser; both are
 * required so that a gap in either one is still covered:
 *   1. Origin / Sec-Fetch-Site must say the request came from this site. Sec-Fetch-Site is set by
 *      the browser and cannot be forged by page script; Origin is sent on every cross-origin POST.
 *   2. Content-Type must be JSON — which is *not* a simple request type, so a cross-origin caller
 *      cannot set it without a preflight this server never approves (no CORS headers are emitted).
 *
 * A request carrying neither Sec-Fetch-Site nor Origin is allowed: that is a non-browser client
 * (curl, a test, a native app), which is not a confused deputy — it has no ambient cookie to abuse
 * unless the attacker already has the cookie, at which point CSRF is not the problem.
 */

/**
 * Hosts that count as "this site" for a request: the Host header and the URL's.
 *
 * `x-forwarded-host` is deliberately NOT trusted. It is a plain request header, so any client can
 * set it; including it let a caller nominate its own attacker origin as "this site" and walk
 * straight through the guard (`Origin: https://evil.com` + `x-forwarded-host: evil.com` was proven
 * to reach the route body). Vercel overwrites the header at the edge so production was shielded,
 * but `next dev`, `next start` behind a proxy, and self-hosted deployments were not — and a guard
 * that only holds on one deployment target is not a guard. Vercel sets `host` to the public
 * request host, so dropping the forwarded header costs nothing there.
 */
function selfHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const host = req.headers.get("host");
  if (host) hosts.add(host.toLowerCase());
  try {
    hosts.add(new URL(req.url).host.toLowerCase());
  } catch {
    /* a request with an unparseable URL simply contributes no host */
  }
  return hosts;
}

/** Loopback is the one place a plaintext origin is legitimate (local dev over http://localhost). */
function isLoopback(host: string): boolean {
  const name = host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** True when the browser tells us this request came from this site (or tells us nothing at all). */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";

  const origin = req.headers.get("origin");
  if (!origin) return true; // no browser signal at all — see the note above
  if (origin === "null") return false; // sandboxed iframe / opaque origin
  try {
    const url = new URL(origin);
    const host = url.host.toLowerCase();
    if (!selfHosts(req).has(host)) return false;
    // Compare the scheme too. `URL.host` carries the port but not the protocol, so matching on host
    // alone accepted `http://<our-host>` on an HTTPS deployment — exactly the plaintext-origin case
    // the notes above claim to catch. Anything but loopback must be https.
    return url.protocol === "https:" || isLoopback(host);
  } catch {
    return false;
  }
}

/** True when the body is declared as JSON (parameters like `; charset=utf-8` are allowed). */
export function isJsonRequest(req: Request): boolean {
  const ct = req.headers.get("content-type");
  if (!ct) return false;
  return ct.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Returns a 403 response to send back, or null when the request may proceed. Call it after the auth
 * check and before reading the body, so a forged request never reaches Notion.
 */
export function csrfGuard(req: Request): Response | null {
  if (!isSameOrigin(req)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  if (!isJsonRequest(req)) return Response.json({ error: "expected application/json" }, { status: 415 });
  return null;
}
