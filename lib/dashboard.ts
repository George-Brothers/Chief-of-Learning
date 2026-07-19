// Dashboard data assembly. This is a READ layer over Lucy's existing brain — it calls the same
// notion.ts readers and the pure hsk.ts engine the Telegram/cron paths use, and adds a few small,
// unit-tested pure helpers (streak, XP/level, focus-area derivation). No new "brain": coaching is
// derived from data Lucy already produced (evidence weak-signals, the week focus, the Gradebook).

import { getEnv } from "./env";
import {
  getKnownWords,
  readScorecard,
  readStudyMap,
  readLedger,
  readGradebook,
  getWeekFocus,
  getRecentActivity,
  getActivityTimestamps,
  getRecentLessons,
  getRecentEvidence,
  type ActivityRow,
  type LessonRow,
} from "./notion";
import {
  computeCoverage,
  computePace,
  observedPerWeek,
  splitScorecard,
  type HskCoverage,
  type Pace,
} from "./hsk";

// ---- Pure helpers (unit-tested in test/dashboard.test.ts) -------------------

/** Day label (YYYY-MM-DD) as observed in an IANA timezone — matches the app's other date handling. */
export function dayLabel(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const DAY_MS = 86_400_000;

/**
 * Consecutive-day study streak from activity timestamps. Counts back from today; today itself is a
 * grace day (an untouched today doesn't break a streak that was alive yesterday). Returns 0 when the
 * most recent activity is older than yesterday.
 */
export function computeStreak(isoTimestamps: string[], today: Date, tz: string): number {
  const days = new Set<string>();
  for (const ts of isoTimestamps) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) days.add(dayLabel(d, tz));
  }
  if (days.size === 0) return 0;

  let cursor = today;
  // Grace: if there's nothing today yet, start counting from yesterday.
  if (!days.has(dayLabel(cursor, tz))) cursor = new Date(cursor.getTime() - DAY_MS);

  let streak = 0;
  while (days.has(dayLabel(cursor, tz))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/** Distinct calendar days that have any activity, in the given tz. */
export function distinctStudyDays(isoTimestamps: string[], tz: string): number {
  const days = new Set<string>();
  for (const ts of isoTimestamps) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) days.add(dayLabel(d, tz));
  }
  return days.size;
}

export interface XpState {
  xp: number;
  level: number;
  title: string;
  intoLevel: number; // xp earned inside the current level
  forNextLevel: number; // xp span of the current level
  pctToNext: number; // 0..1
}

/** Total XP threshold to reach a level. Level 1 = 0, then a gentle quadratic (100, 300, 600, …). */
export function xpToReach(level: number): number {
  const n = Math.max(1, level);
  return 50 * n * (n - 1);
}

const LEVEL_TITLES: Array<{ min: number; title: string }> = [
  { min: 1, title: "新手 · Newcomer" },
  { min: 3, title: "学生 · Student" },
  { min: 5, title: "书虫 · Bookworm" },
  { min: 8, title: "达人 · Adept" },
  { min: 12, title: "高手 · Expert" },
  { min: 16, title: "大师 · Master" },
];

export function levelTitle(level: number): string {
  let title = LEVEL_TITLES[0].title;
  for (const t of LEVEL_TITLES) if (level >= t.min) title = t.title;
  return title;
}

/**
 * XP from study activity — a tasteful first touch, derived deterministically from real signals:
 * known words (the HSK-3 numerator), distinct study days, logged lessons, and current streak.
 */
export function computeXp(a: {
  knownWords: number;
  studyDays: number;
  lessons: number;
  streakDays: number;
}): XpState {
  const xp =
    a.knownWords * 10 + a.studyDays * 20 + a.lessons * 50 + a.streakDays * 15;

  let level = 1;
  while (xpToReach(level + 1) <= xp) level += 1;

  const base = xpToReach(level);
  const next = xpToReach(level + 1);
  const forNextLevel = next - base;
  const intoLevel = xp - base;
  return {
    xp,
    level,
    title: levelTitle(level),
    intoLevel,
    forNextLevel,
    pctToNext: forNextLevel > 0 ? intoLevel / forNextLevel : 0,
  };
}

export interface FocusArea {
  area: string; // the weak spot, in Lucy's words
  suggestion: string; // a concrete next step
  hits: number; // how many times it showed up in recent evidence (0 if from the week focus)
  fromWeekFocus?: boolean; // true when this item is the week-focus fallback (so the UI can avoid re-rendering it)
}

/** Map a weak-signal phrase to a concrete drill/tool suggestion. Keyword-based, deterministic. */
export function suggestionFor(signal: string): string {
  const s = signal.toLowerCase();
  if (/(listen|dictation|听力|听)/.test(s))
    return "Do one Workbook dictation section today — listening is the standing gap.";
  if (/(是|shì).*(verb|before)|before.*(verb)|是-before/.test(s))
    return "Rewrite 8 sentences dropping 是 before plain verbs (是 only before nouns / in 是不是).";
  if (/(tone|声调|pinyin)/.test(s))
    return "Shadow 10 tone-pair minimal sets in Pleco, recording yourself once.";
  if (/(character|hanzi|汉字|handwrit|stroke)/.test(s))
    return "Handwrite the flagged characters 10× each in the CharWB.";
  if (/(grammar|measure word|word order|结构)/.test(s))
    return "Drill the grammar point with 5 fresh sentences of your own.";
  if (/(vocab|word|词|flashcard|pleco|srs)/.test(s))
    return "Graduate the backlog: make a small Pleco deck (ask me: /cards recent vocab).";
  return "Turn this into today's fix-up drill — ask me for a targeted set.";
}

