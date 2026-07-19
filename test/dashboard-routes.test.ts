import { describe, it, expect, vi, beforeEach } from "vitest";

const isAuthed = vi.fn();
vi.mock("@/lib/auth", () => ({ isAuthed }));

const addEvidence = vi.fn(async () => "ev1");
const readToday = vi.fn(async () => "");
const getOpenAssignments = vi.fn(async () => [] as Array<{ id: string; kind: string; description: string; createdTime: string }>);
const markAssignmentDone = vi.fn(async () => {});
const getRecentActivity = vi.fn(async () => [] as Array<{ id: string; createdTime: string; type: string; summary: string }>);
vi.mock("@/lib/notion", () => ({
  addEvidence,
  readToday,
  getOpenAssignments,
  markAssignmentDone,
  getRecentActivity,
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ TIMEZONE: "Asia/Shanghai" }) }));

function post(url: string, body: unknown, hasJson = true, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: hasJson ? JSON.stringify(body) : "not-json{",
  });
}

const POSTIT = "Rewrite 8 sentences dropping 是 — 25 min\n加油！(jiāyóu)";

describe("/api/dashboard/plan", () => {
  beforeEach(() => {
    isAuthed.mockReset();
    addEvidence.mockClear();
    readToday.mockReset();
    readToday.mockResolvedValue(POSTIT);
    getRecentActivity.mockReset();
    getRecentActivity.mockResolvedValue([]);
  });

  it("rejects unauthenticated requests with 401 and writes nothing", async () => {
    isAuthed.mockReturnValue(false);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(post("http://x/api/dashboard/plan", { blockId: "abc" }));
    expect(res.status).toBe(401);
    expect(addEvidence).not.toHaveBeenCalled();
    expect(readToday).not.toHaveBeenCalled();
  });

  it("records a checked block as evidence, using the text from the Today page", async () => {
    isAuthed.mockReturnValue(true);
    const { parseTodayPlan } = await import("@/lib/dashboard");
    const block = parseTodayPlan(POSTIT).blocks[0];
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(post("http://x/api/dashboard/plan", { blockId: block.id }));
    expect(res.status).toBe(200);
    const arg = addEvidence.mock.calls.at(-1)![0] as unknown as {
      type: string; source: string; rawText: string; distilled: string;
    };
    expect(arg.source).toBe("dashboard");
    expect(arg.type).toBe("check-in");
    expect(arg.rawText).toContain("Rewrite 8 sentences dropping 是");
    expect(arg.rawText).toContain("(25 min)");
    expect(JSON.parse(arg.distilled)).toMatchObject({ type: "check-in", newVocab: [], weakSignals: [] });
  });

  /**
   * FAILS against the pre-fix route, which called addEvidence unconditionally: a second tick of the
   * same block appended a second "Done: …" row, so the evidence stream the brief and the scorecard
   * read counted one piece of work twice.
   */
  it("writes nothing the second time the same block is ticked today", async () => {
    isAuthed.mockReturnValue(true);
    const { parseTodayPlan, PLAN_DONE_SUMMARY_PREFIX } = await import("@/lib/dashboard");
    const block = parseTodayPlan(POSTIT).blocks[0];
    // The row the first tick left behind, as getRecentActivity hands it back.
    getRecentActivity.mockResolvedValue([
      {
        id: "ev1",
        createdTime: new Date().toISOString(),
        type: "check-in",
        summary: `${PLAN_DONE_SUMMARY_PREFIX}${block.text} (${block.minutes} min)`,
      },
    ]);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(post("http://x/api/dashboard/plan", { blockId: block.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, alreadyLogged: true });
    expect(addEvidence).not.toHaveBeenCalled();
  });

  /** Yesterday's identical line must not arrive pre-ticked — the same post-it text recurs. */
  it("still writes when the only matching row is from an earlier day", async () => {
    isAuthed.mockReturnValue(true);
    const { parseTodayPlan, PLAN_DONE_SUMMARY_PREFIX } = await import("@/lib/dashboard");
    const block = parseTodayPlan(POSTIT).blocks[0];
    getRecentActivity.mockResolvedValue([
      {
        id: "ev0",
        createdTime: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        type: "check-in",
        summary: `${PLAN_DONE_SUMMARY_PREFIX}${block.text} (${block.minutes} min)`,
      },
    ]);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(post("http://x/api/dashboard/plan", { blockId: block.id }));
    expect(res.status).toBe(200);
    expect(addEvidence).toHaveBeenCalledTimes(1);
  });

  /**
   * FAILS against the pre-fix route: SameSite=Lax was the only defence, so an authenticated browser
   * carrying the session cookie would run this write for evil.example.
   */
  it("refuses a cross-site POST even when the session cookie is valid", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const byOrigin = await POST(
      post("http://x/api/dashboard/plan", { blockId: "abc" }, true, {
        origin: "https://evil.example",
        host: "x",
      }),
    );
    expect(byOrigin.status).toBe(403);
    const byFetchSite = await POST(
      post("http://x/api/dashboard/plan", { blockId: "abc" }, true, {
        "sec-fetch-site": "cross-site",
      }),
    );
    expect(byFetchSite.status).toBe(403);
    expect(addEvidence).not.toHaveBeenCalled();
    expect(readToday).not.toHaveBeenCalled();
  });

  /** text/plain is the CORS-simple content type that let a no-preflight cross-site write through. */
  it("refuses a body that is not declared as JSON", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(
      new Request("http://x/api/dashboard/plan", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ blockId: "abc" }),
      }),
    );
    expect(res.status).toBe(415);
    expect(addEvidence).not.toHaveBeenCalled();
  });

  it("accepts a same-origin POST", async () => {
    isAuthed.mockReturnValue(true);
    const { parseTodayPlan } = await import("@/lib/dashboard");
    const block = parseTodayPlan(POSTIT).blocks[0];
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(
      post("http://x/api/dashboard/plan", { blockId: block.id }, true, {
        origin: "http://x",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("404s an id that is not in today's plan", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    const res = await POST(post("http://x/api/dashboard/plan", { blockId: "nope" }));
    expect(res.status).toBe(404);
    expect(addEvidence).not.toHaveBeenCalled();
  });

  it("400s on a missing blockId and on a malformed body", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/plan/route");
    expect((await POST(post("http://x/api/dashboard/plan", { nope: 1 }))).status).toBe(400);
    expect((await POST(post("http://x/api/dashboard/plan", null, false))).status).toBe(400);
    expect(addEvidence).not.toHaveBeenCalled();
  });
});

describe("/api/dashboard/assignment", () => {
  beforeEach(() => {
    isAuthed.mockReset();
    markAssignmentDone.mockClear();
    getOpenAssignments.mockReset();
    getOpenAssignments.mockResolvedValue([
      { id: "AS1", kind: "drill", description: "rewrite 5", createdTime: "2026-07-15T09:00:00Z" },
    ]);
  });

  it("rejects unauthenticated requests with 401 and closes nothing", async () => {
    isAuthed.mockReturnValue(false);
    const { POST } = await import("@/app/api/dashboard/assignment/route");
    const res = await POST(post("http://x/api/dashboard/assignment", { id: "AS1" }));
    expect(res.status).toBe(401);
    expect(markAssignmentDone).not.toHaveBeenCalled();
  });

  it("closes an open assignment", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/assignment/route");
    const res = await POST(post("http://x/api/dashboard/assignment", { id: "AS1" }));
    expect(res.status).toBe(200);
    expect(markAssignmentDone).toHaveBeenCalledWith("AS1");
  });

  it("refuses an id that is not an open assignment", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/assignment/route");
    const res = await POST(post("http://x/api/dashboard/assignment", { id: "some-other-notion-page" }));
    expect(res.status).toBe(404);
    expect(markAssignmentDone).not.toHaveBeenCalled();
  });

  /** Same guard as the plan route — this one can close any open assignment. */
  it("refuses a cross-site POST", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/assignment/route");
    const res = await POST(
      post("http://x/api/dashboard/assignment", { id: "AS1" }, true, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(markAssignmentDone).not.toHaveBeenCalled();
  });

  it("400s on a missing id", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/dashboard/assignment/route");
    expect((await POST(post("http://x/api/dashboard/assignment", {}))).status).toBe(400);
    expect(markAssignmentDone).not.toHaveBeenCalled();
  });
});
