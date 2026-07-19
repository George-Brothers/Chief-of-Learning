import { z } from "zod";
import { runObject, runText, answerQuestion, distillEvidence, type Distilled } from "./ai";
import { COACH_SYSTEM, CLASSIFY_PROMPT, CARD_ASSEMBLY_PROMPT, STATUS_PROMPT } from "./prompts";

export const IntentSchema = z.object({
  // "answer_log" is the HYBRID: a message that both reports work and asks about it. It exists because
  // the two single intents each lose half of such a message — "answer" replies and files nothing (the
  // reported study never reaches the scorecard, never closes an assignment, never yields cards), and
  // "log" files it and leaves the question hanging. See handleAnswerAndLog.
  intent: z.enum(["make_cards", "feedback", "status", "listen", "answer", "answer_log", "log"]),
  request: z.string(),
});
export type Intent = z.infer<typeof IntentSchema>;

export async function classifyCommand(text: string): Promise<Intent> {
  return runObject("classify", "classify-command", {
    schema: IntentSchema,
    system: COACH_SYSTEM,
    prompt: `${CLASSIFY_PROMPT}\n\nMESSAGE: ${text}`,
  });
}

const CardSchema = z.object({
  headword: z.string(), pinyin: z.string(), definition: z.string(), example: z.string(),
});
export type Card = z.infer<typeof CardSchema>;

export const CardsResultSchema = z.object({
  source: z.string(), label: z.string(), cards: z.array(CardSchema),
});
export type CardsResult = z.infer<typeof CardsResultSchema>;

export async function buildCardsForRequest(
  request: string,
  ctx: { syllabus: string; lessons: string; known: string[] },
): Promise<CardsResult> {
  return runObject("reason", "build-cards", {
    schema: CardsResultSchema,
    system: COACH_SYSTEM,
    prompt: `${CARD_ASSEMBLY_PROMPT.replace("<REQUEST>", request)}

=== SYLLABUS INDEX (chapters -> vocab) ===
${ctx.syllabus || "(none loaded)"}

=== RECENT RECORDED LESSONS ===
${ctx.lessons || "(none)"}

=== ALREADY-KNOWN WORDS (exclude these) ===
${ctx.known.join(" ") || "(none)"}`,
  });
}

export async function composeStatus(ctx: {
  computedBlock: string; gradebook: string; studyMap: string; weekFocus: string;
}): Promise<string> {
  return runText("chat", "compose-status", {
    system: COACH_SYSTEM,
    prompt: `${STATUS_PROMPT}

=== HSK SCORECARD (computed) ===
${ctx.computedBlock}

=== GRADEBOOK ===
${ctx.gradebook || "(empty)"}

=== STUDY MAP ===
${ctx.studyMap || "(empty)"}

=== THIS WEEK'S FOCUS ===
${ctx.weekFocus || "(not set)"}`,
  });
}

import { sendMessage } from "./telegram";
import {
  addEvidence,
  getKnownWords, getCardedWords, readSyllabus, getRecentLessons,
  readScorecard, readGradebook, readStudyMap, readLedger, getWeekFocus,
  getRetainedWords, getOpenAssignments, markAssignmentDone, type Assignment,
  readListeningPending, writeListeningPending, recordListeningResult, getListeningStats,
  lessonExists, addLesson,
  getActionRows, requeueAction,
} from "./notion";
import { buildQuestionBrain } from "./brain";
import { runLessonFeedback, distillLesson } from "./lesson";
import { contentHash } from "../agent/hash";
import { dispatchActions, enqueueCards } from "./actions";
import { makeDeckFromVocab } from "./deck";
import {
  getAgentStatus,
  cardsQueuedMessage,
  summarizeCardQueue,
  CARD_TASK_TYPE,
} from "./agent-status";
import { computeCoverage, computePace, observedPerWeek, updateHist, renderComputedBlock } from "./hsk";
import { acknowledgeEvidence, NOTHING_NEW_LINE } from "./ack";