/**
 * Derive 2–4 actionable focus areas from data Lucy already produced. Primary source: concrete
 * weak-signals collected from recent evidence (most-frequent first). Falls back to the head teacher's
 * week focus, then a steady-state nudge — always returns something coachable.
 */
export function deriveFocusAreas(input: {
  weakSignals: string[];
  weekFocus: string;
}): FocusArea[] {
  const counts = new Map<string, number>();
  for (const raw of input.weakSignals) {
    const sig = raw.trim();
    if (!sig) continue;
    const key = sig.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Preserve first-seen original casing for display.
  const display = new Map<string, string>();
  for (const raw of input.weakSignals) {
    const key = raw.trim().toLowerCase();
    if (key && !display.has(key)) display.set(key, raw.trim());
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const areas: FocusArea[] = ranked.slice(0, 4).map(([key, hits]) => {
    const area = display.get(key) ?? key;
    return { area, suggestion: suggestionFor(area), hits };
  });

  if (areas.length < 2 && input.weekFocus.trim()) {
    areas.push({
      area: `This week's focus: ${input.weekFocus.trim()}`,
      suggestion: suggestionFor(input.weekFocus),
      hits: 0,
      fromWeekFocus: true,
    });
  }
  if (areas.length === 0) {
    areas.push({
      area: "No weak spots flagged recently — nice.",
      suggestion: "Keep the 1.5h/day going and send a check-in so I can spot the next gap. 加油 (jiāyóu)!",
      hits: 0,
    });
  }
  return areas.slice(0, 4);
}

/** Flatten weak-signal phrases out of distilled evidence JSON (most recent first). */
export function collectWeakSignals(
  evidence: Array<{ distilled?: string }>,
  max = 24,
): string[] {
  const out: string[] = [];
  for (const row of evidence) {
    if (!row.distilled) continue;
    try {
      const d = JSON.parse(row.distilled) as { weakSignals?: string[] };
      if (Array.isArray(d.weakSignals)) out.push(...d.weakSignals.filter((s) => typeof s === "string"));
    } catch {
      /* skip malformed */
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// ---- Assembly ---------------------------------------------------------------

export interface DashboardData {
  generatedAt: string;
  timezone: string;
  hasLiveData: boolean;
  coverage: HskCoverage;
  pace: Pace;
  scorecardChecklist: string;
  streak: number;
  studyDays: number;
  xp: XpState;
  weekFocus: string;
  studyMap: string;
  ledger: string;
  gradebook: string;
  focusAreas: FocusArea[];
  activity: ActivityRow[];
  lessons: LessonRow[];
}

/**
 * Assemble everything the dashboard renders, in parallel. Every field comes from the existing brain
 * (Notion + the offline HSK engine); nothing here calls the model, so a page load is cheap and does
 * not spend tokens. Individual reads fail soft so one empty doc never blanks the whole page.
 */
export async function loadDashboard(now: Date = new Date()): Promise<DashboardData> {
  const env = getEnv();
  const tz = env.TIMEZONE;

  const [known, scorecard, studyMap, ledger, gradebook, weekFocus, activity, activityDays, lessons, evidence] =
    await Promise.all([
      getKnownWords().catch(() => [] as string[]),
      readScorecard().catch(() => ""),
      readStudyMap().catch(() => ""),
      readLedger().catch(() => ""),
      readGradebook().catch(() => ""),
      getWeekFocus().catch(() => ""),
      getRecentActivity(30).catch(() => [] as ActivityRow[]),
      getActivityTimestamps(now).catch(() => [] as string[]),
      getRecentLessons(6).catch(() => [] as LessonRow[]),
      getRecentEvidence().catch(() => [] as Array<{ distilled?: string }>),
    ]);

  const coverage = computeCoverage(known);
  const pace = computePace({
    known: coverage.cumulativeKnown,
    target: coverage.cumulativeTotal,
    today: now,
    observedPerWeek: observedPerWeek(scorecard),
  });

  const timestamps = [...activityDays, ...activity.map((a) => a.createdTime)];
  const streak = computeStreak(timestamps, now, tz);
  const studyDays = distinctStudyDays(timestamps, tz);
  const xp = computeXp({
    knownWords: coverage.cumulativeKnown,
    studyDays,
    lessons: lessons.length,
    streakDays: streak,
  });

  const weakSignals = collectWeakSignals(evidence);
  const focusAreas = deriveFocusAreas({ weakSignals, weekFocus });

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    hasLiveData: known.length > 0,
    coverage,
    pace,
    scorecardChecklist: splitScorecard(scorecard).checklist,
    streak,
    studyDays,
    xp,
    weekFocus,
    studyMap,
    ledger,
    gradebook,
    focusAreas,
    activity,
    lessons,
  };
}
