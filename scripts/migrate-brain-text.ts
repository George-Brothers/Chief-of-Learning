/**
 * Targeted, idempotent rewrite of the flashcard-chore and invented-listening lines left in the LIVE
 * Notion brain.
 *
 * The Study Map and Gradebook were seeded before card creation was automated, so they still tell the
 * coach to "clear the vocab backlog into Pleco" — a chore the pipeline
 * (enqueueAction → agent/executor → AnkiConnect) already does unattended — and to work a workbook
 * listening inventory that does not exist. This rewrites ONLY those lines, in place.
 *
 * Deliberately NOT a re-seed: `scripts/seed-knowledge.ts` creates fresh pages from seed/data.ts and
 * would throw away everything the coach has accumulated since. The Knowledge Ledger is never touched
 * here at all — its content is entirely accumulated, so there is no seeded line to fix.
 *
 * Two safety properties, both of which this script previously lacked:
 *
 *  1. EVERY rule must find its target. A rewrite that matches nothing is reported as success by a
 *     naive diff-is-empty check — which is exactly how an anchored `^Only WB Listening…` regex
 *     shipped against a mid-line target and migrated nothing while printing "already clean". A rule
 *     that changes nothing is only acceptable when the doc already reads as the rewrite would have
 *     left it (`Rewrite.done`); otherwise the run fails loudly and exits non-zero.
 *
 *     ONE exception, or the guard cries wolf: the Gradebook page is REGENERATED IN FULL by the Sunday
 *     daily-brief run (writeGradebook), and has been several times. Its seeded lines can therefore be
 *     legitimately gone without any rule being broken, so Gradebook rules are marked
 *     `host: "regenerated"` and their absence prints as a note instead of failing the run. The Study
 *     Map has no such writer, so an absent target there still exits non-zero.
 *
 *  2. It REFUSES to write a page containing any non-paragraph block. readDoc/writeDoc round-trip a
 *     page through plain text, so headings and bulleted lists come back as paragraphs — this script
 *     is the first thing that ever overwrites the Study Map, and flattening the learner's formatting
 *     is not an acceptable side effect of a text fix. Refusing (rather than teaching the migration to
 *     preserve block types) is deliberate: writeDoc's append-then-delete + commit-sentinel protocol
 *     is the most safety-critical code in the repo, and forking a second, block-level write path for
 *     a one-off migration would duplicate it for no benefit. The pages are all paragraphs today, so
 *     the check costs nothing now and turns a silent format loss into a stop the day it isn't true.
 *
 * Idempotent: a rewritten line no longer matches its pattern, so re-running is a no-op. Dry run by
 * default; pass --write to commit.
 *
 *   npm run migrate:brain          # show the diff
 *   npm run migrate:brain -- --write
 */
import {
  readStudyMap, writeStudyMap, studyMapBlockTypes,
  readGradebook, writeGradebook, gradebookBlockTypes,
} from "../lib/notion";
import {
  migrate, unmatchedRules, absentButExpected, STUDY_MAP_REWRITES, GRADEBOOK_REWRITES, type Rewrite,
} from "../lib/brain-migration";
import { requireEnvForScript } from "../lib/env";

// This script needs a Notion token and two page ids — NOT the whole production env. Validate exactly
// those; see requireEnvForScript for why the rest is stubbed. Must run before any lib/notion call.
requireEnvForScript(["NOTION_TOKEN", "NOTION_STUDYMAP_PAGE_ID", "NOTION_GRADEBOOK_PAGE_ID"]);

type Doc = {
  name: string;
  read: () => Promise<string>;
  write: (text: string) => Promise<void>;
  blockTypes: () => Promise<string[]>;
  rewrites: Rewrite[];
};

const DOCS: Doc[] = [
  { name: "Study Map", read: readStudyMap, write: writeStudyMap, blockTypes: studyMapBlockTypes, rewrites: STUDY_MAP_REWRITES },
  { name: "Gradebook", read: readGradebook, write: writeGradebook, blockTypes: gradebookBlockTypes, rewrites: GRADEBOOK_REWRITES },
];

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  let changed = 0;
  const problems: string[] = [];
  const notes: string[] = [];

  for (const doc of DOCS) {
    const before = await doc.read();
    const res = migrate(before, doc.rewrites);

    const unmatched = unmatchedRules(before, res, doc.rewrites);
    for (const r of unmatched) {
      problems.push(`${doc.name}: rule "${r.name}" matched NOTHING and the doc shows no sign it ever ran — its pattern (${r.match}) does not fit the live text.`);
    }
    // Absent on a page another writer regenerates: report, don't fail. See brain-migration.ts.
    for (const r of absentButExpected(before, res, doc.rewrites)) {
      notes.push(`${doc.name}: rule "${r.name}" found no target. Expected — this page is rewritten in full by the Sunday brief, so the seeded line may simply no longer exist. Not a failure; skim the page if the old wording matters.`);
    }

    if (res.diff.length === 0) {
      console.log(`\n${doc.name}: nothing to migrate (already clean).`);
      continue;
    }
    changed += res.diff.length;
    console.log(`\n${doc.name}: ${res.diff.length} line(s)\n${res.diff.join("\n")}`);

    if (!write) continue;

    // Refuse rather than flatten — see the header note.
    const types = await doc.blockTypes();
    const foreign = [...new Set(types.filter((t) => t !== "paragraph"))];
    if (foreign.length > 0) {
      problems.push(`${doc.name}: REFUSING to write — the page contains non-paragraph block(s) [${foreign.join(", ")}] that this text round-trip would flatten into paragraphs. Fix these lines by hand in Notion.`);
      continue;
    }
    await doc.write(res.text);
    console.log(`${doc.name}: written.`);
  }

  if (notes.length > 0) {
    console.log(`\nℹ ${notes.length} note(s):\n${notes.map((n) => `  • ${n}`).join("\n")}`);
  }

  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} problem(s):\n${problems.map((p) => `  • ${p}`).join("\n")}\n`);
    process.exit(1);
  }

  console.log(
    changed === 0
      ? "\n✓ Brain already migrated — no writes needed.\n"
      : write
        ? `\n✓ Migrated ${changed} line(s).\n`
        : `\n${changed} line(s) would change. Re-run with --write to commit.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
