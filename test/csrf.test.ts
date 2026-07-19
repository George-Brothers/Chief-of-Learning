import { describe, it, expect } from "vitest";
import { isSameOrigin, isJsonRequest, csrfGuard } from "@/lib/csrf";

/**
 * The dashboard's write routes were protected by SameSite=Lax alone, which does not stop a
 * cross-site `fetch` with a CORS-simple content type. Every case below therefore describes a request
 * that previously sailed through to Notion. lib/csrf.ts did not exist before this suite.
 */
const req = (headers: Record<string, string>, url = "https://lucy.example/api/dashboard/plan") =>
  new Request(url, { method: "POST", headers, body: "{}" });

describe("isSameOrigin", () => {
  it("trusts Sec-Fetch-Site over anything the page can set", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "none" }))).toBe(true); // typed in the URL bar
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }))).toBe(false); // sibling subdomain
    // Even a forged matching Origin loses to the browser-set header.
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site", origin: "https://lucy.example" }))).toBe(
      false,
    );
  });

  it("falls back to Origin, matched against the host the request arrived on", () => {
    expect(isSameOrigin(req({ origin: "https://lucy.example" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "null" }))).toBe(false); // sandboxed iframe
    expect(isSameOrigin(req({ origin: "not a url" }))).toBe(false);
  });

  it("does NOT let a caller nominate its own origin via x-forwarded-host", () => {
    // The header is client-suppliable, so trusting it let `Origin: https://evil.example` +
    // `x-forwarded-host: evil.example` walk straight through the guard and reach the route body.
    expect(
      isSameOrigin(
        req({ origin: "https://evil.example", "x-forwarded-host": "evil.example" }, "https://lucy.example/x"),
      ),
    ).toBe(false);
    // ...and it cannot be used to widen the set beyond the real Host either.
    expect(
      isSameOrigin(
        req({ origin: "https://lucy.example", "x-forwarded-host": "lucy.example" }, "https://10.0.0.4/x"),
      ),
    ).toBe(false);
  });

  it("rejects a plaintext origin on an https deployment but allows loopback", () => {
    // URL.host carries the port but not the scheme, so a host-only match accepted http://<our-host>.
    expect(isSameOrigin(req({ origin: "http://lucy.example" }))).toBe(false);
    expect(
      isSameOrigin(req({ origin: "http://localhost:3000" }, "http://localhost:3000/x")),
    ).toBe(true);
  });

  it("allows a request that carries no browser signal at all", () => {
    // curl, a native client, a test — no ambient cookie to confuse, so nothing to forge.
    expect(isSameOrigin(req({}))).toBe(true);
  });
});

describe("isJsonRequest", () => {
  it("requires a JSON content type and tolerates parameters", () => {
    expect(isJsonRequest(req({ "content-type": "application/json" }))).toBe(true);
    expect(isJsonRequest(req({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    expect(isJsonRequest(req({ "content-type": "APPLICATION/JSON" }))).toBe(true);
    // The three CORS-simple types — the ones that get sent cross-site without a preflight.
    expect(isJsonRequest(req({ "content-type": "text/plain" }))).toBe(false);
    expect(isJsonRequest(req({ "content-type": "application/x-www-form-urlencoded" }))).toBe(false);
    expect(isJsonRequest(req({ "content-type": "multipart/form-data; boundary=x" }))).toBe(false);
  });
});

describe("csrfGuard", () => {
  it("passes a same-origin JSON request through", () => {
    expect(csrfGuard(req({ "content-type": "application/json", "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("answers 403 for a foreign origin and 415 for a non-JSON body", async () => {
    const forged = csrfGuard(req({ "content-type": "application/json", origin: "https://evil.example" }))!;
    expect(forged.status).toBe(403);
    const wrongType = csrfGuard(req({ "content-type": "text/plain" }))!;
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toMatchObject({ error: expect.stringContaining("json") });
  });
});
