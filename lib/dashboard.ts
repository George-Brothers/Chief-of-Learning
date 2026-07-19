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
  readToday,
  getOpenAssignments,
  listeningResultLines,
  getActionRows,
  type ActivityRow,
  type LessonRow,
  type Assignment,
  type ActionRow,
} from "./notion";
import {
  getAgentStatus,
  summarizeCardQueue,
  CARD_TASK_TYPE,
  type AgentPresence,
} from "./agent-status";
import { LISTENING_SOURCES, type ListeningSource } from "./listening-sources";
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
    return "Listen to one of the sources Lucy offered this morning, then tell her one thing you caught.";
  if (/(是|shì).*(verb|before)|before.*(verb)|是-before/.test(s))
    return "Rewrite 8 sentences dropping 是 before plain verbs (是 only before nouns / in 是不是).";
  if (/(tone|声调|pinyin)/.test(s))
    return "Shadow 10 tone-pair minimal sets in Pleco, recording yourself once.";
  if (/(character|hanzi|汉字|handwrit|stroke)/.test(s))
    return "Handwrite the flagged characters 10× each in the CharWB.";
  if (/(grammar|measure word|word order|结构)/.test(s))
    return "Drill the grammar point with 5 fresh sentences of your own.";
  if (/(vocab|word|词|flashcard|pleco|srs)/.test(s))
    return "Clear the reviews waiting in your deck — the cards are already made for you.";
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

// ---- Today's plan -----------------------------------------------------------

export interface PlanBlock {
  /** Stable id derived from the block text: the same post-it line always yields the same id, so the
   *  API can resolve an id back to a line server-side without trusting the caller's text.
   *  A stable id is NOT by itself persistence — what survives a reload is the evidence row the tick
   *  writes, which `completedPlanBlockIds` reads back into `DashboardData.completedBlockIds`. */
  id: string;
  /** The step, with any standalone duration decoration stripped out. */
  text: string;
  /** Minutes parsed off the line, or null when the line names no duration. */
  minutes: number | null;
}

export interface TodayPlan {
  /** The post-it exactly as Lucy wrote it — always rendered, so nothing is ever lost to the parser. */
  raw: string;
  blocks: PlanBlock[];
  /** False when nothing looked like a step and `blocks` is just the raw lines (see parseTodayPlan). */
  structured: boolean;
}

/** djb2, base36. Not a security boundary — just a short stable handle for a line of text. */
export function planBlockId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * How a ticked block is written into, and read back out of, the Evidence Inbox.
 *
 * There is no "plan state" store anywhere — the tick's only record is an ordinary evidence row, the
 * same one texting Lucy "did it" produces. So the label below is a contract in both directions: the
 * write side (/api/dashboard/plan) composes it, and the read side recovers the block id from it to
 * decide which boxes render checked and whether a second tick would be a duplicate. Change the
 * shape here and both sides move together; change it in the route alone and ticks stop persisting.
 */
export const PLAN_DONE_SUMMARY_PREFIX = "Completed from today's plan: ";

/** The label a ticked block is logged under — the step text plus the duration it named, if any. */
export function planBlockLabel(block: { text: string; minutes: number | null }): string {
  return block.minutes ? `${block.text} (${block.minutes} min)` : block.text;
}

const LABEL_DURATION_RE = /\s*\(\d+(?:\.\d+)?\s*min\)$/;

/** Inverse of planBlockLabel + planBlockId: the block id a logged label refers to. */
export function planBlockIdFromLabel(label: string): string {
  return planBlockId(label.replace(LABEL_DURATION_RE, "").trim());
}

/**
 * Which of today's plan blocks are already logged as done, read out of the activity feed the page
 * loads anyway (no extra Notion round-trip).
 *
 * Scoped to the learner's local day on purpose: a post-it line repeats across days ("20 min
 * shadowing"), and its id is a hash of the text, so yesterday's tick would otherwise arrive
 * pre-checked this morning. Rows that aren't dashboard ticks don't carry the prefix and are skipped.
 */
export function completedPlanBlockIds(
  rows: Array<{ createdTime: string; summary: string }>,
  now: Date,
  tz: string,
): string[] {
  const today = dayLabel(now, tz);
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.summary?.startsWith(PLAN_DONE_SUMMARY_PREFIX)) continue;
    const at = new Date(row.createdTime);
    if (Number.isNaN(at.getTime()) || dayLabel(at, tz) !== today) continue;
    out.add(planBlockIdFromLabel(row.summary.slice(PLAN_DONE_SUMMARY_PREFIX.length)));
  }
  return [...out];
}

