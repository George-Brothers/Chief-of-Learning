import { describe, it, expect } from "vitest";
import { classifyDay } from "../lib/rhythm";

// noon Central so the tz-based weekday is unambiguous
const d = (iso: string) => new Date(iso + "T12:00:00-05:00");

describe("classifyDay", () => {
  it("Monday is a lesson day with an evening lesson", () => {
    const k = classifyDay(d("2026-07-06"), "America/Chicago");
    expect(k.lessonToday).toBe(true);
    expect(k.lessonTonight).toBe(true);
  });

  it("Tuesday is the day after a lesson", () => {
    expect(classifyDay(d("2026-07-07"), "America/Chicago").dayAfterLesson).toBe(true);
  });

  it("Saturday is a lesson day but morning (no evening lesson)", () => {
    const k = classifyDay(d("2026-07-11"), "America/Chicago");
    expect(k.lessonToday).toBe(true);
    expect(k.lessonTonight).toBe(false);
  });
});
