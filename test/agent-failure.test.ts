// The cards-lost-forever bug: the old `isTransient` treated ONLY `anki <action> failed: 5xx` as
// retryable, so a 404 (wrong port — 8765 is taken by another service), a 401, or any unexpected
// status was classified permanent, the row was burned to Status "error", and `getQueuedActions`
// never returns it again. These tests pin the inverted rule: retry unless PROVABLY permanent.
import { describe, it, expect } from "vitest";
import { isConnectivity, isPermanent, isTransient } from "../agent/failure";

const withCause = (msg: string, code: string) => Object.assign(new Error(msg), { cause: { code } });

describe("isPermanent", () => {
  it("is false for every failure we cannot prove is permanent", () => {
    // The exact failure the audit caught live: something else answering on the Anki port with 404.
    expect(isPermanent(new Error("anki findNotes failed: 404 "))).toBe(false);
    expect(isPermanent(new Error("anki addNote failed: 401 unauthorized"))).toBe(false);
    expect(isPermanent(new Error("anki addNote failed: 403 forbidden"))).toBe(false);
    expect(isPermanent(new Error("anki addNote failed: 502 bad gateway"))).toBe(false);
    expect(isPermanent(new Error("anki addNote error: collection is not available"))).toBe(false);
    expect(isPermanent(new Error("something nobody has ever seen"))).toBe(false);
    expect(isPermanent(withCause("fetch failed", "ECONNREFUSED"))).toBe(false);
    // A JSON parse failure is NOT permanent here. This module is shared, and ankiInvoke parses the
    // RESPONSE of a remote service — a `200` + text/html from whatever is squatting on the Anki port
    // used to burn the whole batch on attempt 1. Retry it; the executor's budget bounds the damage.
    // Our own unparseable task payload is burned at its call site in agent/executor.ts instead.
    expect(isPermanent(new SyntaxError("Unexpected token n in JSON at position 2"))).toBe(false);
  });

  it("is true only for payloads Anki will reject identically forever", () => {
    expect(isPermanent(new Error("anki addNote error: cannot create note because it is a duplicate"))).toBe(true);
    expect(isPermanent(new Error("anki addNote error: cannot create note because it is empty"))).toBe(true);
    expect(isPermanent(new Error("anki addNote error: model was not found: Basic"))).toBe(true);
  });
});

describe("isConnectivity", () => {
  // Connectivity failures are the NORMAL state of a laptop (Anki closed, machine asleep). They must
  // retry without limit — they must never spend the bounded attempt budget.
  it("recognises a closed Anki / unreachable host", () => {
    expect(isConnectivity(withCause("fetch failed", "ECONNREFUSED"))).toBe(true);
    expect(isConnectivity(withCause("x", "ETIMEDOUT"))).toBe(true);
    expect(isConnectivity(withCause("x", "EHOSTUNREACH"))).toBe(true);
    expect(isConnectivity(new TypeError("fetch failed"))).toBe(true);
    expect(isConnectivity(new Error("anki addNote failed: 503 upstream"))).toBe(true);
  });

  it("does not claim an HTTP 404 or an Anki-level rejection is connectivity", () => {
    expect(isConnectivity(new Error("anki findNotes failed: 404 "))).toBe(false);
    expect(isConnectivity(new Error("anki addNote error: cannot create note because it is empty"))).toBe(false);
  });
});

describe("isTransient", () => {
  it("is the exact inverse of isPermanent — the fail-safe default", () => {
    for (const e of [
      new Error("anki findNotes failed: 404 "),
      new Error("anki addNote failed: 401"),
      new Error("who knows"),
      withCause("fetch failed", "ECONNREFUSED"),
      new SyntaxError("bad json"),
      new Error("anki addNote error: cannot create note because it is empty"),
    ]) {
      expect(isTransient(e)).toBe(!isPermanent(e));
    }
  });
});
