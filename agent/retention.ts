import { getMatureFronts } from "./anki";

export async function syncRetention(cfg: { cloudUrl: string; secret: string; ankiUrl: string }): Promise<number> {
  const words = await getMatureFronts(cfg.ankiUrl);
  const r = await fetch(`${cfg.cloudUrl}/api/agent/retention`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
    body: JSON.stringify({ words }),
  });
  if (!r.ok) throw new Error(`syncRetention failed: ${r.status} ${await r.text()}`);
  return words.length;
}