/**
 * A reply sink. The command layer used to write straight to Telegram; it now hands each user-facing
 * line to a Responder so the SAME handlers can serve Telegram (send to the chat) or the web dashboard
 * (collect the text into an HTTP response). Defaults to Telegram, so existing callers are unchanged.
 */
export type Responder = (text: string) => Promise<void>;

const telegramResponder = (chatId: string): Responder => (text) => sendMessage(chatId, text);

export async function handleMakeCards(
  request: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  // getCardedWords, not getKnownWords: a word that only ever went out as a Pleco .txt is "exposed",
  // not "known", and filtering on the wider set meant sending a word made it impossible to ever card
  // it — /cards would answer "you already know those" forever. See lib/notion.ts.
  const [syllabus, lessons, known] = await Promise.all([
    readSyllabus().catch(() => []),
    getRecentLessons(5).catch(() => []),
    getCardedWords().catch(() => [] as string[]),
  ]);
  const syllabusDigest = syllabus.map((s) => `${s.chapter}: ${s.vocab}`).join("\n");
  const lessonsDigest = lessons.map((l) => `${l.date}: ${l.summary}`).join("\n");
  const res = await buildCardsForRequest(request, { syllabus: syllabusDigest, lessons: lessonsDigest, known });
  // The filter lives in enqueueCards (one implementation, shared by every producer); `known` is
  // handed over so this doesn't re-read Notion for a set it already has.
  const queued = await enqueueCards(res.cards, res.label, { known });
  if (queued === 0) {
    // Not "you already know those" — the filter proves a card exists (or the syllabus covers it),
    // never that the learner knows the word. Say what was actually checked.
    await reply(`${NOTHING_NEW_LINE} 加油 (jiāyóu)!`);
    return;
  }
  // Honest wording comes from observed agent state, not from optimism: "I'll ping you when they're
  // in Anki" implied a working pipeline even while the local agent was down (see lib/agent-status.ts).
  await reply(`On it — ${res.label} (source: ${res.source}).\n${cardsQueuedMessage(queued, await getAgentStatus())}`);
}

export async function handleFeedback(
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const lessons = await getRecentLessons(3);
  if (lessons.length === 0) {
    await reply(`No lessons on record yet — send me a transcript first and I'll dig in.`);
    return;
  }
  const [studyMap, ledger, weekFocus] = await Promise.all([readStudyMap(), readLedger(), getWeekFocus()]);
  const fb = await runLessonFeedback({ lessons, studyMap, ledger, weekFocus });
  await reply(fb.feedback);
  await dispatchActions(fb.actions, chatId);
}

export async function handleStatus(
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const [retained, exposed] = await Promise.all([getRetainedWords(), getKnownWords()]);
  const coverage = computeCoverage(retained);
  const prev = await readScorecard();
  const now = new Date();
  const pace = computePace({ known: coverage.cumulativeKnown, target: coverage.cumulativeTotal, today: now, observedPerWeek: observedPerWeek(prev) });
  const computedBlock = renderComputedBlock(coverage, pace, updateHist(prev, now, coverage.cumulativeKnown), exposed.length);
  const [gradebook, studyMap, weekFocus] = await Promise.all([readGradebook(), readStudyMap(), getWeekFocus()]);
  const snapshot = await composeStatus({ computedBlock, gradebook, studyMap, weekFocus });
  const lsn = await getListeningStats();
  const withLsn = lsn.total > 0 ? `${snapshot}\n🎧 Listening: ${lsn.correct}/${lsn.total} recent` : snapshot;
  await reply(withLsn);
}

/**
 * `/agent` — is the thing that makes the cards actually running, and what is stuck?
 *
 * This is the manual counterpart to the daily brief's automatic alarm, and the ONLY way a burned
 * queue row can be re-driven from the phone. Errored rows keep their full payload, so re-queueing
 * loses nothing: the executor re-reads the same cards, and `addCards` de-dupes against the whole
 * `Chinese::*` tree, so a batch that partly landed cannot double up.
 */
