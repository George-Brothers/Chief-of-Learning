export type VocabCard = {
  headword: string;
  pinyin: string;
  definition: string;
  traditional?: string;
};

const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();

/**
 * Format vocab as a Pleco flashcard import file.
 * Format: a `//Category` header line, then one card per line as
 * `headword<TAB>pinyin<TAB>definition`. Traditional (when different) is encoded
 * as `simp[trad]`. Tabs/newlines inside fields are collapsed so rows never break.
 */
export function formatPlecoDeck(category: string, cards: VocabCard[]): string {
  if (!cards.length) throw new Error("Cannot format a deck with no cards");
  const lines = [`//${clean(category)}`];
  for (const c of cards) {
    const head =
      c.traditional && c.traditional !== c.headword
        ? `${clean(c.headword)}[${clean(c.traditional)}]`
        : clean(c.headword);
    lines.push([head, clean(c.pinyin), clean(c.definition)].join("\t"));
  }
  return lines.join("\n") + "\n";
}
