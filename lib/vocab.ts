import type { VocabCard } from "./pleco";

const norm = (s: string) => s.replace(/\s+/g, "").trim();

/**
 * Drop candidates whose headword is already known (whitespace-insensitive) and
 * de-dupe within the candidate list, keeping the first occurrence.
 */
export function dedupeVocab<T extends VocabCard>(candidates: T[], known: string[]): T[] {
  const seen = new Set(known.map(norm));
  const out: T[] = [];
  for (const c of candidates) {
    const key = norm(c.headword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
