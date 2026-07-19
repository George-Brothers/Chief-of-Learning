export type AnkiCard = { headword: string; pinyin: string; definition: string; example: string };

export async function ankiInvoke(url: string, action: string, params: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
  });
  if (!r.ok) throw new Error(`anki ${action} failed: ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { result: unknown; error: string | null };
  if (data.error) throw new Error(`anki ${action} error: ${data.error}`);
  return data.result;
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

export async function addCards(
  url: string, deck: string, cards: AnkiCard[],
): Promise<{ added: number; skipped: number }> {
  let added = 0, skipped = 0;
  for (const c of cards) {
    const found = (await ankiInvoke(url, "findNotes", {
      query: `deck:"${deck}" Front:"${c.headword}"`,
    })) as number[];
    if (found.length > 0) { skipped++; continue; }
    await ankiInvoke(url, "addNote", {
      note: {
        deckName: deck,
        modelName: "Basic",
        fields: { Front: c.headword, Back: `${c.pinyin} — ${c.definition}\n\n${c.example}` },
        options: { allowDuplicate: false },
        tags: ["lucy", "lesson"],
      },
    });
    added++;
  }
  return { added, skipped };
}
