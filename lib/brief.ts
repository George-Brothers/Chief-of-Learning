import type { DayKind } from "./rhythm";

export type BriefInput = {
  oneThing: string;
  focusAreas: string[];
  dayKind: DayKind;
  quietDays: number;
  quietThreshold: number;
  nothingNew: boolean;
};

/**
 * Compose the morning post-it. Firm coach voice, 1.5h baseline, never more than ~4 lines.
 * - Past the quiet threshold: lead with a firm nudge.
 * - Nothing new and no lesson: one short line and stop.
 * - Otherwise: one concrete action, one weak spot, and any lesson/homework line.
 */
/** First sentence only, whitespace-collapsed, no trailing period — keeps the post-it a post-it. */
function oneLine(s: string): string {
  const first = s.split(/(?<=[.?!])\s+/)[0] ?? s;
  return first.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

export function composeBrief(i: BriefInput): string {
  const lines: string[] = [];
  const one = oneLine(i.oneThing);

  const overThreshold = i.quietDays >= i.quietThreshold;
  if (overThreshold) {
    lines.push(`It's been ${i.quietDays} quiet days. Where's your 1.5 hours? Start now.`);
  }

  if (i.nothingNew && !i.dayKind.lessonToday && !overThreshold) {
    lines.push(`On track. Today's 90 min: ${one}.`);
    return lines.join("\n") + "\n";
  }

  lines.push(`Your 1.5 hours today — start with: ${one}.`);
  if (i.focusAreas.length) lines.push(`Weak spot to hit: ${i.focusAreas[0]}.`);
  if (i.dayKind.lessonTonight) lines.push(`Class tonight — review so you show up sharp.`);
  else if (i.dayKind.lessonToday) lines.push(`Lesson today — be ready.`);
  if (i.dayKind.dayAfterLesson) lines.push(`Send me a photo of your corrected homework.`);

  return lines.slice(0, 4).join("\n") + "\n";
}
