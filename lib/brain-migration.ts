/**
 * The line rewrites that retire the flashcard-chore and invented-listening-material text from the
 * LIVE Notion brain (Study Map + Gradebook). Pure and dependency-free so the rules can be checked
 * against the seed text they were written for — see test/brain-migration.test.ts.
 *
 * `scripts/migrate-brain-text.ts` is the IO shell that reads Notion, applies these, and writes back.
 */

/**
 * One rewrite.
 *  - `match`   the seeded text to retire. MUST stop matching once `replace` is applied — that is what
 *              makes the migration idempotent.
 *  - `done`    recognises the post-state. A rule that matches nothing is a silent no-op bug UNLESS
 *              the doc already carries this, which means the rewrite has simply already run.
 *  - `host`    who owns the page's text, which decides how to read "found neither `match` nor `done`":
 *              · "seeded"      (default) — the page is only ever edited by hand + this migration, so
 *                the seeded target MUST still be there. Absence means the rule's pattern is wrong:
 *                fail loudly.
 *              · "regenerated" — another writer replaces the WHOLE page on a schedule, so the seeded
 *                line can be legitimately gone. Absence is reported as a note, not a failure.
 */
export type Rewrite = {
  name: string; match: RegExp; replace: string; done: RegExp;
  host?: "seeded" | "regenerated";
};

export const STUDY_MAP_REWRITES: Rewrite[] = [
  {
    name: "study-map/vocab-backlog",
    match: /^(\s*\d+\.\s*)Clear the L3 vocab backlog into Pleco\.?\s*$/i,
    replace: "$1Do the L3 vocab reviews already waiting in the deck (cards are made automatically — never by hand).",
    done: /vocab reviews already waiting in the deck/i,
  },
  // The invented-listening-material line: it points the coach at a workbook inventory that does not
  // exist, which is where "Workbook Listening Comprehension, Section 2" came from. NOTE the target
  // sits mid-line ("The notes have almost no listening. Only WB Listening…"), so this must NOT be
  // anchored — an anchored version shipped and silently matched nothing.
  {
    name: "study-map/listening-inventory",
    match: /Only WB Listening Comprehension \+ Fluency Link cover it\.?/i,
    replace:
      "Lucy hands out real, named listening sources each morning (picked by code from " +
      "lib/listening-sources.ts) — listen, then reply with which one you picked and one thing you caught.",
    done: /named listening sources each morning/i,
  },
  {
    name: "study-map/listening-gap-step",
    match: /^(\s*\d+\.\s*)Close the listening gap: one WB Listening section per lesson.*$/i,
    replace: "$1Close the listening gap: listen to one of the sources Lucy offers each day, and report back.",
    done: /listen to one of the sources Lucy offers each day/i,
  },
];

/**
 * EVERY Gradebook rule is `host: "regenerated"`. app/api/daily-brief/route.ts writes the Gradebook page
 * WHOLE every Sunday (`writeGradebook(\`WEEK FOCUS: …\n\n${review.gradebookUpdate}\n\n--- Weekly report …\`)`)
 * from the weekly-review model output, and that has already run several times against the live page.
 * So a seeded Gradebook line may be absent for a perfectly good reason — the model rephrased it away —
 * and treating that as "the rule is broken" makes `npm run migrate:brain` exit 1 on a healthy brain,
 * which is how a fail-loudly guard gets muted for real. The Study Map has no such writer: nothing in
 * the app writes it, so an absent target there really is a broken rule and still fails the run.
 */
export const GRADEBOOK_REWRITES: Rewrite[] = [
  {
    name: "gradebook/vocab-backlog",
    match: /^(\s*-\s*Vocab \/ tutor words\s*\S*)\s*—\s*backlog to clear into Pleco\.?\s*$/i,
    replace: "$1 — cards are auto-created from lessons; the gap is doing the reviews.",
    done: /cards are auto-created from lessons/i,
    host: "regenerated",
  },
  {
    name: "gradebook/week-focus",
    match: /^(WEEK FOCUS:.*?)do 1 WB listening section \(close the listening gap\)\.?\s*$/i,
    replace: "$1listen to one of the offered sources daily (close the listening gap).",
    done: /listen to one of the offered sources daily/i,
    host: "regenerated",
  },
  // The seeded headline verdict grades study time against a flat "≥1.5 hr weekdays", which the per-day
  // budget model (tutor days 60 · Tue/Thu 90 · Fri/Sun 120 — see lib/rhythm.ts) replaced everywhere in
  // code and prompt. The Notion line is still live and is fed back to the coach every day, so it has
  // to go too. Matches mid-line and keeps the rest of the verdict ("This week: …").
  {
    name: "gradebook/study-time-budget",
    match: /(^\s*-\s*Study time:\s*)≥?\s*1\.5\s*hr(?:s)?\s*weekdays\.?/i,
    replace: "$1per-day budget — 60 min on tutor days (Mon/Wed/Sat), 90 min Tue/Thu, 120 min Fri/Sun.",
    done: /60 min on tutor days \(Mon\/Wed\/Sat\)/i,
    host: "regenerated",
  },
];

export type MigrateResult = {
  text: string;
  /** Human-readable `- old` / `+ new` pairs, one per changed line. */
  diff: string[];
  /** Rewrite name → how many lines it changed. Every rule appears, including the zeroes. */
  hits: Record<string, number>;
};

/** Apply the rewrites line by line. First matching rule wins for a given line. */
export function migrate(text: string, rewrites: Rewrite[]): MigrateResult {
  const diff: string[] = [];
  const hits: Record<string, number> = Object.fromEntries(rewrites.map((r) => [r.name, 0]));
  const lines = text.split("\n").map((line) => {
    for (const r of rewrites) {
      if (!r.match.test(line)) continue;
      const next = line.replace(r.match, r.replace);
      diff.push(`- ${line}\n+ ${next}`);
      hits[r.name]++;
      return next;
    }
    return line;
  });
  return { text: lines.join("\n"), diff, hits };
}

/** Every rule that changed nothing and whose post-state is not in the doc either — i.e. its target is
 *  simply not there. `host` decides whether that is a bug or expected; see the two wrappers below. */
function absentRules(before: string, res: MigrateResult, rewrites: Rewrite[]): Rewrite[] {
  return rewrites.filter((r) => res.hits[r.name] === 0 && !r.done.test(before));
}

/**
 * The rules that found no target, left no evidence of having run before, AND live on a page nobody
 * else rewrites. This is the check that turns "the regex never matched" from a success report into a
 * failure: a rewrite that changed nothing is fine only when the document already reads the way the
 * rewrite would have made it — or when the page it targets is regenerated wholesale elsewhere.
 *
 * Keeping the regenerated pages OUT of this list is what stops the guard crying wolf: the Gradebook is
 * replaced in full by the Sunday brief, so its seeded lines being gone says nothing about the rules.
 * Flagging them made `migrate:brain` exit 1 on every run of a perfectly healthy brain — and a guard
 * that always fails is a guard nobody reads. Those rules surface through `absentButExpected` instead.
 */
export function unmatchedRules(before: string, res: MigrateResult, rewrites: Rewrite[]): Rewrite[] {
  return absentRules(before, res, rewrites).filter((r) => (r.host ?? "seeded") === "seeded");
}

/** Absent targets on a page that another writer regenerates — worth PRINTING, never worth failing on. */
export function absentButExpected(before: string, res: MigrateResult, rewrites: Rewrite[]): Rewrite[] {
  return absentRules(before, res, rewrites).filter((r) => r.host === "regenerated");
}
