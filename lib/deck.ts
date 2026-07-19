import { formatPlecoDeck, type VocabCard } from "./pleco";
import { dedupeVocab } from "./vocab";
import { getKnownWords, archiveDeck } from "./notion";
import { sendDocument } from "./telegram";

const safeName = (s: string) => s.replace(/[^\w一-鿿.-]+/g, "_").slice(0, 60);

/**
 * Build a Pleco deck from candidate vocab: drop words already known, and if any
 * remain, format + send as a Telegram document + archive in Notion. Never sends an
 * empty deck.
 */
export async function makeDeckFromVocab(
  name: string,
  vocab: VocabCard[],
  chatId: string,
  source = "tutor-note"
): Promise<{ sent: boolean; count: number }> {
  const known = await getKnownWords();
  const fresh = dedupeVocab(vocab, known);
  if (!fresh.length) return { sent: false, count: 0 };

  const deckText = formatPlecoDeck(name, fresh);
  const headwords = fresh.map((c) => c.headword).join(" ");

  await sendDocument(
    chatId,
    `${safeName(name)}.txt`,
    deckText,
    `${fresh.length} new word${fresh.length > 1 ? "s" : ""} — tap to import into Pleco.`
  );
  await archiveDeck({ name, source, headwords, count: fresh.length, deckText });

  return { sent: true, count: fresh.length };
}
