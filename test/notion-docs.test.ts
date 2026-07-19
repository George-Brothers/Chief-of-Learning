// R1 / P0-1: the four brain docs (Ledger, Study Map, Daily Log, Gradebook) + Today/Scorecard are the
// only copy of their own state. writeDoc used to delete every block before appending the replacement,
// so a 429 or network blip in the window between the two left the doc blank or half-written. These
// tests pin the crash behavior — that a mid-write failure preserves the old text — not just the
// happy path, which passed under the old ordering too.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FULL_ENV } from "./helpers";

/** Ordered log of every Notion mutation, so tests can assert append-before-delete. */
let calls: string[] = [];

const blocks = {
  children: {
    list: vi.fn(async () => ({ results: [] as any[] })),
    append: vi.fn(async (a: any) => {
      calls.push(`append:${a.children.length}`);
      return { results: a.children.map((_: unknown, i: number) => ({ id: `new-${i}` })) };
    }),
  },
  delete: vi.fn(async (a: any) => {
    calls.push(`delete:${a.block_id}`);
    return {};
  }),
};

vi.mock("@notionhq/client", () => ({
  Client: vi.fn(() => ({ blocks, pages: {}, databases: {} })),
}));

/** A page holding `ids` as one-line paragraph blocks. */
const pageOf = (ids: string[], text = "old") => ({
  results: ids.map((id) => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } })),
});

beforeEach(() => {
  Object.assign(process.env, FULL_ENV);
  calls = [];
  blocks.children.list.mockReset().mockResolvedValue({ results: [] });
  blocks.children.append.mockReset().mockImplementation(async (a: any) => {
    calls.push(`append:${a.children.length}`);
    return { results: a.children.map((_: unknown, i: number) => ({ id: `new-${i}` })) };
  });
  blocks.delete.mockReset().mockImplementation(async (a: any) => {
    calls.push(`delete:${a.block_id}`);
    return {};
  });
});

describe("writeDoc crash-safety", () => {
  it("appends the new text before deleting the old blocks", async () => {
    blocks.children.list.mockResolvedValueOnce(pageOf(["old-1", "old-2"]) as any);
    const { writeGradebook } = await import("../lib/notion");
    await writeGradebook("fresh gradebook");

    // Content, then the trailing commit sentinel, then the old blocks are retired.
    expect(calls).toEqual(["append:1", "append:1", "delete:old-1", "delete:old-2"]);
  });

  it("leaves the doc untouched when the append fails outright", async () => {
    blocks.children.list.mockResolvedValueOnce(pageOf(["old-1", "old-2"]) as any);
    blocks.children.append.mockRejectedValueOnce(new Error("notion 429"));
    const { writeGradebook } = await import("../lib/notion");

    await expect(writeGradebook("fresh gradebook")).rejects.toThrow("notion 429");
    // The pre-existing gradebook must still be on the page — this is the wipe the audit found.
    expect(blocks.delete).not.toHaveBeenCalled();
  });

  it("rolls back the blocks it already appended when a later batch fails", async () => {
    // 200 lines → two append batches (90 + 90 + 20); fail the second one.
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    blocks.children.list.mockResolvedValueOnce(pageOf(["old-1"]) as any);
    blocks.children.append
      .mockImplementationOnce(async (a: any) => {
        calls.push(`append:${a.children.length}`);
        return { results: a.children.map((_: unknown, i: number) => ({ id: `new-${i}` })) };
      })
      .mockRejectedValueOnce(new Error("notion 500"));
    const { writeGradebook } = await import("../lib/notion");

    await expect(writeGradebook(text)).rejects.toThrow("notion 500");
    // The first batch's 90 blocks are rolled back, and only those — the old doc is never touched.
    const deleted = blocks.delete.mock.calls.map((c) => (c[0] as any).block_id);
    expect(deleted).toHaveLength(90);
    expect(deleted.every((id: string) => id.startsWith("new-"))).toBe(true);
    expect(deleted).not.toContain("old-1");
  });

  it("keeps the new text and reports the leftovers when a delete fails", async () => {
    blocks.children.list.mockResolvedValueOnce(pageOf(["old-1", "old-2"]) as any);
    blocks.delete.mockRejectedValueOnce(new Error("notion 429")); // old-1 refuses to go
    const { writeGradebook } = await import("../lib/notion");

    // Loud, not silent: the doc is stale-but-complete and the owner gets told.
    await expect(writeGradebook("fresh gradebook")).rejects.toThrow(/stale block/);
    expect(blocks.children.append).toHaveBeenCalledTimes(2); // content + commit sentinel both landed
    expect(blocks.delete).toHaveBeenCalledTimes(2); // and we still tried to clear the rest
  });

  it("clears leftovers from an earlier half-finished write on the next write", async () => {
    // Self-heal: the next write snapshots whatever is on the page — leftovers included — and clears it.
    blocks.children.list.mockResolvedValueOnce(pageOf(["old-1", "leftover-new-0"]) as any);
    const { writeGradebook } = await import("../lib/notion");
    await writeGradebook("fresh gradebook");

    const deleted = blocks.delete.mock.calls.map((c) => (c[0] as any).block_id);
    expect(deleted).toEqual(["old-1", "leftover-new-0"]);
  });
});

