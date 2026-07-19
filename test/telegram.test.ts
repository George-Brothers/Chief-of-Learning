import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

beforeEach(() => {
  Object.assign(process.env, FULL_ENV, { TELEGRAM_BOT_TOKEN: "BOT123" });
  vi.resetModules();
});

describe("telegram client", () => {
  it("sendMessage posts chat_id and text to the Telegram API", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const { sendMessage } = await import("../lib/telegram");
    await sendMessage("42", "study now");
    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/botBOT123/sendMessage");
    const body = JSON.parse(opts.body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text).toBe("study now");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    const { sendMessage } = await import("../lib/telegram");
    await expect(sendMessage("1", "x")).rejects.toThrow(/sendMessage failed/);
  });
});
