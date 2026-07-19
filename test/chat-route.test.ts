import { describe, it, expect, vi, beforeEach } from "vitest";

const isAuthed = vi.fn();
vi.mock("@/lib/auth", () => ({ isAuthed }));

const respondToMessage = vi.fn(async () => ({ reply: "You're at HSK1 62%. 加油!", handledAs: "answer" }));
vi.mock("@/lib/webchat", () => ({ respondToMessage }));

function post(body: unknown, hasJson = true) {
  return new Request("http://x/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: hasJson ? JSON.stringify(body) : "not-json{",
  });
}

describe("/api/chat", () => {
  beforeEach(() => {
    isAuthed.mockReset();
    respondToMessage.mockClear();
  });

  it("rejects unauthenticated requests with 401", async () => {
    isAuthed.mockReturnValue(false);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post({ message: "hi" }));
    expect(res.status).toBe(401);
    expect(respondToMessage).not.toHaveBeenCalled();
  });

  it("runs the brain and returns the reply when authed", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post({ message: "how am I doing?" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { reply: string };
    expect(json.reply).toContain("HSK1");
    expect(respondToMessage).toHaveBeenCalledWith("how am I doing?");
  });

  it("400s on a missing message", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post({ nope: 1 }));
    expect(res.status).toBe(400);
    expect(respondToMessage).not.toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post(null, false));
    expect(res.status).toBe(400);
  });

  // The session cookie alone is not a CSRF defence: a cross-origin `fetch` with a simple
  // content-type is sent without a preflight, and this route writes Notion and spends tokens.
  it("refuses a cross-site POST before running the brain", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(respondToMessage).not.toHaveBeenCalled();
  });

  it("refuses a non-JSON content type before running the brain", async () => {
    isAuthed.mockReturnValue(true);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    expect(res.status).toBe(415);
    expect(respondToMessage).not.toHaveBeenCalled();
  });
});
