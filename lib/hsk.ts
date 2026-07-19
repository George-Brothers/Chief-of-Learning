// Pure HSK-3.0 coverage + pace engine. No Notion / no I/O so it's unit-testable in isolation.
// Given the learner's known words (from getKnownWords), it computes exact per-band vocab coverage,
// the gap to HSK 3, character-reading coverage, and pace/ETA vs the March-2027 deadline, then
// renders the code-owned block of the HSK Scorecard.

import {
  HSK_WORDS,
  HSK_CHARS,
  HSK_BANDS,
  HSK_TARGET_WORDS,
  HSK_DEADLINE,
  type HskBand,
} from "./hsk/data";

/** Whitespace-insensitive key (mirrors lib/vocab.ts `norm`). Exact whole-word match — never a
 *  substring, so 电 does not credit 电影 and coverage is a conservative undercount, never inflated. */
const norm = (s: string) => s.replace(/\s+/g, "").trim();
const DAY_MS = 86_400_000;
const MISSING_SAMPLE = 15;

export interface BandCoverage {
  band: HskBand;
  total: number;
  known: number;
  pct: number; // 0..1
  missing: string[]; // up to MISSING_SAMPLE not-yet-known words, for the prompts
}

export interface CharCoverage {
  band: HskBand;
  total: number;
  known: number;
  pct: number;
}

export interface HskCoverage {
  bands: BandCoverage[];
  cumulativeKnown: number;
  cumulativeTotal: number; // == HSK_TARGET_WORDS
  gapToTarget: number;
  charBands: CharCoverage[];
  charsKnown: number; // reading proxy: distinct HSK chars appearing in known words
  charsTotal: number;
}

/** Compute vocab + character coverage from the learner's known word list. */
export function computeCoverage(knownWords: string[]): HskCoverage {
  const knownSet = new Set(knownWords.map(norm).filter(Boolean));

  const bands: BandCoverage[] = HSK_BANDS.map((band) => {
    const words = HSK_WORDS.filter((w) => w.band === band);
    const missing: string[] = [];
    let known = 0;
    for (const w of words) {
      if (knownSet.has(norm(w.w))) known++;
      else if (missing.length < MISSING_SAMPLE) missing.push(w.w);
    }
    return { band, total: words.length, known, pct: words.length ? known / words.length : 0, missing };
  });

  // Character reading proxy: which HSK chars appear inside any known word.
  const knownChars = new Set<string>();
  for (const w of knownSet) for (const ch of w) knownChars.add(ch);
  const charBands: CharCoverage[] = HSK_BANDS.map((band) => {
    const chars = HSK_CHARS.filter((c) => c.band === band);
    const known = chars.reduce((n, c) => n + (knownChars.has(c.c) ? 1 : 0), 0);
    return { band, total: chars.length, known, pct: chars.length ? known / chars.length : 0 };
  });

  const cumulativeKnown = bands.reduce((n, b) => n + b.known, 0);
  const charsKnown = charBands.reduce((n, b) => n + b.known, 0);
  return {
    bands,
    cumulativeKnown,
    cumulativeTotal: HSK_TARGET_WORDS,
    gapToTarget: Math.max(0, HSK_TARGET_WORDS - cumulativeKnown),
    charBands,
    charsKnown,
    charsTotal: HSK_CHARS.length,
  };
}

export type Verdict = "ahead" | "on-track" | "behind" | "unknown";

export interface Pace {
  known: number;
  target: number;
  gap: number;
  daysLeft: number;
  wordsPerDayNeeded: number;
  wordsPerWeekNeeded: number;
  observedPerWeek?: number;
  etaDate?: Date;
  verdict: Verdict;
}

/** Pace/ETA vs the deadline. `observedPerWeek` (from scorecard HIST) enables an ETA + verdict. */
export function computePace(a: {
  known: number;
  target: number;
  today: Date;
  deadline?: Date;
  observedPerWeek?: number;
}): Pace {
  const deadline = a.deadline ?? new Date(`${HSK_DEADLINE}T00:00:00Z`);
  const gap = Math.max(0, a.target - a.known);
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - a.today.getTime()) / DAY_MS));
  const wordsPerDayNeeded = daysLeft > 0 ? gap / daysLeft : gap > 0 ? Infinity : 0;

  let etaDate: Date | undefined;
  let verdict: Verdict = "unknown";
  const obs = a.observedPerWeek;
  if (obs !== undefined && obs > 0) {
    const daysToFinish = (gap / obs) * 7;
    etaDate = new Date(a.today.getTime() + daysToFinish * DAY_MS);
    // >2 weeks early = ahead, within 2 weeks = on-track, later = behind.
    const slackMs = etaDate.getTime() - deadline.getTime();
    verdict = slackMs <= -14 * DAY_MS ? "ahead" : slackMs <= 14 * DAY_MS ? "on-track" : "behind";
  } else if (obs === 0) {
    verdict = gap > 0 ? "behind" : "on-track"; // no observed progress but work remains
  } else if (gap === 0) {
    verdict = "ahead";
  }

  return {
    known: a.known,
    target: a.target,
    gap,
    daysLeft,
    wordsPerDayNeeded,
    wordsPerWeekNeeded: wordsPerDayNeeded * 7,
    observedPerWeek: obs,
    etaDate,
    verdict,
  };
}

// ---- Scorecard rendering + two-region split/merge -------------------------

