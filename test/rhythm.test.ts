import { describe, it, expect } from "vitest";
import { classifyDay, studyPlanShape, weeklyBudgetSummary } from "../lib/rhythm";

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

describe("studyPlanShape", () => {
  const tz = "America/Chicago";

  // Mon 2026-07-06 … Sun 2026-07-12.
  it("gives 60 minutes on the tutor days (Mon/Wed/Sat)", () => {
    for (const day of ["2026-07-06", "2026-07-08", "2026-07-11"]) {
      const shape = studyPlanShape(d(day), tz);
      expect(shape.budgetMinutes).toBe(60);
      expect(shape.tutorDay).toBe(true);
    }
  });

  it("gives 90 minutes on Tuesday and Thursday", () => {
    for (const day of ["2026-07-07", "2026-07-09"]) {
      const shape = studyPlanShape(d(day), tz);
      expect(shape.budgetMinutes).toBe(90);
      expect(shape.tutorDay).toBe(false);
    }
  });

  it("gives 120 minutes on the two long days (Fri/Sun)", () => {
    for (const day of ["2026-07-10", "2026-07-12"]) {
      const shape = studyPlanShape(d(day), tz);
      expect(shape.budgetMinutes).toBe(120);
      expect(shape.tutorDay).toBe(false);
    }
  });

  it("reads the weekday in the learner's timezone, not UTC", () => {
    // 2026-07-11 01:00 UTC is still Friday evening in Chicago — a 120-minute long day; in UTC it has
    // already rolled over to Saturday, a 60-minute tutor day.
    const lateFriday = new Date("2026-07-11T01:00:00Z");
    expect(studyPlanShape(lateFriday, tz).budgetMinutes).toBe(120);
    expect(studyPlanShape(lateFriday, "UTC").budgetMinutes).toBe(60);
  });
});

describe("one source of truth", () => {
  const tz = "America/Chicago";

  it("agrees with classifyDay about which days are tutor days", () => {
    // The two used to disagree (classifyDay said Mon/Wed/Sat, studyPlanShape said Mon/Wed/Fri).
    for (const day of ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"]) {
      expect(studyPlanShape(d(day), tz).tutorDay).toBe(classifyDay(d(day), tz).lessonToday);
    }
  });

  it("prints a weekly budget matching the daily budgets", () => {
    const s = weeklyBudgetSummary();
    expect(s).toContain("Fri 120");
    expect(s).toContain("Sat 60");
    expect(s).toContain("600 min");
  });
});
