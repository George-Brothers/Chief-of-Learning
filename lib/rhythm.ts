export type DayKind = {
  lessonToday: boolean;
  dayAfterLesson: boolean;
  lessonTonight: boolean;
};

/** Weekday (0=Sun..6=Sat) as observed in a given IANA timezone. */
function weekdayIn(date: Date, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s);
}

/**
 * Classify a day against a three-lessons-a-week tutor cadence (default: Mon and Wed evenings,
 * Sat morning). Adjust the day sets below to match your own schedule.
 * - lessonToday: Mon / Wed / Sat
 * - lessonTonight: Mon / Wed (evening lessons)
 * - dayAfterLesson: Tue / Thu / Sun (homework-review prompt days)
 */
export function classifyDay(date: Date, tz: string): DayKind {
  const wd = weekdayIn(date, tz);
  const lessonDays = new Set([1, 3, 6]);
  const eveningLessonDays = new Set([1, 3]);
  const dayAfter = new Set([2, 4, 0]);
  return {
    lessonToday: lessonDays.has(wd),
    lessonTonight: eveningLessonDays.has(wd),
    dayAfterLesson: dayAfter.has(wd),
  };
}