describe("doc reads follow pagination", () => {
  it("prependDoc keeps the tail of a doc longer than one 100-block page", async () => {
    // A >100-block Daily Log: reading only page 1 would write back a truncated doc and drop the rest.
    blocks.children.list
      .mockResolvedValueOnce({ ...pageOf(["b1"], "page-one-line"), has_more: true, next_cursor: "c1" } as any)
      .mockResolvedValueOnce(pageOf(["b2"], "page-two-line") as any)
      // writeDoc re-lists to snapshot the stale blocks:
      .mockResolvedValueOnce({ ...pageOf(["b1"]), has_more: true, next_cursor: "c1" } as any)
      .mockResolvedValueOnce(pageOf(["b2"]) as any);
    const { prependDailyLog } = await import("../lib/notion");
    await prependDailyLog("newest entry");

    const written = blocks.children.append.mock.calls
      .flatMap((c) => (c[0] as any).children)
      .map((b: any) => b.paragraph.rich_text.map((t: any) => t.text.content).join(""))
      .join("\n");
    expect(written).toContain("newest entry");
    expect(written).toContain("page-one-line");
    expect(written).toContain("page-two-line"); // the tail survives the round-trip
    // Both pages of stale blocks are retired, so leftovers can't accumulate.
    expect(blocks.delete.mock.calls.map((c) => (c[0] as any).block_id)).toEqual(["b1", "b2"]);
  });

  it("throws rather than silently truncating a doc past the block-page cap", async () => {
    // A read that never stops paginating would drop the tail; prependDoc would then write that
    // truncation back as the whole doc. Refuse the read instead of persisting a partial snapshot.
    blocks.children.list.mockResolvedValue({
      results: [{ id: "b", type: "paragraph", paragraph: { rich_text: [{ plain_text: "x" }] } }],
      has_more: true,
      next_cursor: "c",
    } as any);
    const { readDailyLog } = await import("../lib/notion");
    await expect(readDailyLog()).rejects.toThrow(/truncated doc/);
  });
});

const SENTINEL = "\u200B\u2060\u200B"; // the zero-width trailing commit sentinel readDoc keys on
const block = (id: string, text: string) => ({
  id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] },
});

describe("prepend self-heals a failed delete without a baked-in duplicate", () => {
  it("reads back only the newest committed unit, so a lingering leftover is not re-captured", async () => {
    // A prepend("E1") over committed "OLD" whose stale-delete failed: the OLD unit (OLD + its sentinel)
    // lingers IN FRONT of the new committed unit [E1, "", OLD, sentinel]. readDoc returns only the run
    // between the last two sentinels (the new unit), so the leftover OLD is never re-captured.
    const page = {
      results: [
        block("o1", "OLD"), block("osent", SENTINEL),
        block("n1", "E1"), block("n2", ""), block("n3", "OLD"), block("nsent", SENTINEL),
      ],
    };
    blocks.children.list.mockResolvedValueOnce(page as any).mockResolvedValueOnce(page as any);
    const { prependDailyLog } = await import("../lib/notion");
    await prependDailyLog("E2");

    const written = blocks.children.append.mock.calls
      .flatMap((c) => (c[0] as any).children)
      .map((b: any) => b.paragraph.rich_text.map((t: any) => t.text.content).join(""))
      .join("\n");
    expect(written).toContain("E2");
    expect(written).toContain("E1");
    // OLD appears exactly once: the leftover was NOT read back into the new content.
    expect((written.match(/OLD/g) ?? []).length).toBe(1);
    // And every lingering block is retired, so the physical duplicate is cleared too — content first,
    // then the sentinels last (so a partial delete never strands content in front of a lone sentinel).
    expect(blocks.delete.mock.calls.map((c) => (c[0] as any).block_id))
      .toEqual(["o1", "n1", "n2", "n3", "osent", "nsent"]);
  });
});

