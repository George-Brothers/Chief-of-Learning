import { isPermanent } from "./failure";

export type AnkiCard = { headword: string; pinyin: string; definition: string; example: string };

export async function ankiInvoke(url: string, action: string, params: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
  });
  if (!r.ok) throw new Error(`anki ${action} failed: ${r.status} ${await r.text()}`);
  // Parse the body OURSELVES rather than via r.json(), so a non-JSON answer surfaces as a named
  // transport failure instead of a bare SyntaxError. A `200` carrying HTML means something that is
  // not AnkiConnect is listening on the port; that is a reachability problem which the executor
  // retries and eventually dead-letters — it is NOT a rejected note, and must never quarantine cards.
  const body = await r.text();
  let data: { result: unknown; error: string | null };
  try {
    data = JSON.parse(body) as { result: unknown; error: string | null };
  } catch {
    const ct = r.headers.get("content-type") ?? "no content-type";
    throw new Error(
      `anki ${action}: response was not JSON (${ct}) — is something other than AnkiConnect on ${url}? ` +
        `body starts: ${body.slice(0, 120)}`,
    );
  }
  if (data.error) throw new Error(`anki ${action} error: ${data.error}`);
  return data.result;
}

/**
 * Is AnkiConnect actually answering? Reported up with every heartbeat so the cloud can say "Anki
 * isn't open" instead of the much vaguer "your cards are queued". Never throws: an unreachable Anki
 * is a normal laptop state, and a probe that threw would take the heartbeat down with it.
 */
export async function isAnkiReachable(url: string): Promise<boolean> {
  try {
    await ankiInvoke(url, "version", {});
    return true;
  } catch {
    return false;
  }
}

const HAS_CJK = /[一-鿿]/;

export async function getMatureFronts(url: string, minIvl = 21): Promise<string[]> {
  const ids = (await ankiInvoke(url, "findCards", { query: `prop:ivl>=${minIvl}` })) as number[];
  if (!ids.length) return [];
  const infos = (await ankiInvoke(url, "cardsInfo", { cards: ids })) as Array<{ fields?: { Front?: { value?: string } } }>;
  const out = new Set<string>();
  for (const i of infos) {
    const f = i.fields?.Front?.value?.trim();
    if (f && HAS_CJK.test(f)) out.add(f);
  }
  return [...out];
}

/** Escape the characters Anki's search syntax treats as operators. */
const escapeAnki = (s: string) => s.replace(/([\\"*_:()])/g, "\\$1");

/**
 * The de-dupe query.
 *
 * It used to be scoped to the destination deck alone (`deck:"Chinese::Lessons"`). The learner's own
 * cards live in `Chinese::Lesson 1 – Greetings::Dialogue 1` and eleven siblings — a deck-scoped
 * lookup cannot see any of them, so the first run of this pipeline would have re-added 300+ words
 * they already study. Scope the whole `Chinese::*` tree instead: the top-level deck plus everything
 * under it. `deck:"X"` alone does not match subdecks reliably across Anki versions, hence the OR.
 */
export function dedupeQuery(deck: string, headword: string): string {
  const root = deck.split("::")[0];
  return `Front:"${escapeAnki(headword)}" (deck:"${escapeAnki(root)}" OR deck:"${escapeAnki(root)}::*")`;
}

/** `pinyin — definition`, with the example on its own line only when there IS one. */
export function cardBack(c: Pick<AnkiCard, "pinyin" | "definition"> & { example?: string }): string {
  const example = (c.example ?? "").trim();
  return [`${c.pinyin} — ${c.definition}`, example].filter(Boolean).join("\n\n");
}

/**
 * The standing tags plus the batch's own label. Structure lives in TAGS, not deck names: the
 * pipeline has no reliable lesson/dialogue signal, and a misfiled deck is worse than an unsorted one.
 * Anki tags cannot contain spaces, so the label is hyphenated.
 */
export function ankiTags(label?: string): string[] {
  const tag = (label ?? "").trim().replace(/\s+/g, "-");
  const out = ["lucy", "lesson"];
  if (tag && !out.includes(tag)) out.push(tag);
  return out;
}

export type AddResult = {
  added: number;
  skipped: number;
  /** Notes Anki refused outright. Quarantined, never silently dropped — the caller parks these. */
  failed: Array<{ card: AnkiCard; error: string }>;
};

/**
 * Add a batch, ISOLATING each note.
 *
 * This loop used to abort on the first refusal, so one malformed entry in a 30-card lesson lost all
 * 30. Now a note Anki will never accept is quarantined and the rest still land. Anything we cannot
 * prove is a per-note problem (a transport failure, a closed collection) still aborts the batch —
 * that failure applies to every card, and the executor's retry is the right answer to it.
 */
export async function addCards(
  url: string, deck: string, cards: AnkiCard[], label?: string,
): Promise<AddResult> {
  let added = 0, skipped = 0;
  const failed: AddResult["failed"] = [];
  const tags = ankiTags(label);
  for (const c of cards) {
    try {
      if (!c?.headword?.trim()) throw new Error("cannot create note because it is empty (no headword)");
      const found = (await ankiInvoke(url, "findNotes", { query: dedupeQuery(deck, c.headword) })) as number[];
      if (found.length > 0) { skipped++; continue; }
      await ankiInvoke(url, "addNote", {
        note: {
          deckName: deck,
          modelName: "Basic",
          fields: { Front: c.headword, Back: cardBack(c) },
          options: { allowDuplicate: false },
          tags,
        },
      });
      added++;
    } catch (e) {
      if (!isPermanent(e)) throw e; // batch-wide problem — let the executor retry the whole task
      failed.push({ card: c, error: (e as Error).message });
    }
  }
  return { added, skipped, failed };
}
