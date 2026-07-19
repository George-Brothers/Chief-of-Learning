import { z } from "zod";
import { runObject, runText, type Distilled } from "./ai";
import { COACH_SYSTEM, CLASSIFY_PROMPT, CARD_ASSEMBLY_PROMPT, STATUS_PROMPT } from "./prompts";

export const IntentSchema = z.object({
  intent: z.enum(["make_cards", "feedback", "status", "listen", "other"]),
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
  getKnownWords, readSyllabus, getRecentLessons, enqueueAction,
  readScorecard, readGradebook, readStudyMap, readLedger, getWeekFocus,
  getRetainedWords, getOpenAssignments, markAssignmentDone, type Assignment,
  readListeningPending, writeListeningPending, recordListeningResult, getListeningStats,
  lessonExists, addLesson,
} from "./notion";
import { runLessonFeedback, distillLesson } from "./lesson";
import { contentHash } from "../agent/hash";
import { dispatchActions } from "./actions";
import { computeCoverage, computePace, observedPerWeek, updateHist, renderComputedBlock } from "./hsk";

const norm = (s: string) => s.replace(/\s+/g, "").trim();

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
  const [syllabus, lessons, known] = await Promise.all([
    readSyllabus().catch(() => []),
    getRecentLessons(5).catch(() => []),
    getKnownWords().catch(() => [] as string[]),
  ]);
  const syllabusDigest = syllabus.map((s) => `${s.chapter}: ${s.vocab}`).join("\n");
  const lessonsDigest = lessons.map((l) => `${l.date}: ${l.summary}`).join("\n");
  const res = await buildCardsForRequest(request, { syllabus: syllabusDigest, lessons: lessonsDigest, known });
  const knownSet = new Set(known.map(norm));
  const fresh = res.cards.filter((c) => !knownSet.has(norm(c.headword)));
  if (fresh.length === 0) {
    await reply(`Looks like you already know those 🎉 — nothing to make. 加油 (jiāyóu)!`);
    return;
  }
  await enqueueAction({
    type: "create_anki_cards",
    payload: JSON.stringify({ cards: fresh, notify: true, label: res.label }),
  });
  await reply(`On it — making ${res.label} cards 💪 (source: ${res.source}). I'll ping you when they're in Anki.`);
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
  if (note.vocabIntroduced.length > 0) {
    await enqueueAction({
      type: "create_anki_cards",
      payload: JSON.stringify({ cards: note.vocabIntroduced, notify: true, label: `lesson ${date}` }),
    });
  }
  const vocabNote = note.vocabIntroduced.length
    ? ` — ${note.vocabIntroduced.length} new word(s) queued for cards.`
    : "";
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
    if (/^listen$/i.test(cmd)) { await handleListen(chatId); return true; }
    if (/^(lesson|note)$/i.test(cmd)) { await handleLesson(arg, chatId, reply); return true; }
    return false;
  }
  const { intent, request } = await classifyCommand(t);
  if (intent === "make_cards") { await handleMakeCards(request || t, chatId, reply); return true; }
  if (intent === "feedback") { await handleFeedback(chatId, reply); return true; }
  if (intent === "status") { await handleStatus(chatId, reply); return true; }
  if (intent === "listen") { await handleListen(chatId); return true; }
  return false;
}
