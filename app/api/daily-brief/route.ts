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
  getRecentListeningSourceIds,
  recordListeningOffer,
  getActionRows,
} from "@/lib/notion";
import { runLessonFeedback } from "@/lib/lesson";
import { dispatchActions, enqueueCards } from "@/lib/actions";
import { sendMessage } from "@/lib/telegram";
import { classifyDay, studyPlanShape } from "@/lib/rhythm";
import { selectListeningSources, renderListeningOptions } from "@/lib/listening-sources";
import {
  getAgentStatus,
  cardsQueuedMessage,
  summarizeCardQueue,
  agentDownAlert,
  queueErrorAlert,
} from "@/lib/agent-status";
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

    // Real minute budget for today (tutor days are shorter), and 2–3 REAL named listening sources
    // to offer. Both exist so the coach stops inventing durations and workbook section numbers.
    const shape = studyPlanShape(now, env.TIMEZONE);
    const listeningCandidates = selectListeningSources({
      budgetMinutes: shape.budgetMinutes,
      recentIds: await getRecentListeningSourceIds(),
      count: 3,
      // Day-of-month in the learner's timezone, like every other date here — on a UTC clock the
      // seed rolls over mid-evening and two briefs a day apart could share it.
      seed: Number(new Intl.DateTimeFormat("en-US", { timeZone: env.TIMEZONE, day: "numeric" }).format(now)),
    });

    const daily = await runDailyCoach({
      dailyLog: await readDailyLog(),
      studyMap: await readStudyMap(),
      ledger: await readLedger(),
      weekFocus: await getWeekFocus(),
      scorecard: dailyScorecard,
      dayNote,
      evidence: parseDistilled(unprocessed),
      openAssignments: openAssignments.map((a) => `- [${a.kind}] ${a.description}`).join("\n"),
      budgetMinutes: shape.budgetMinutes,
      listeningOptions: renderListeningOptions(listeningCandidates),
    });

    // 3. Persist + deliver.
    await writeToday(daily.todayPostit);
    // Remember what was offered so tomorrow rotates past it. The store has no per-source field, so
    // this records what CODE offered, not what he picked — enough to stop repeating the same two.
    // Best-effort on purpose: it sits mid-way through the persist sequence, and a Notion hiccup in
    // rotation bookkeeping must never abort the brief between writeToday and the Telegram send.
    // Worst case tomorrow repeats a source.
    try {
      await recordListeningOffer(
        listeningCandidates.map((s) => s.id),
        new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE }).format(now)
      );
    } catch (err) {
      console.warn("recordListeningOffer failed (brief continues)", err);
    }
    await prependDailyLog(daily.dailyLogEntry);
    if (daily.ledgerNotes.length) await appendLedgerNotes(daily.ledgerNotes.join("\n"));
    if (unprocessed.length) await markProcessed(unprocessed.map((e) => e.id));

    // Same gap as the Telegram photo path: these words only ever became a Pleco .txt, so the brief's
    // own vocab never reached Anki. Now they go to the queue and the brief carries a one-line
    // CONFIRMATION instead of a file to import. Fail-open — the brief must still go out.
    let cardLine = "";
    if (daily.newVocab.length) {
      const label = new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE }).format(now);
      try {
        const queued = await enqueueCards(daily.newVocab, `daily ${label}`);
        if (queued > 0) cardLine = cardsQueuedMessage(queued, await getAgentStatus());
      } catch (err) {
        console.error("daily-brief: could not queue Anki cards", err);
      }
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

    // --- Loud failure. Assembled in CODE and put FIRST, above anything the model wrote, because a
    // dead pipeline is the single most expensive thing that can be silently true: for weeks the local
    // agent being down was indistinguishable from a week with nothing to study. The model is never
    // asked about this and never sees it, so it cannot soften it, forget it, or invent it on a day
    // when the agent is fine. Both lines self-suppress when there is nothing stuck — no nagging.
    let alerts = "";
    try {
      const queue = summarizeCardQueue(await getActionRows());
      alerts = [agentDownAlert(await getAgentStatus(), queue, now.getTime()), queueErrorAlert(queue)]
        .filter(Boolean)
        .join("\n");
    } catch (err) {
      console.error("daily-brief: could not read the action queue for agent alerts", err);
    }

    const body = lessonFeedback ? `${lessonFeedback}\n\n${daily.todayPostit}` : daily.todayPostit;
    const message = [alerts, body, cardLine].filter(Boolean).join("\n\n");
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
