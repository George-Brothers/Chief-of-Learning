import { describe, it, expect, vi, beforeEach } from "vitest";

const readStudyMap = vi.fn(async () => "STUDYMAP");
const readLedger = vi.fn(async () => "LEDGER");
vi.mock("../lib/notion", () => ({ readStudyMap, readLedger }));

const retrieveContext = vi.fn();
vi.mock("../lib/retrieval", () => ({ retrieveContext }));

describe("buildQuestionBrain (additive retrieval over the Notion brain)", () => {
  beforeEach(() => {
    readStudyMap.mockClear();
    readLedger.mockClear();
    retrieveContext.mockReset();
  });

  it("falls back to Notion-only context when the index has nothing", async () => {
    retrieveContext.mockResolvedValue("");
    const { buildQuestionBrain } = await import("../lib/brain");
    const brain = await buildQuestionBrain("了 vs 过?");
    expect(brain).toBe("STUDYMAP\n\nLEDGER");
    expect(brain).not.toContain("MOST RELEVANT");
  });

  it("prepends retrieved context additively when the index helps", async () => {
    retrieveContext.mockResolvedValue("- [lesson] 了 marks a completed action");
    const { buildQuestionBrain } = await import("../lib/brain");
    const brain = await buildQuestionBrain("了 vs 过?");
    expect(brain).toContain("MOST RELEVANT");
    expect(brain).toContain("了 marks a completed action");
    expect(brain).toContain("STUDYMAP");
    expect(brain).toContain("LEDGER");
  });

  it("never breaks the answer path when retrieval throws", async () => {
    retrieveContext.mockRejectedValue(new Error("index down"));
    const { buildQuestionBrain } = await import("../lib/brain");
    const brain = await buildQuestionBrain("anything");
    expect(brain).toBe("STUDYMAP\n\nLEDGER");
  });
});
