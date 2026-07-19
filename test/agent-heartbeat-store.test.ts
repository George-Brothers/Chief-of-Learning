import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

const pages = { create: vi.fn(async () => ({ id: "hb-new" })), update: vi.fn(async () => ({})) };
const databases = { query: vi.fn(async () => ({ results: [] })) };
const blocks = {
  children: { list: vi.fn(async () => ({ results: [] })), append: vi.fn(async () => ({})) },
  delete: vi.fn(async () => ({})),
};
vi.mock("@notionhq/client", () => ({ Client: vi.fn(() => ({ pages, databases, blocks })) }));

beforeEach(() => {
  Object.assign(process.env, FULL_ENV);
  vi.resetModules(); // the heartbeat page id is cached per module instance
  pages.create.mockClear();
  pages.update.mockClear();
  databases.query.mockClear();
  databases.query.mockResolvedValue({ results: [] } as never);
});

const hbRow = (payload: string, edited = "2026-07-18T04:00:00.000Z") => ({
  results: [{ id: "hb1", last_edited_time: edited, properties: { Payload: { rich_text: [{ plain_text: payload }] } } }],
});

/**
 * Liveness storage. The agent has no Notion credentials, so the cloud owns this row; it lives in the
 * Action Queue database because that needs no new env var (a new REQUIRED var would break the
 * deployed app at boot — lib/env.ts parses on every getEnv call).
 */
describe("agent heartbeat store", () => {
  it("creates the row the first time and updates that same row afterwards", async () => {
    const { recordAgentHeartbeat } = await import("../lib/notion");
    await recordAgentHeartbeat({ lastSeenIso: "2026-07-19T12:00:00.000Z", ankiReachable: true });
    expect(pages.create).toHaveBeenCalledOnce();
    expect(pages.update).not.toHaveBeenCalled();

    // Second beat: no second row. A heartbeat that appended would fill the queue with junk.
    await recordAgentHeartbeat({ lastSeenIso: "2026-07-19T12:01:00.000Z", ankiReachable: true });
    expect(pages.create).toHaveBeenCalledOnce();
    expect(pages.update).toHaveBeenCalledWith(expect.objectContaining({ page_id: "hb-new" }));
  });

  it("never writes the heartbeat with Status 'queued' — the agent must not fetch it as a task", async () => {
    const { recordAgentHeartbeat } = await import("../lib/notion");
    await recordAgentHeartbeat({ lastSeenIso: "2026-07-19T12:00:00.000Z" });
    const props = (pages.create.mock.calls[0][0] as any).properties;
    expect(props.Status.select.name).toBe("heartbeat");
    expect(props.Type.select.name).toBe("agent_heartbeat");
  });

  it("recreates the row if it was deleted, instead of losing liveness forever", async () => {
    databases.query.mockResolvedValue(hbRow(JSON.stringify({ lastSeenIso: "x" })) as never);
    pages.update.mockRejectedValueOnce(new Error("object not found") as never);
    const { recordAgentHeartbeat } = await import("../lib/notion");
    await recordAgentHeartbeat({ lastSeenIso: "2026-07-19T12:00:00.000Z" });
    expect(pages.create).toHaveBeenCalledOnce();
  });

  it("reads back the stored timestamp and Anki reachability", async () => {
    databases.query.mockResolvedValue(
      hbRow(JSON.stringify({ lastSeenIso: "2026-07-19T11:59:00.000Z", ankiReachable: false })) as never,
    );
    const { readAgentHeartbeat } = await import("../lib/notion");
    expect(await readAgentHeartbeat()).toEqual({
      lastSeenIso: "2026-07-19T11:59:00.000Z",
      ankiReachable: false,
    });
  });

  it("returns null when the agent has never checked in — the true state of this branch", async () => {
    const { readAgentHeartbeat } = await import("../lib/notion");
    expect(await readAgentHeartbeat()).toBeNull();
  });

  it("falls back to Notion's own edit stamp when the payload is mangled", async () => {
    databases.query.mockResolvedValue(hbRow("{{not json", "2026-07-18T04:00:00.000Z") as never);
    const { readAgentHeartbeat } = await import("../lib/notion");
    expect(await readAgentHeartbeat()).toEqual({ lastSeenIso: "2026-07-18T04:00:00.000Z" });
  });
});

/** The queue rows a HUMAN needs: what is waiting, and what already died. */
describe("action queue visibility", () => {
  it("getActionRows asks for queued AND errored rows and carries the failure reason", async () => {
    databases.query.mockResolvedValue({
      results: [
        {
          id: "t1",
          created_time: "2026-07-18T04:00:00.000Z",
          properties: {
            Type: { select: { name: "create_anki_cards" } },
            Status: { select: { name: "error" } },
            Payload: { rich_text: [{ plain_text: '{"cards":[1,2],"label":"L4"}' }] },
            Result: { rich_text: [{ plain_text: "anki addNote failed: 404" }] },
          },
        },
      ],
    } as never);
    const { getActionRows } = await import("../lib/notion");
    const rows = await getActionRows();
    expect(rows[0]).toMatchObject({ id: "t1", status: "error", result: "anki addNote failed: 404" });
    const filter = (databases.query.mock.calls[0][0] as any).filter;
    expect(filter.or.map((f: any) => f.select.equals)).toEqual(["queued", "error"]);
  });

  it("requeueAction puts a burned row back in front of the agent with its payload untouched", async () => {
    const { requeueAction } = await import("../lib/notion");
    await requeueAction("t1");
    const arg = pages.update.mock.calls[0][0] as any;
    expect(arg.page_id).toBe("t1");
    expect(arg.properties.Status.select.name).toBe("queued");
    expect(arg.properties.Payload).toBeUndefined();
  });
});