const DURATION_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;
// A duration used as decoration rather than as part of the sentence: "(30 min)" or a trailing
// "— 30 min". Only these get stripped; "spend 20 minutes on tones" keeps its wording.
const DURATION_DECORATION_RE =
  /\s*(?:[([]\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\s*[)\]]|[—–-]\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m))\s*$/i;

/** Minutes named on a line, or null. Hours are converted; anything ≤0 is treated as absent. */
export function parseDurationMinutes(line: string): number | null {
  const m = DURATION_RE.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const hours = /^h/i.test(m[2]);
  return Math.round(hours ? n * 60 : n);
}

/** Leading list/progress markers Lucy's post-it uses: "- ", "1. ", "• ", "[ ] ", "2/2 ". */
const MARKER_RE = /^(?:[-*•·–—]|\d+[.)]|\[[ xX]?\]|\d+\/\d+)\s+/;

/**
 * A line is a step if it reads like an instruction: four or more words, or any named duration.
 * This is what keeps the sign-off ("加油！(jiāyóu)") and bare headers from becoming checkboxes.
 */
function looksLikeStep(line: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(line)) return false;
  if (parseDurationMinutes(line) !== null) return true;
  return line.split(/\s+/).filter(Boolean).length >= 4;
}

/**
 * Parse the Today post-it into checkable blocks. Deliberately forgiving: the post-it is free text
 * written by a model, so anything that doesn't read like a step is left out of `blocks` and the raw
 * text is always returned alongside. If NO line reads like a step (a one-liner day, an unusual
 * format), every non-empty line becomes a block and `structured` is false — the learner still gets
 * something to tick rather than an empty card.
 */
export function parseTodayPlan(raw: string): TodayPlan {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const toBlock = (line: string): PlanBlock => {
    const stripped = line.replace(MARKER_RE, "").trim();
    const minutes = parseDurationMinutes(stripped);
    const text = stripped.replace(DURATION_DECORATION_RE, "").trim() || stripped;
    return { id: planBlockId(text), text, minutes };
  };

  const steps = lines.filter(looksLikeStep);
  const structured = steps.length > 0;
  const source = structured ? steps : lines;
  // De-dupe by id: two identical lines would otherwise give the UI two boxes that resolve to one.
  const seen = new Set<string>();
  const blocks: PlanBlock[] = [];
  for (const b of source.map(toBlock)) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    blocks.push(b);
  }
  return { raw, blocks, structured };
}

// ---- Open assignments -------------------------------------------------------

export interface OpenAssignmentView {
  id: string;
  kind: string;
  description: string;
  createdTime: string;
  /** Whole days since it was set. 0 for today's, and 0 when the timestamp is missing/unparseable. */
  daysCarried: number;
}

export function daysCarried(createdTime: string, now: Date): number {
  const d = new Date(createdTime);
  if (!createdTime || Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));
}

// ---- Listening tracker ------------------------------------------------------

export interface ListeningCheck {
  date: string; // YYYY-MM-DD as written by the store
  ok: boolean;
  word: string;
}

export interface ListeningOffer {
  date: string;
  /** Source names resolved from the ids in the log; unknown ids pass through verbatim. */
  sources: string[];
}

export interface ListeningTracker {
  /** Cloze checks, newest first. */
  checks: ListeningCheck[];
  /** What was offered on recent mornings, newest first. */
  offers: ListeningOffer[];
  /** Cloze checks inside the last 7 calendar days. */
  weekCount: number;
  /** Running accuracy over the recent checks. */
  correct: number;
  total: number;
  /** Inventory entries that haven't been offered in the recent log — what to reach for next. */
  unusedSources: ListeningSource[];
}

/**
 * Parse the listening store's result block. Two line shapes share it (see lib/notion.ts):
 * a cloze check "2026-07-19 ✓ 跳舞", and an offer "2026-07-19 🎧 lazy-chinese,du-chinese".
 * Anything else is ignored rather than guessed at.
 */
