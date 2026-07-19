import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { getEnv } from "../lib/env";
import { FULL_ENV } from "./helpers";

/** The `KEY=value` pairs a fresh operator would copy out of the template (comments ignored). */
function readEnvExample(): Record<string, string> {
  const raw = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe("getEnv", () => {
  beforeEach(() => {
    for (const k of Object.keys(FULL_ENV)) delete process.env[k];
    delete process.env.TIMEZONE;
    delete process.env.QUIET_DAYS_THRESHOLD;
  });

  it("returns typed env with defaults", () => {
    Object.assign(process.env, FULL_ENV);
    const e = getEnv();
    expect(e.TIMEZONE).toBe("America/Chicago");
    expect(e.QUIET_DAYS_THRESHOLD).toBe(2);
  });

  it("throws when a required key is missing", () => {
    Object.assign(process.env, FULL_ENV);
    delete (process.env as Record<string, string | undefined>).NOTION_TOKEN;
    expect(() => getEnv()).toThrow();
  });

  it("requires the chief-of-staff env vars", () => {
    Object.assign(process.env, FULL_ENV);
    const env = getEnv();
    expect(env.NOTION_LESSONS_DB_ID).toBeTruthy();
    expect(env.NOTION_ACTIONQUEUE_DB_ID).toBeTruthy();
    expect(env.AGENT_SECRET).toBeTruthy();
  });

  it("has the honest-scorecard env vars", () => {
    Object.assign(process.env, FULL_ENV);
    const e = getEnv();
    expect(e.NOTION_RETAINED_PAGE_ID).toBeTruthy();
    expect(e.NOTION_ASSIGNMENTS_DB_ID).toBeTruthy();
  });

  it("has the listening page id", () => {
    Object.assign(process.env, FULL_ENV);
    expect(getEnv().NOTION_LISTENING_PAGE_ID).toBeTruthy();
  });

  // An empty string is not a missing key: `z.string()` accepts "", and the agent routes authorize on
  // `Bearer ${AGENT_SECRET}` — so an empty secret silently turns `Authorization: Bearer ` into a
  // valid credential. Every secret/id must refuse to boot empty rather than degrade open.
  it("rejects an empty AGENT_SECRET instead of authorizing a bare bearer", () => {
    Object.assign(process.env, FULL_ENV, { AGENT_SECRET: "" });
    expect(() => getEnv()).toThrow();
  });

  it("rejects every empty required id", () => {
    // FULL_ENV holds only required keys (the optional Google key + DASHBOARD_PASSWORD are omitted).
    const required = Object.keys(FULL_ENV);
    for (const k of required) {
      Object.assign(process.env, FULL_ENV, { [k]: "" });
      expect(() => getEnv(), `${k}="" must not boot`).toThrow();
    }
  });

  // R6: the template omitted vars lib/env.ts requires, so a fresh deploy 500'd on every route. Boot
  // from the template itself rather than a hand-kept list, so a new required var can't drift out.
  it("boots from a filled-in .env.example", () => {
    const template = readEnvExample();
    expect(template).toHaveProperty("NOTION_TOKEN"); // guard: the parse actually found pairs
    for (const [k, v] of Object.entries(template)) process.env[k] = v || "filled-in";
    expect(() => getEnv()).not.toThrow();
  });
});
