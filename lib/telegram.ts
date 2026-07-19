import { getEnv } from "./env";

const api = (method: string) =>
  `https://api.telegram.org/bot${getEnv().TELEGRAM_BOT_TOKEN}/${method}`;

/** Send a plain-text message. */
export async function sendMessage(chatId: string, text: string): Promise<void> {
  const r = await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!r.ok) throw new Error(`sendMessage failed: ${r.status} ${await r.text()}`);
}

/** Send a text file as a document the learner can tap to open in Pleco. */
export async function sendDocument(
  chatId: string,
  filename: string,
  content: string,
  caption?: string
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/plain" }), filename);
  const r = await fetch(api("sendDocument"), { method: "POST", body: form });
  if (!r.ok) throw new Error(`sendDocument failed: ${r.status} ${await r.text()}`);
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
};

/**
 * Download a Telegram file's raw bytes server-side.
 *
 * The temporary download URL embeds the bot token, so it must NOT escape this module — handing it to
 * a model would leak the token to a third-party provider (audit P2-2). We fetch the bytes here and
 * return them; callers pass bytes to the model, never the URL.
 */
export async function getFileBytes(fileId: string): Promise<{ data: Uint8Array; mediaType: string }> {
  const r = await fetch(api("getFile"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const j = (await r.json()) as { ok: boolean; result?: { file_path: string } };
  if (!j.ok || !j.result) throw new Error("getFile failed");
  const filePath = j.result.file_path;
  const url = `https://api.telegram.org/file/bot${getEnv().TELEGRAM_BOT_TOKEN}/${filePath}`;
  const fr = await fetch(url);
  if (!fr.ok) throw new Error(`file download failed: ${fr.status}`);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mediaType = fr.headers.get("content-type")?.split(";")[0] || MIME_BY_EXT[ext] || "image/jpeg";
  return { data: new Uint8Array(await fr.arrayBuffer()), mediaType };
}