export function parseListeningLog(lines: string[]): {
  checks: ListeningCheck[];
  offers: Array<{ date: string; ids: string[] }>;
} {
  const checks: ListeningCheck[] = [];
  const offers: Array<{ date: string; ids: string[] }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? "";
    if (line.includes("🎧")) {
      const ids = line
        .slice(line.indexOf("🎧") + "🎧".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length) offers.push({ date, ids });
      continue;
    }
    const ok = line.includes("✓");
    if (!ok && !line.includes("✗")) continue;
    const word = line.slice(line.indexOf(ok ? "✓" : "✗") + 1).trim();
    checks.push({ date, ok, word });
  }
  return { checks, offers };
}

/** Checks falling inside the 7 calendar days ending today, compared on tz day labels. */
export function listeningWeekCount(checks: ListeningCheck[], now: Date, tz: string): number {
  const window = new Set<string>();
  for (let i = 0; i < 7; i++) window.add(dayLabel(new Date(now.getTime() - i * DAY_MS), tz));
  return checks.filter((c) => window.has(c.date)).length;
}

/** Inventory entries absent from `offeredIds` — the sources that have gone cold. */
export function unusedListeningSources(
  offeredIds: string[],
  sources: ListeningSource[] = LISTENING_SOURCES,
): ListeningSource[] {
  const used = new Set(offeredIds);
  return sources.filter((s) => !used.has(s.id));
}

/** Assemble the whole tracker from the store's raw result lines. Pure. */
export function buildListeningTracker(
  lines: string[],
  now: Date,
  tz: string,
  sources: ListeningSource[] = LISTENING_SOURCES,
): ListeningTracker {
  const { checks, offers } = parseListeningLog(lines);
  const byId = new Map(sources.map((s) => [s.id, s.name]));
  // "Lately" = the last 10 offer lines, i.e. roughly a fortnight of mornings. Anything older is
  // stale enough that re-offering it is the point.
  const recentOfferIds = offers.slice(0, 10).flatMap((o) => o.ids);
  const recentChecks = checks.slice(0, 20);
  return {
    checks: checks.slice(0, 10),
    offers: offers.slice(0, 5).map((o) => ({
      date: o.date,
      sources: o.ids.map((id) => byId.get(id) ?? id),
    })),
    weekCount: listeningWeekCount(checks, now, tz),
    correct: recentChecks.filter((c) => c.ok).length,
    total: recentChecks.length,
    unusedSources: unusedListeningSources(recentOfferIds, sources),
  };
}

// ---- Lesson history ---------------------------------------------------------

export interface LessonHistoryEntry {
  id: string;
  date: string;
  summary: string;
  weakSignals: string;
  homework: string;
  /** From the distilled lesson note. Empty when the note is missing or malformed. */
  vocabIntroduced: Array<{ headword: string; pinyin: string; definition: string }>;
  errors: Array<{ quote: string; kind: string; correction: string }>;
  /** Things he reached for and couldn't produce — stored by the lesson distiller, never shown
   *  anywhere until now, and the single most useful signal in the note. */
  couldNotSay: string[];
  grammarPoints: string[];
  durationMinutes: number | null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Flatten Lesson rows + their distilled note JSON into what the UI shows. Every field of the note is
 * treated as optional: these rows are model output, and one malformed note must not blank the
 * lesson's own summary/homework, which come from the row's properties.
 */
export function parseLessonHistory(
  rows: Array<{
    id: string;
    date: string;
    summary: string;
    weakSignals: string;
    homework: string;
    noteJson: string;
  }>,
): LessonHistoryEntry[] {
  return rows.map((r) => {
    let note: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.noteJson || "{}");
      if (parsed && typeof parsed === "object") note = parsed as Record<string, unknown>;
    } catch {
      /* row properties still carry the essentials */
    }
    const vocab = Array.isArray(note.vocabIntroduced) ? note.vocabIntroduced : [];
    const errs = Array.isArray(note.errors) ? note.errors : [];
    const duration = typeof note.durationMinutes === "number" ? note.durationMinutes : null;
    return {
      id: r.id,
      date: r.date,
      summary: r.summary,
      weakSignals: r.weakSignals,
      homework: r.homework,
      vocabIntroduced: vocab.map((v: any) => ({
        headword: String(v?.headword ?? ""),
        pinyin: String(v?.pinyin ?? ""),
        definition: String(v?.definition ?? ""),
      })).filter((v) => v.headword),
      errors: errs.map((e: any) => ({
        quote: String(e?.quote ?? ""),
        kind: String(e?.kind ?? ""),
        correction: String(e?.correction ?? ""),
      })).filter((e) => e.quote || e.correction),
      couldNotSay: strings(note.couldNotSay),
      grammarPoints: strings(note.grammarPoints),
      durationMinutes: duration && duration > 0 ? duration : null,
    };
  });
}

