import { z } from "zod";
import { enqueueAction, appendLedgerNotes, addAssignment, getCardedWords } from "./notion";
import { sendMessage } from "./telegram";
import { dedupeVocab } from "./vocab";

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_anki_cards"),
    cards: z.array(z.object({
      headword: z.string(), pinyin: z.string(), definition: z.string(),
      // Optional because the vision/daily distillers don't always produce one; the card back drops
      // an empty example rather than printing the literal string "undefined" (agent/anki.ts).
      example: z.string().optional(),
    })),
  }),
  z.object({ type: z.literal("assign_reading"), topic: z.string(), level: z.string() }),
  z.object({ type: z.literal("queue_drill"), drill: z.string() }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** Vocab as every distiller emits it. `example` is optional everywhere upstream. */
export type CardVocab = {
  headword: string;
  pinyin: string;
  definition: string;
  example?: string;
  traditional?: string;
};

/** The shape the local agent's `addCards` consumes — `example` always a string, never undefined. */
export type AnkiCardPayload = { headword: string; pinyin: string; definition: string; example: string };

const toAnkiCard = (v: CardVocab): AnkiCardPayload => ({
  headword: v.headword,
  pinyin: v.pinyin,
  definition: v.definition,
  example: (v.example ?? "").trim(),
});

/**
 * THE single producer of `create_anki_cards` tasks.
 *
 * Every path that discovers vocab calls this: the transcript ingest, `/lesson`, `/cards`, the
 * lesson-feedback dispatcher, the Telegram photo/evidence path (tutor slides and homework photos —
 * the learner's main source, which used to produce a Pleco .txt and nothing else) and the daily
 * brief. One implementation means one place where the de-dupe, the `example` fallback, `notify` and
 * the label are decided, instead of six subtly different ones.
 *
 * Filtering is against getCardedWords(), NOT getKnownWords(): a word that merely went out as a Pleco
 * file must still be allowed to become a card (see lib/notion.ts).
 *
 * Returns how many cards were queued — 0 when everything was already known, so callers can phrase
 * their reply honestly without repeating the filter.
 */
export async function enqueueCards(
  vocab: CardVocab[],
  label: string,
  opts: { known?: string[]; notify?: boolean } = {},
): Promise<number> {
  if (!vocab.length) return 0;
  // Fail OPEN: if Notion can't tell us what's known, queue the cards anyway. A duplicate card is a
  // two-second annoyance in Anki (and findNotes catches most of them there); a dropped word is gone.
  const known = opts.known ?? (await getCardedWords().catch(() => [] as string[]));
  const fresh = dedupeVocab(vocab, known).map(toAnkiCard);
  if (!fresh.length) return 0;
  await enqueueAction({
    type: "create_anki_cards",
    payload: JSON.stringify({ cards: fresh, notify: opts.notify ?? true, label }),
  });
  return fresh.length;
}

export async function dispatchActions(actions: Action[], chatId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  for (const a of actions) {
    if (a.type === "create_anki_cards") {
      // Was enqueued raw and WITHOUT `notify`, so a failure never reached the learner. It shares the
      // one producer now, which means it also gets the de-dupe and the ⚠️/✅ report-back.
      await enqueueCards(a.cards, `lesson feedback ${today}`);
    } else if (a.type === "assign_reading") {
      await sendMessage(chatId, `📖 Read today (${a.level}): ${a.topic}. Screenshot when you finish.`);
      // Record durably so the next daily brief can check whether it got done.
      await appendLedgerNotes(`Reading assigned (${a.level}): ${a.topic}`);
      await addAssignment({ kind: "reading", description: `${a.topic} (${a.level})`, date: today });
    } else if (a.type === "queue_drill") {
      await appendLedgerNotes(`Drill queued: ${a.drill}`);
      await addAssignment({ kind: "drill", description: a.drill, date: today });
    }
  }
}
