// The acknowledgement a filed submission gets back — ONE message, identical on every surface.
//
// It lives in its own dependency-free module because both the Telegram webhook (photos, captions)
// and the shared text path in lib/command produce it. Keeping one copy is the point: the wording
// carries promises about where the learner's words went, and two copies drift.

import type { Distilled } from "./ai";
import type { Assignment } from "./notion";

/**
 * What we say when the de-dupe suppressed every word.
 *
 * It used to be "Those words are already carded" — a flat assertion, and often a false one: the
 * suppressing set was scraped out of ledger PROSE, so a coach note that merely mentioned a word
 * blocked it forever while the learner was told it was carded (see getCardedWords in lib/notion.ts).
 * The set is now the real card record plus the syllabus, and this line names those two sources
 * instead of asserting knowledge the system does not have.
 */
export const NOTHING_NEW_LINE =
  `📇 Nothing new to add — those are already in your Anki queue or your syllabus.`;

/**
 * The closing acknowledgement for a filed submission.
 *
 * This used to be the bare string "Logged.", which told the learner nothing: they couldn't tell
 * whether the note had been read correctly without opening Notion. Every ingredient here was already
 * computed for the evidence write; we just reflect it back, briefly, so a misread is obvious
 * immediately. An auto-closed assignment is named inline rather than sent as a second message — two
 * notifications for one submission is noise, and an unnamed "Marked done" left the learner guessing
 * which one closed.
 */
export function acknowledgeEvidence(
  distilled: Pick<Distilled, "summary" | "type" | "weakSignals">,
  closed?: Assignment,
  cardLine?: string,
): string {
  const summary = distilled.summary.trim();
  const head = summary
    ? `📝 Got it — ${/[.!?。！？]$/.test(summary) ? summary : `${summary}.`}`
    : `📝 Noted your ${distilled.type}.`;
  const lines = [head];
  if (closed) lines.push(`✅ Marked done: ${closed.description}`);
  // The card line replaces the old "N new words noted" — "noted" said nothing about where they went.
  if (cardLine) lines.push(cardLine);
  if (distilled.weakSignals.length) lines.push(`shaky: ${distilled.weakSignals.slice(0, 2).join(", ")}`);
  // Closing something earns the bigger cheer; a plain log gets the everyday one.
  lines.push(closed ? `真棒 (zhēn bàng)!` : `加油 (jiāyóu)!`);
  return lines.join("\n");
}
