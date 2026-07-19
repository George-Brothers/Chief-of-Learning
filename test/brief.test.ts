import { describe, it, expect } from "vitest";
import { composeBrief } from "../lib/brief";

const base = {
  oneThing: "Ch.8 vocab, 20 new cards",
  focusAreas: ["tones on 4th"],
  dayKind: { lessonToday: false, dayAfterLesson: false, lessonTonight: false },
  quietDays: 0,
  quietThreshold: 2,
  nothingNew: false,
};

describe("composeBrief", () => {
  it("leads with the one thing and the 1.5h frame", () => {
    const t = composeBrief(base);
    expect(t).toMatch(/1\.5|90 min/i);
    expect(t).toContain("Ch.8 vocab");
  });

  it("adds a lesson line on lesson-tonight days", () => {
    const t = composeBrief({
      ...base,
      dayKind: { lessonToday: true, lessonTonight: true, dayAfterLesson: false },
    });
    expect(t).toMatch(/class tonight/i);
  });

  it("fires a firm nudge past the quiet threshold", () => {
    const t = composeBrief({ ...base, quietDays: 3 });
    expect(t).toMatch(/quiet|been \d+ days|where's your/i);
  });

  it("stays to one short line when nothing new and no lesson", () => {
    const t = composeBrief({ ...base, nothingNew: true });
    expect(t.trim().split("\n").filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});