export const SC_COMPUTED = "=== COMPUTED (code-owned — do not edit) ===";
export const SC_CHECKLIST = "=== CHECKLIST (teacher-owned) ===";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Parse the `HIST:` line into dated known-count samples (oldest→newest, robust to junk). */
export function parseHist(scorecard: string): Array<{ date: string; known: number }> {
  const line = scorecard.split("\n").find((l) => l.trim().toUpperCase().startsWith("HIST:"));
  if (!line) return [];
  const out: Array<{ date: string; known: number }> = [];
  for (const m of line.matchAll(/(\d{4}-\d{2}-\d{2})\s*=\s*(\d+)/g)) {
    out.push({ date: m[1], known: Number(m[2]) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Observed words/week from the oldest→newest HIST samples (undefined if <2 points or no span). */
export function observedPerWeek(scorecard: string): number | undefined {
  const h = parseHist(scorecard);
  if (h.length < 2) return undefined;
  const first = h[0];
  const last = h[h.length - 1];
  const days = (Date.parse(last.date) - Date.parse(first.date)) / DAY_MS;
  if (days <= 0) return undefined;
  const perDay = (last.known - first.known) / days;
  return perDay > 0 ? perDay * 7 : 0;
}

/** Append today's known count to HIST, keeping the last `keep` weekly samples. */
export function updateHist(scorecard: string, today: Date, known: number, keep = 8): string {
  const samples = parseHist(scorecard).filter((s) => s.date !== iso(today));
  samples.push({ date: iso(today), known });
  return samples
    .slice(-keep)
    .map((s) => `${s.date}=${s.known}`)
    .join("; ");
}

/** Render the code-owned COMPUTED block (marker included). */
export function renderComputedBlock(cov: HskCoverage, pace: Pace, hist: string, exposedKnown = 0): string {
  const bandLine = cov.bands
    .map((b) => `HSK${b.band} ${b.known}/${b.total} (${pct(b.pct)})`)
    .join(" · ");
  const eta = pace.etaDate ? ` → ETA ${iso(pace.etaDate)}` : "";
  const obs = pace.observedPerWeek !== undefined ? ` Observed ~${pace.observedPerWeek.toFixed(0)}/wk` : "";
  const perDay = Number.isFinite(pace.wordsPerDayNeeded) ? pace.wordsPerDayNeeded.toFixed(1) : "∞";
  const perWeek = Number.isFinite(pace.wordsPerWeekNeeded) ? Math.round(pace.wordsPerWeekNeeded) : "∞";
  const lowConf = exposedKnown > 0 && cov.cumulativeKnown < 0.2 * exposedKnown;
  const lines = [
    SC_COMPUTED,
    `Coverage estimate — retained (SRS-confirmed) words. Target: HSK 3.0 · ${cov.cumulativeTotal} words (bands 1-3) · by ${HSK_DEADLINE}`,
    `Vocab (retained): ${bandLine}`,
    `Cumulative retained: ${cov.cumulativeKnown}/${cov.cumulativeTotal} — gap ${cov.gapToTarget}`,
    `Exposed: ${exposedKnown} words shown (cards made / seen). Retained is the trustworthy number.`,
    `Pace: ${pace.daysLeft} days left → need ${perDay}/day (${perWeek}/wk).${obs}${eta} → ${pace.verdict.toUpperCase()}`,
    `Chars (reading): ${cov.charsKnown}/${cov.charsTotal}`,
    `HIST: ${hist}`,
  ];
  if (lowConf) lines.push(`⚠ low confidence — little review data yet; retained will rise as cards mature.`);
  return lines.join("\n");
}

/** Bands are sequential: master band 1, then 2, then 3. A band counts as "done enough" to move on
 *  at this coverage, so the coach advances instead of stalling on the long tail. */
const BAND_ADVANCE_PCT = 0.9;

/** A "next words to learn" hint for the daily coach: the sample from the LOWEST-numbered band that
 *  isn't near-complete (sequential progression, not lowest-percentage). Capped so it never bloats. */
export function nextWordsHint(cov: HskCoverage): string {
  const target =
    cov.bands.find((b) => b.pct < BAND_ADVANCE_PCT && b.missing.length) ??
    cov.bands.find((b) => b.known < b.total && b.missing.length);
  if (!target) return "";
  return `Next HSK${target.band} words to add (his current band): ${target.missing.join(" ")}`;
}

/** Split a scorecard into its two regions. Missing markers → empty halves (never throws). */
export function splitScorecard(doc: string): { computed: string; checklist: string } {
  const text = doc ?? "";
  const ci = text.indexOf(SC_COMPUTED);
  const hi = text.indexOf(SC_CHECKLIST);
  if (ci === -1 && hi === -1) return { computed: "", checklist: "" };
  if (ci === -1) return { computed: "", checklist: text.slice(hi).trim() };
  if (hi === -1) return { computed: text.slice(ci).trim(), checklist: "" };
  return ci < hi
    ? { computed: text.slice(ci, hi).trim(), checklist: text.slice(hi).trim() }
    : { computed: text.slice(ci).trim(), checklist: text.slice(hi, ci).trim() };
}

/** Recombine the two regions (computed first). Ensures the checklist marker is present. */
export function mergeScorecard(computed: string, checklist: string): string {
  const c = (checklist ?? "").trim();
  const withMarker = c ? (c.includes(SC_CHECKLIST) ? c : `${SC_CHECKLIST}\n${c}`) : SC_CHECKLIST;
  return `${(computed ?? "").trim()}\n\n${withMarker}\n`;
}