export async function handleAgent(
  arg: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const rows = await getActionRows().catch(() => []);
  const queue = summarizeCardQueue(rows);

  if (/^(retry|flush|redrive|re-drive)\b/i.test(arg.trim())) {
    const stuck = rows.filter((r) => r.type === CARD_TASK_TYPE && r.status === "error");
    if (stuck.length === 0) {
      await reply(`Nothing failed — there's nothing to retry. 加油 (jiāyóu)!`);
      return;
    }
    let ok = 0;
    for (const r of stuck) {
      try {
        await requeueAction(r.id);
        ok += 1;
      } catch (err) {
        console.error("agent retry: could not re-queue", r.id, err);
      }
    }
    const failed = stuck.length - ok;
    await reply(
      `♻️ Re-queued ${ok} failed batch${ok === 1 ? "" : "es"}${failed ? ` (${failed} wouldn't budge — Notion refused)` : ""}. ` +
        `They go in the moment the laptop agent and Anki are both running.`,
    );
    return;
  }

  const status = await getAgentStatus();
  const seen = status.lastSeenIso
    ? `last check-in ${new Date(status.lastSeenIso).toISOString().replace("T", " ").slice(0, 16)} UTC`
    : `has never checked in`;
  const anki =
    status.ankiReachable === undefined
      ? "Anki: never probed"
      : status.ankiReachable
        ? "Anki: reachable"
        : "Anki: not answering";
  const presence =
    status.presence === "online" ? "🟢 running" : status.presence === "offline" ? "🔴 not running" : "⚪ can't tell";
  const lines = [
    `Anki agent: ${presence} — ${seen}. ${anki}.`,
    queue.tasks
      ? `📇 ${queue.cards || queue.tasks} waiting in ${queue.tasks} batch${queue.tasks === 1 ? "" : "es"}.`
      : `📇 Queue empty — nothing waiting.`,
  ];
  if (queue.erroredTasks) {
    lines.push(
      `⚠️ ${queue.erroredTasks} batch${queue.erroredTasks === 1 ? "" : "es"} failed. Send /agent retry to put ${queue.erroredTasks === 1 ? "it" : "them"} back in the queue.`,
    );
  }
  await reply(lines.join("\n"));
}

export async function handleDone(text: string, chatId: string): Promise<void> {
  const open = await getOpenAssignments();
  if (open.length === 0) { await sendMessage(chatId, `Nothing open right now. 加油 (jiāyóu)!`); return; }
  const q = text.trim().toLowerCase();
  const matches = q ? open.filter((a) => a.description.toLowerCase().includes(q)) : [];
  let target = matches.length === 1 ? matches[0] : undefined;
  if (!target && !q && open.length === 1) target = open[0];
  if (!target) {
    await sendMessage(chatId, `Which one?\n${open.map((a, i) => `${i + 1}. [${a.kind}] ${a.description}`).join("\n")}\n(reply /done <word from it>)`);
    return;
  }
  await markAssignmentDone(target.id);
  await sendMessage(chatId, `✅ Done: ${target.description}. 真棒 (zhēn bàng)!`);
}

/**
 * Auto-close an assignment when submitted evidence clearly belongs to it — so an open assignment
 * stops nagging the moment the work lands, without needing a manual `/done`. Matching is by shared
 * multi-character Chinese vocabulary between the distilled evidence (new words, summary, weak signals)
 * and the assignment's description — the highest-signal, lowest-false-positive cue we have. We CLOSE
 * ONLY on an unambiguous single match: zero or multiple candidates → do nothing (a false close is
 * worse than a missed one; the daily nag + `/done` remain the fallback). Single-character runs are
 * ignored — too common (是/我/你) to distinguish assignments.
 */
const CJK_RUN = /[一-鿿]+/g;
function cjkWords(s: string): string[] {
  return (s.match(CJK_RUN) ?? []).filter((t) => t.length >= 2);
}

export function matchEvidenceToAssignment(
  distilled: Pick<Distilled, "summary" | "newVocab" | "weakSignals">,
  open: Assignment[],
): Assignment | undefined {
  const evTokens = new Set<string>([
    ...distilled.newVocab.flatMap((v) => cjkWords(v.headword)),
    ...cjkWords(distilled.summary),
    ...distilled.weakSignals.flatMap(cjkWords),
  ]);
  if (evTokens.size === 0) return undefined;
  const tokens = [...evTokens];
  const matches = open.filter((a) => tokens.some((t) => a.description.includes(t)));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Fetch open assignments and close the one this evidence unambiguously matches. Fail-open: any Notion
 * hiccup (or no confident match) returns undefined and never blocks evidence logging. Notion stays the
 * source of truth via markAssignmentDone. Returns the closed assignment so the adapter can acknowledge it.
 */
export async function autoCloseAssignmentFromEvidence(distilled: Distilled): Promise<Assignment | undefined> {
  const open = await getOpenAssignments().catch(() => [] as Assignment[]);
  const target = matchEvidenceToAssignment(distilled, open);
  if (!target) return undefined;
  try {
    await markAssignmentDone(target.id);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Log a pasted homework note / quick lesson note straight from Telegram — one step, near-zero
 * friction. Reuses the EXACT same primitives as the ingest route (contentHash → lessonExists dedup
 * → distillLesson → addLesson, enqueuing cards for new vocab) so Notion stays the single source of
 * truth and there's no forked write path.
 */
export async function handleLesson(
  text: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const markdown = text.trim();
  if (!markdown) {
    await reply(`Paste the note with the command, e.g. /lesson wrote 写字 20×, 4th tone still shaky.`);
    return;
  }
  const hash = contentHash(markdown);
  if (await lessonExists(hash)) {
    await reply(`Already logged that one. 👍`);
    return;
  }
  const note = await distillLesson(markdown);
  const date = new Date().toISOString().slice(0, 10);
  await addLesson({
    date,
    hash,
    summary: note.summary,
    weakSignals: note.errors.map((e) => `${e.kind}: ${e.quote} → ${e.correction}`).join("; "),
    homework: note.homeworkAssigned,
    vocabCount: note.vocabIntroduced.length,
    noteJson: JSON.stringify(note),
    transcript: markdown,
  });
  const queued = await enqueueCards(note.vocabIntroduced, `lesson ${date}`);
  const vocabNote = queued ? `\n${cardsQueuedMessage(queued, await getAgentStatus())}` : "";
  await reply(`📚 Logged (${date}): ${note.summary}${vocabNote}`);
}

type LsnNote = { vocabIntroduced?: Array<{ headword: string; example: string }> };

export async function handleListen(chatId: string): Promise<void> {
  const lessons = await getRecentLessons(5);
  for (const l of lessons) {
    let note: LsnNote;
    try { note = JSON.parse(l.noteJson) as LsnNote; } catch { continue; }
    const v = (note.vocabIntroduced ?? []).find((x) => x.headword && x.example && x.example.includes(x.headword));
    if (!v) continue;
    const cloze = v.example.split(v.headword).join("＿＿");
    await writeListeningPending({ expected: v.headword, sentence: cloze, ts: new Date().toISOString() });
    await sendMessage(chatId, `🎧 Listening check — from your lesson, what word fills the blank?\n\n${cloze}\n\n(reply with the word)`);
    return;
  }
  await sendMessage(chatId, `Send me a lesson transcript first — I build listening checks from your lessons.`);
}

const normLsn = (s: string) => s.replace(/\s+/g, "").trim();

export async function consumePendingListening(text: string, chatId: string): Promise<boolean> {
  // Slash commands are never a cloze answer. This matters because the webhook checks for a pending
  // answer BEFORE routing (see app/api/telegram/route.ts) — without this guard an open check would
  // swallow /status. It also skips a Notion read on every command.
  if (text.trim().startsWith("/")) return false;
  const pending = await readListeningPending();
  if (!pending) return false;
  const ageMs = Date.now() - new Date(pending.ts).getTime();
  if (!(ageMs >= 0 && ageMs < 2 * 60 * 60 * 1000)) return false;
  const ok = normLsn(text).includes(normLsn(pending.expected));
  await recordListeningResult(ok, pending.expected, new Date().toISOString().slice(0, 10));
  const stats = await getListeningStats();
  await sendMessage(chatId, ok
    ? `✅ 对! (duì) It was ${pending.expected}. Listening ${stats.correct}/${stats.total} recent. 真棒 (zhēn bàng)!`
    : `❌ It was ${pending.expected}. Listening ${stats.correct}/${stats.total} recent — keep at it. 加油 (jiāyóu)!`);
  return true;
}

/**
 * A conversational message — question, advice ask, plan/schedule ask, small talk — answered against the
 * current brain. This replaces the `?`-suffix heuristic the webhook used to decide answer-vs-file:
 * natural questions ("what's the plan today") rarely carry a question mark, and every one that missed
 * was silently filed as evidence and answered with "Logged.". The classifier owns that call now.
 */
export async function handleAnswer(
  text: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const brain = await buildQuestionBrain(text);
  await reply(await answerQuestion(text, brain));
}

/**
 * File a text check-in as evidence, exactly as the Telegram evidence path does: distil → write to the
 * Evidence DB (that is what feeds the scorecard, the daily brief and the weekly review) → auto-close a
 * matching assignment → queue any new vocab for Anki. A typed check-in ("tutor taught me 跳舞 today")
 * used to become a Pleco .txt and nothing else, so the word never entered the SRS deck retention is
 * measured on. The .txt is gone from this automatic path — the learner asked for words to go straight
 * to Anki, not to arrive as a file to import; `/pleco` still produces one on request. Fail-open on the
 * enqueue — the evidence row must survive a queue error — and the caller is told how many were queued
 * so it can say so honestly instead of assuming.
 */
export async function fileTextEvidence(
  text: string,
  chatId: string,
  source = "telegram",
): Promise<{ distilled: Distilled; closed?: Assignment; cardLine?: string }> {
  const distilled = await distillEvidence({ text });
  await addEvidence({
    type: distilled.type,
    rawText: text,
    source,
    distilled: JSON.stringify(distilled),
  });
  const closed = await autoCloseAssignmentFromEvidence(distilled);
  let cardLine: string | undefined;
  if (distilled.newVocab.length) {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const queued = await enqueueCards(distilled.newVocab, `check-in ${day}`);
      cardLine = queued > 0 ? cardsQueuedMessage(queued, await getAgentStatus()) : NOTHING_NEW_LINE;
    } catch (err) {
      console.error("evidence filed but cards could not be queued", err);
      cardLine = `⚠️ Couldn't queue the new words for Anki — I'll need a retry.`;
    }
  }
  return { distilled, closed, cardLine };
}

/**
 * The WHOLE handling of a plain-text message the command router declined (intent "log"): file it,
 * queue its vocab, close what it satisfies, and return the one line to reply with.
 *
 * It lives here, next to routeCommand, because "routeCommand returned false" used to mean "the
 * caller files it" — and only the Telegram webhook ever did. The dashboard chat called the same
 * router and then fell through to a Q&A answer, so every check-in typed there was silently lost.
 * Any surface that routes text must call routeCommand and then THIS; there is no third copy to keep
 * in sync, and no way for a new surface to get the router without the filing.
 */
export async function logTextMessage(text: string, chatId: string, source = "telegram"): Promise<string> {
  const { distilled, closed, cardLine } = await fileTextEvidence(text, chatId, source);
  return acknowledgeEvidence(distilled, closed, cardLine);
}

/**
 * The Pleco export, now EXPLICIT-ONLY (`/pleco [what]`).
 *
 * Automatic paths no longer send a .txt — a file to import is a chore, and the learner asked for
 * words to land in Anki by themselves. But nothing is destroyed: lib/deck.ts and lib/pleco.ts are
 * untouched and this command still produces the same import file on demand, for reading on the phone.
 */
export async function handlePlecoExport(
  request: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const [syllabus, lessons, known] = await Promise.all([
    readSyllabus().catch(() => []),
    getRecentLessons(5).catch(() => []),
    getKnownWords().catch(() => [] as string[]),
  ]);
  const res = await buildCardsForRequest(request, {
    syllabus: syllabus.map((s) => `${s.chapter}: ${s.vocab}`).join("\n"),
    lessons: lessons.map((l) => `${l.date}: ${l.summary}`).join("\n"),
    known,
  });
  const sent = res.cards.length
    ? await makeDeckFromVocab(res.label, res.cards, chatId, "pleco-request")
    : { sent: false, count: 0 };
  if (!sent.sent) {
    await reply(`Nothing new to export for that — you've already got those. 加油 (jiāyóu)!`);
    return;
  }
  await reply(`📄 ${sent.count} word${sent.count === 1 ? "" : "s"} as a Pleco file — tap to import.`);
}

/**
 * The hybrid: a message that BOTH reports work and asks about it ("did 30 min of tone drills, is that
 * enough?"). It used to classify as "answer", and answering is a terminal branch — routeCommand
 * returned true, which short-circuits the webhook's evidence path — so the reported work was answered
 * and then dropped: no evidence row, no scorecard input, no assignment auto-close, no cards.
 *
 * The filing lives HERE rather than in the webhook (i.e. rather than answering and returning false)
 * for two reasons. First, the web-chat adapter also calls routeCommand and has NO evidence path at
 * all (lib/webchat.ts falls back to answerQuestion), so a route-side fix would still lose the message
 * on that surface. Second, one submission must produce ONE reply; returning false would have the
 * webhook send its own "📝 Got it" ack on top of the answer.
 *
 * Answering happens first and filing is fail-open: if Notion is down the learner still gets their
 * answer, with no false claim that the work was recorded.
 */
export async function handleAnswerAndLog(
  text: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<void> {
  const brain = await buildQuestionBrain(text);
  const answer = await answerQuestion(text, brain);
  const lines = [answer];
  try {
    const { distilled, closed, cardLine } = await fileTextEvidence(text, chatId);
    lines.push(`📝 Filed: ${distilled.summary.trim() || distilled.type}`);
    if (closed) lines.push(`✅ Marked done: ${closed.description}`);
    if (cardLine) lines.push(cardLine);
  } catch (err) {
    console.error("answer_log: answered but could not file evidence", err);
  }
  await reply(lines.join("\n\n"));
}

export async function routeCommand(
  text: string,
  chatId: string,
  reply: Responder = telegramResponder(chatId),
): Promise<boolean> {
  const t = text.trim();
  if (t.startsWith("/")) {
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    if (/^cards?$/i.test(cmd)) { await handleMakeCards(arg || "recent vocab", chatId, reply); return true; }
    if (/^feedback$/i.test(cmd)) { await handleFeedback(chatId, reply); return true; }
    if (/^status$/i.test(cmd)) { await handleStatus(chatId, reply); return true; }
    if (/^done$/i.test(cmd)) { await handleDone(arg, chatId); return true; }
    // Explicit only — never inferred from free text. "is my agent working" must not silently
    // re-queue anything, so the retry path is reachable only by typing it.
    if (/^agent$/i.test(cmd)) { await handleAgent(arg, chatId, reply); return true; }
    if (/^listen$/i.test(cmd)) { await handleListen(chatId); return true; }
    if (/^(lesson|note)$/i.test(cmd)) { await handleLesson(arg, chatId, reply); return true; }
    // Explicit-only Pleco export. Automatic paths send cards to Anki and never a file.
    if (/^pleco$/i.test(cmd)) { await handlePlecoExport(arg || "recent vocab", chatId, reply); return true; }
    return false;
  }
  const { intent, request } = await classifyCommand(t);
  if (intent === "make_cards") { await handleMakeCards(request || t, chatId, reply); return true; }
  if (intent === "feedback") { await handleFeedback(chatId, reply); return true; }
  if (intent === "status") { await handleStatus(chatId, reply); return true; }
  if (intent === "listen") { await handleListen(chatId); return true; }
  if (intent === "answer") { await handleAnswer(t, chatId, reply); return true; }
  if (intent === "answer_log") { await handleAnswerAndLog(t, chatId, reply); return true; }
  return false; // "log" → the caller's evidence path distills and files it
}
