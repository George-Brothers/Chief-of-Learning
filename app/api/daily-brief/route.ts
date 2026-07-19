import { getEnv } from "@/lib/env";
import { runDailyCoach, runWeeklyReview, type Distilled } from "@/lib/ai";
import {
  getUnprocessedEvidence,
  getRecentEvidence,
  markProcessed,
  readDailyLog,
  readStudyMap,
  readLedger,
  readGradebook,
  getWeekFocus,
  getKnownWords,
  readScorecard,
  writeScorecard,
  writeToday,
  prependDailyLog,
  appendLedgerNotes,
  writeGradebook,
  getUnprocessedLessons,
  markLessonsProcessed,
  getRetainedWords,
  getOpenAssignments,
} from "@/lib/notion";
import { runLessonFeedback } from "@/lib/lesson";
import { dispatchActions } from "@/lib/actions";
import { sendMessage } from "@/lib/telegram";
import { classifyDay } from "@/lib/rhythm";
import { makeDeckFromVocab } from "@/lib/deck";
import {
  computeCoverage,
  computePace,
  observedPerWeek,
  updateHist,
  renderComputedBlock,
  nextWordsHint,
  splitScorecard,
  mergeScorecard,
} from "@/lib/hsk";
import { HSK_GRAMMAR } from "@/lib/hsk/data";

export const runtime = "nodejs";
export const maxDuration = 120;

function parseDistilled(rows: { distilled?: string }[]): Distilled[] {
  const out: Distilled[] = [];
  for (const r of rows) {
    if (!r.distilled) continue;
    try {
      out.push(JSON.parse(r.distilled) as Distilled);
    } catch {
      /* skip */
    }
  }
  return out;
}

function weekdayIn(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
}

async function run(req: Request): Promise<Response> {
  const env = getEnv();
  if (req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const now = new Date();
    const isSunday = weekdayIn(now, env.TIMEZONE) === "Sun";

    // 0. Compute the HSK Scorecard (pure CPU, no LLM call). Code owns the COMPUTED block;
    //    the weekly review owns the CHECKLIST block. Both the weekly + daily runs read this.
    const retained = await getRetainedWords();
    const exposed = await getKnownWords();
    const coverage = computeCoverage(retained);
    const prevScorecard = await readScorecard();
    const pace = computePace({
      known: coverage.cumulativeKnown,
      target: coverage.cumulativeTotal,
      today: now,
      observedPerWeek: observedPerWeek(prevScorecard),
    });
    const hist = updateHist(prevScorecard, now, coverage.cumulativeKnown);
    const computedBlock = renderComputedBlock(coverage, pace, hist, exposed.length);
    const dailyScorecard = [computedBlock, nextWordsHint(coverage)].filter(Boolean).join("\n");
    let checklist = splitScorecard(prevScorecard).checklist;
    const openAssignments = await getOpenAssignments();

    // 1. On Sundays, the head teacher (Opus) reviews the week first and sets the focus.
    if (isSunday) {
      const review = await runWeeklyReview({
        weekLog: await readDailyLog(),
        gradebook: await readGradebook(),
        ledger: await readLedger(),
        scorecard: computedBlock,
        grammarPoints: HSK_GRAMMAR.map((g) => `- [HSK${g.band}] ${g.point}`).join("\n"),
        evidence: parseDistilled(await getRecentEvidence()),
      });
      const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE }).format(now);
      await writeGradebook(
        `WEEK FOCUS: ${review.weekFocus}\n\n${review.gradebookUpdate}\n\n--- Weekly report ${stamp} ---\n${review.weeklyReport}`
      );
      if (review.scorecardChecklist.trim()) checklist = review.scorecardChecklist;
    }

    // Persist the scorecard (computed block refreshed daily; checklist preserved/updated).
    await writeScorecard(mergeScorecard(computedBlock, checklist));

    // 2. Daily coach (Sonnet): fold in new evidence, decide today's one action.
    const unprocessed = await getUnprocessedEvidence();
    const dayKind = classifyDay(now, env.TIMEZONE);
    const dayNote = dayKind.lessonTonight
      ? "Today is a lesson day — class tonight."
      : dayKind.lessonToday
        ? "Today is a lesson day."
        : dayKind.dayAfterLesson
          ? "Yesterday was a lesson — corrected homework may be coming."
          : "No lesson today.";

    const daily = await runDailyCoach({
      dailyLog: await readDailyLog(),
      studyMap: await readStudyMap(),
      ledger: await readLedger(),
      weekFocus: await getWeekFocus(),
      scorecard: dailyScorecard,
      dayNote,
      evidence: parseDistilled(unprocessed),
      openAssignments: openAssignments.map((a) => `- [${a.kind}] ${a.description}`).join("\n"),
    });

    // 3. Persist + deliver.
    await writeToday(daily.todayPostit);
    await prependDailyLog(daily.dailyLogEntry);
    if (daily.ledgerNotes.length) await appendLedgerNotes(daily.ledgerNotes.join("\n"));
    if (unprocessed.length) await markProcessed(unprocessed.map((e) => e.id));

    if (daily.newVocab.length) {
      const label = new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE }).format(now);
      await makeDeckFromVocab(`New words ${label}`, daily.newVocab, env.TELEGRAM_ALLOWED_CHAT_ID);
    }

    // --- Post-lesson feedback: only when a lesson transcript came in since the last brief.
    let lessonFeedback = "";
    const lessons = await getUnprocessedLessons();
    if (lessons.length > 0) {
      const fb = await runLessonFeedback({
        lessons,
        studyMap: await readStudyMap(),
        ledger: await readLedger(),
        weekFocus: await getWeekFocus(),
      });
      lessonFeedback = fb.feedback;
      await dispatchActions(fb.actions, env.TELEGRAM_ALLOWED_CHAT_ID);
      await markLessonsProcessed(lessons.map((l) => l.id));
    }

    const message = lessonFeedback ? `${lessonFeedback}\n\n${daily.todayPostit}` : daily.todayPostit;
    await sendMessage(env.TELEGRAM_ALLOWED_CHAT_ID, message);
    return Response.json({ ok: true, weekly: isSunday, processed: unprocessed.length });
  } catch (err) {
    console.error("daily-brief error", err);
    try {
      await sendMessage(
        env.TELEGRAM_ALLOWED_CHAT_ID,
        "⚠️ Lucy's morning run hit a snag and skipped today. The backend needs a look."
      );
    } catch {
      /* ignore */
    }
    return new Response("error", { status: 500 });
  }
}

export const GET = run;
export const POST = run;