describe("readDoc never surfaces an uncommitted write", () => {
  it("returns the last committed content when an append fails AND its rollback also fails", async () => {
    // The compound Notion-outage case: a multi-batch write lands its first batch, the second batch
    // rejects, and the rollback deletes reject too, so the partial write's blocks linger with NO
    // trailing sentinel. readDoc must still return the previous committed content verbatim.
    const committed = {
      results: [block("o1", "OLD LINE 1"), block("o2", "OLD LINE 2"), block("osent", SENTINEL)],
    };
    blocks.children.list.mockResolvedValueOnce(committed as any); // writeDoc's stale snapshot
    blocks.children.append
      .mockImplementationOnce(async (a: any) => {
        calls.push(`append:${a.children.length}`);
        return { results: a.children.map((_: unknown, i: number) => ({ id: `p-${i}` })) };
      })
      .mockRejectedValueOnce(new Error("notion 503")); // second batch fails mid-write
    blocks.delete.mockRejectedValue(new Error("notion 503")); // and the rollback deletes fail too

    const bigText = Array.from({ length: 120 }, (_, i) => `partial ${i}`).join("\n");
    const { writeGradebook } = await import("../lib/notion");
    await expect(writeGradebook(bigText)).rejects.toThrow("notion 503");

    // The page now physically holds the committed unit followed by the un-terminated partial blocks.
    const afterFailure = {
      results: [
        ...committed.results,
        ...Array.from({ length: 90 }, (_, i) => block(`p-${i}`, `partial ${i}`)),
      ],
    };
    blocks.children.list.mockReset().mockResolvedValue(afterFailure as any);
    const { readGradebook } = await import("../lib/notion");
    const read = await readGradebook();

    expect(read).toBe("OLD LINE 1\nOLD LINE 2"); // committed content, never the partial write
    expect(read).not.toContain("partial");
  });
});

describe("a failed stale-content delete keeps the old sentinel bracketing the leftover out", () => {
  it("never deletes the old sentinel once old content refuses to go, so readDoc returns only the new unit", async () => {
    // Committed doc whose stale region is [old-content, old-sentinel]. The old-CONTENT delete 429s while
    // the old-SENTINEL delete would succeed. Retiring the sentinel here would collapse the page to a
    // single sentinel and merge the surviving OLD into the new unit. So the sentinel must survive.
    const committed = { results: [block("o1", "OLD"), block("osent", SENTINEL)] };
    blocks.children.list.mockResolvedValueOnce(committed as any); // writeDoc's stale snapshot
    blocks.delete.mockImplementation(async (a: any) => {
      calls.push(`delete:${a.block_id}`);
      if (a.block_id === "o1") throw new Error("notion 429"); // old content refuses to go
      return {};
    });
    const { writeGradebook } = await import("../lib/notion");
    await expect(writeGradebook("NEW")).rejects.toThrow(/stale block/);

    // The old sentinel was left in place — we stopped short of it the moment old content failed.
    expect(blocks.delete.mock.calls.map((c) => (c[0] as any).block_id)).not.toContain("osent");

    // Physical page after the partial delete: surviving [o1, osent] followed by the new committed unit.
    // Two sentinels ⇒ readDoc returns only the run between them (NEW); the stale OLD stays bracketed out.
    const afterFailure = {
      results: [
        block("o1", "OLD"), block("osent", SENTINEL),
        block("n0", "NEW"), block("nsent", SENTINEL),
      ],
    };
    blocks.children.list.mockReset().mockResolvedValue(afterFailure as any);
    const { readGradebook } = await import("../lib/notion");
    const read = await readGradebook();
    expect(read).toBe("NEW"); // only the new unit — never the stale OLD merged in front of it
    expect(read).not.toContain("OLD");
  });

  it("a following prependDoc does not bake the bracketed-out stale content back into the doc", async () => {
    // The page the partial delete left behind: surviving [o1, osent] before the new committed unit.
    const page = {
      results: [
        block("o1", "OLD"), block("osent", SENTINEL),
        block("n0", "NEW"), block("nsent", SENTINEL),
      ],
    };
    blocks.children.list.mockResolvedValueOnce(page as any).mockResolvedValueOnce(page as any);
    const { prependDailyLog } = await import("../lib/notion");
    await prependDailyLog("E-next");

    const written = blocks.children.append.mock.calls
      .flatMap((c) => (c[0] as any).children)
      .map((b: any) => b.paragraph.rich_text.map((t: any) => t.text.content).join(""))
      .join("\n");
    expect(written).toContain("E-next");
    expect(written).toContain("NEW");
    expect(written).not.toContain("OLD"); // the leftover is read as bracketed-out and never re-captured
  });
});
