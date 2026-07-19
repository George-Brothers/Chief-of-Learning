// Committed inventory of REAL Mandarin listening sources for an HSK 1–3 learner, plus the pure
// selection used to hand the learner a small, rotating set of named options each morning.
//
// Why committed data (same call as lib/hsk/): the coach was inventing listening assignments
// ("Workbook Listening Comprehension, Section 2 — 30 min") because no inventory existed. A model
// cannot be trusted to name material that exists, so the code names it and the prompt only picks.
//
// RULE FOR EDITING THIS FILE: every entry must be something that verifiably exists today, named the
// way the learner would find it (channel / podcast / app name). Deliberately NO episode numbers,
// section numbers or URLs — those rot, and a wrong one reproduces exactly the bug this file fixes.
// Six sources that are certainly real beat fifteen with invented detail.

export interface ListeningSource {
  id: string;
  /** What the learner searches for, verbatim. */
  name: string;
  /** Where it lives — platform + channel/podcast/app name. No deep links. */
  where: string;
  /** HSK band range the material sits in (inclusive). Shown to the coach; not a filter — every
   *  source here starts at HSK 1 by design, so filtering on it would be theatre. */
  hskMin: number;
  hskMax: number;
  /** Typical length of ONE item (video / episode / lesson), in minutes. */
  minutes: number;
  /** One line on what this source is good for. */
  note: string;
}

export const LISTENING_SOURCES: ListeningSource[] = [
  {
    id: "lazy-chinese",
    name: "Lazy Chinese",
    where: "YouTube — channel “Lazy Chinese”",
    hskMin: 1,
    hskMax: 2,
    minutes: 8,
    note: "Comprehensible input: slow, picture-supported stories for absolute beginners — the gentlest entry point.",
  },
  {
    id: "blabla-chinese",
    name: "Blabla Chinese",
    where: "YouTube — channel “Blabla Chinese”",
    hskMin: 1,
    hskMax: 3,
    minutes: 10,
    note: "Slow, simply-worded spoken Mandarin for beginners — comprehensible input, not grammar explanation.",
  },
  {
    id: "story-learning-annie",
    name: "Story Learning Chinese with Annie",
    where: "YouTube — channel “Story Learning Chinese with Annie”",
    hskMin: 1,
    hskMax: 3,
    minutes: 10,
    note: "Short narrated stories at a steady beginner pace — good for hearing known words in new sentences.",
  },
  {
    id: "mandarin-corner",
    name: "Mandarin Corner",
    where: "YouTube — channel “Mandarin Corner”",
    hskMin: 1,
    hskMax: 3,
    minutes: 15,
    note: "Graded dialogues and street interviews with hanzi + pinyin + English subtitles; watch once without reading first.",
  },
  {
    id: "du-chinese",
    name: "Du Chinese (graded reader with audio)",
    where: "Du Chinese app / duchinese.net — Newbie and Elementary levels",
    hskMin: 1,
    hskMax: 3,
    minutes: 5,
    note: "Every lesson has native audio at normal and slow speed — listen first, only then open the text.",
  },
  {
    id: "chairmans-bao",
    name: "The Chairman's Bao",
    // The site publishes across HSK 1–6; the level filter on its article list is the thing to use.
    where: "thechairmansbao.com — filter the article list to HSK 1–3",
    hskMin: 1,
    hskMax: 3,
    minutes: 4,
    note: "Short HSK-levelled news pieces, each with audio — the fastest way to fit listening into a tight day.",
  },
  {
    id: "coffee-break-chinese",
    name: "Coffee Break Chinese",
    where: "Podcast apps — “Coffee Break Chinese” (Radio Lingua)",
    hskMin: 1,
    hskMax: 2,
    minutes: 20,
    note: "Audio-only lesson podcast with English scaffolding — works while walking or commuting.",
  },
  {
    id: "chinesepod-newbie",
    name: "ChinesePod — Newbie / Elementary",
    where: "ChinesePod (chinesepod.com and podcast apps) — Newbie and Elementary levels",
    hskMin: 1,
    hskMax: 3,
    minutes: 12,
    note: "Dialogue-first lessons: the same short dialogue is replayed slowly and then explained.",
  },
  {
    id: "ic-audio",
    name: "Integrated Chinese Vol. 1 audio",
    where: "Cheng & Tsui companion audio for the textbook and workbook he already owns",
    hskMin: 1,
    hskMax: 2,
    minutes: 5,
    note: "The audio for the exact lesson he is on — closest match to what the tutor will use.",
  },
];

/**
 * Minutes of the day's budget to spend on listening: roughly a quarter, clamped so it is never
 * token (under 10) and never eats the day (over 30). Used to filter out items that can't fit.
 */
export function listeningSlotMinutes(budgetMinutes: number): number {
  return Math.min(30, Math.max(10, Math.round(budgetMinutes * 0.25)));
}

/** Rotate `list` left by `n` (safe for n ≥ 0 and empty lists). */
function rotate<T>(list: T[], n: number): T[] {
  if (list.length === 0) return list;
  const k = n % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

/**
 * Pick the `count` named options to offer today. Pure: same inputs → same output, so the daily brief
 * is reproducible and this is unit-testable.
 *
 * - budget fit: one item has to fit the listening slot; a source longer than the slot is dropped
 *   unless nothing else survives.
 * - rotation: every id still in the (trimmed) recent set is excluded outright — never "unless that
 *   leaves nothing", which is how the old version silently disabled itself. `recentIds` is expected
 *   newest-first and is trimmed to what the pool can spare (`pool.length - count`), so the exclusion
 *   is always honoured and the result is always full-sized. Once the whole inventory is recent, the
 *   OLDEST offers come back round — a deliberate cycle, not a collapse to the unrotated pool.
 * - `seed` (day-of-month at the call site) rotates the survivors so the same one doesn't always lead.
 *
 * No level filter: every entry in the inventory starts at HSK 1 (it was built for an HSK 1–3
 * learner), so an `hskMin <= level` test would pass for everything. Machinery that cannot exclude
 * anything reads as a guarantee and provides none, so it is deliberately absent.
 */
export function selectListeningSources(opts: {
  budgetMinutes: number;
  recentIds?: string[];
  count?: number;
  seed?: number;
  sources?: ListeningSource[];
}): ListeningSource[] {
  const { budgetMinutes, recentIds = [], count = 3, seed = 0 } = opts;
  const all = opts.sources ?? LISTENING_SOURCES;
  const want = Math.max(1, count);
  const slot = listeningSlotMinutes(budgetMinutes);

  const fits = all.filter((s) => s.minutes <= slot);
  const pool = fits.length ? fits : all;

  const spare = Math.max(0, pool.length - want);
  const recent = new Set(recentIds.slice(0, spare));
  const eligible = pool.filter((s) => !recent.has(s.id));

  return rotate(eligible, seed).slice(0, want);
}

function bandLabel(s: ListeningSource): string {
  return s.hskMin === s.hskMax ? `HSK ${s.hskMin}` : `HSK ${s.hskMin}–${s.hskMax}`;
}

/** Render the candidates for the prompt — one line each, with the real band and duration attached. */
export function renderListeningOptions(sources: ListeningSource[]): string {
  return sources
    .map((s) => `- ${s.name} (${s.where}) — ${bandLabel(s)} · ~${s.minutes} min · ${s.note}`)
    .join("\n");
}
