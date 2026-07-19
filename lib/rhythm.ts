export type DayKind = {
  lessonToday: boolean;
  dayAfterLesson: boolean;
  lessonTonight: boolean;
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Weekday (0=Sun..6=Sat) as observed in a given IANA timezone. */
function weekdayIn(date: Date, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  return DAY_NAMES.indexOf(s as (typeof DAY_NAMES)[number]);
}

type DaySpec = {
  /** A tutor session happens on this day. */
  tutor: boolean;
  /** That tutor session is in the EVENING (so the day still has study time ahead of it). */
  evening: boolean;
  /** Self-study minutes available, tutor time excluded. */
  budgetMinutes: number;
};

/**
 * THE learner's week — the single source of truth for both the lesson cadence and the time budget,
 * indexed 0=Sun..6=Sat. classifyDay and studyPlanShape both read this table, so a schedule change is
 * one edit and the two can't drift apart again (they previously disagreed about which days are tutor
 * days: Mon/Wed/Sat vs Mon/Wed/Fri).
 *
 * Confirmed cadence: tutor on Mon / Wed / Sat, with Mon and Wed in the evening and Sat in the
 * morning. Budgets are self-study only — tutor days are short because the lesson eats the rest.
 */
const WEEK: readonly DaySpec[] = [
  { tutor: false, evening: false, budgetMinutes: 120 }, // Sun
  { tutor: true, evening: true, budgetMinutes: 60 }, //    Mon — tutor, evening
  { tutor: false, evening: false, budgetMinutes: 90 }, //  Tue
  { tutor: true, evening: true, budgetMinutes: 60 }, //    Wed — tutor, evening
  { tutor: false, evening: false, budgetMinutes: 90 }, //  Thu
  { tutor: false, evening: false, budgetMinutes: 120 }, // Fri
  { tutor: true, evening: false, budgetMinutes: 60 }, //   Sat — tutor, morning
];

/**
 * Classify a day against the tutor cadence in WEEK above.
 * - lessonToday: Mon / Wed / Sat
 * - lessonTonight: Mon / Wed (the two evening sessions)
 * - dayAfterLesson: the day after any tutor day — Tue / Thu / Sun (homework-review prompt days)
 */
export function classifyDay(date: Date, tz: string): DayKind {
  const wd = weekdayIn(date, tz);
  const today = WEEK[wd];
  const yesterday = WEEK[(wd + 6) % 7];
  return {
    lessonToday: today.tutor,
    lessonTonight: today.tutor && today.evening,
    dayAfterLesson: yesterday.tutor,
  };
}

export type StudyPlanShape = {
  /** Self-study minutes available today, tutor time excluded. */
  budgetMinutes: number;
  /** True on the three tutor days, whose budget is smaller because the lesson takes the rest. */
  tutorDay: boolean;
};

/**
 * Today's real self-study time budget, so the coach sizes the ONE action against something instead
 * of inventing a duration ("30 min", "~1.5 hours") out of the air.
 * - Mon / Wed / Sat: 60 — tutor days, the lesson itself eats the rest of the slot.
 * - Tue / Thu: 90 — the full weekday evening.
 * - Fri / Sun: 120 — the long days.
 */
export function studyPlanShape(date: Date, tz: string): StudyPlanShape {
  const { tutor, budgetMinutes } = WEEK[weekdayIn(date, tz)];
  return { budgetMinutes, tutorDay: tutor };
}

/**
 * The week's budgets on one line, so the weekly review grades against the SAME model the daily brief
 * sizes each day with instead of a stale hardcoded "1.5h/day" constant.
 */
export function weeklyBudgetSummary(): string {
  const per = WEEK.map((d, i) => `${DAY_NAMES[i]} ${d.budgetMinutes}`).join(" · ");
  const total = WEEK.reduce((n, d) => n + d.budgetMinutes, 0);
  return `${per} (self-study minutes, tutor time excluded) — ${total} min ≈ ${(total / 60).toFixed(1)}h across the week`;
}