/**
 * Pure: fold agent presence + the raw queue rows into the panel. Kept separate from `loadDashboard`
 * so the alarm logic is unit-testable without Notion.
 */
export function buildAgentPanel(
  status: { presence: AgentPresence; lastSeenIso?: string; ankiReachable?: boolean },
  rows: ReadonlyArray<ActionRow>,
): AgentPanel {
  const q = summarizeCardQueue(rows);
  const errors = rows
    .filter((r) => r.type === CARD_TASK_TYPE && r.status === "error")
    .slice(0, 5)
    .map((r) => {
      let label = "";
      try {
        label = String((JSON.parse(r.payload) as { label?: unknown })?.label ?? "");
      } catch {
        /* an unreadable payload still deserves a row on the page */
      }
      return { id: r.id, label: label || "unlabelled batch", result: r.result };
    });
  return {
    presence: status.presence,
    lastSeenIso: status.lastSeenIso ?? null,
    ankiReachable: status.ankiReachable ?? null,
    queuedTasks: q.tasks,
    queuedCards: q.cards,
    erroredTasks: q.erroredTasks,
    errors,
  };
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
  /** What he's supposed to DO today — the same post-it Lucy texted, as checkable blocks. */
  todayPlan: TodayPlan;
  /** Ids of today's blocks already ticked (from evidence), so a reload renders them still checked. */
  completedBlockIds: string[];
  openAssignments: OpenAssignmentView[];
  listening: ListeningTracker;
  lessonHistory: LessonHistoryEntry[];
  /** Is the thing that actually makes the Anki cards alive, and what is stuck behind it? */
  agent: AgentPanel;
}

/**
 * The local-agent readout.
 *
 * Everything else on this page describes the learner. This describes the MACHINERY, and it is here
 * because the machinery failing looked exactly like the learner resting: cards enqueued to Notion,
 * nothing draining them, no surface anywhere that said so.
 */
export interface AgentPanel {
  presence: AgentPresence;
  /** When the laptop agent last checked in. `null` = never, which was the true state for weeks. */
  lastSeenIso: string | null;
  /** AnkiConnect's answer on the agent's last probe. `null` = never probed / no heartbeat. */
  ankiReachable: boolean | null;
  /** Queued `create_anki_cards` batches and the cards inside them. */
  queuedTasks: number;
  queuedCards: number;
  /** Batches that ended in Status "error" — dead until re-driven. */
  erroredTasks: number;
  /** The most recent errored batches, so a failure has a face and not just a count. */
  errors: Array<{ id: string; label: string; result: string }>;
}

/**
 * Assemble everything the dashboard renders, in parallel. Every field comes from the existing brain
 * (Notion + the offline HSK engine); nothing here calls the model, so a page load is cheap and does
 * not spend tokens. Individual reads fail soft so one empty doc never blanks the whole page.
 */
export async function loadDashboard(now: Date = new Date()): Promise<DashboardData> {
  const env = getEnv();
  const tz = env.TIMEZONE;

  const [
    known,
    scorecard,
    studyMap,
    ledger,
    gradebook,
    weekFocus,
    activity,
    activityDays,
    lessons,
    evidence,
    todayText,
    assignments,
    listeningLines,
    actionRows,
    agentStatus,
  ] = await Promise.all([
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
    // Every new read fails soft exactly like the ones above: one unreachable Notion page degrades
    // its own card, never the page.
    readToday().catch(() => ""),
    getOpenAssignments().catch(() => [] as Assignment[]),
    listeningResultLines().catch(() => [] as string[]),
    getActionRows().catch(() => [] as ActionRow[]),
    // getAgentStatus already swallows its own failures into "unknown"; the catch is belt-and-braces
    // so this read can never be the one that blanks the page.
    getAgentStatus(now.getTime()).catch(() => ({ presence: "unknown" as AgentPresence })),
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
    todayPlan: parseTodayPlan(todayText),
    completedBlockIds: completedPlanBlockIds(activity, now, tz),
    openAssignments: assignments.map((a) => ({ ...a, daysCarried: daysCarried(a.createdTime, now) })),
    listening: buildListeningTracker(listeningLines, now, tz),
    lessonHistory: parseLessonHistory(lessons),
    agent: buildAgentPanel(agentStatus, actionRows),
  };
}
