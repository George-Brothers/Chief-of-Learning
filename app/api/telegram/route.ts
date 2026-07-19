import { getEnv } from "@/lib/env";
import { distillEvidence, type Distilled } from "@/lib/ai";
import { NoProviderError } from "@/lib/models";
import { addEvidence } from "@/lib/notion";
import { sendMessage, getFileBytes } from "@/lib/telegram";
import { enqueueCards } from "@/lib/actions";
import { getAgentStatus, cardsQueuedMessage } from "@/lib/agent-status";
import { routeCommand, consumePendingListening, autoCloseAssignmentFromEvidence, logTextMessage } from "@/lib/command";
import { acknowledgeEvidence, NOTHING_NEW_LINE } from "@/lib/ack";

export const runtime = "nodejs";
// Raise the function timeout like the other AI routes (chat=60, daily-brief/ingest=120). EVERY
// inbound message makes >=2 sequential model calls (classify in routeCommand, then distill/answer)
// plus Notion round-trips, so on a short platform default the function is killed before sendMessage
// and the bot goes silent to EVERY message. Telegram itself waits ~60s for a webhook reply, so 60 is
// the sensible cap.
export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */
type TgMessage = {
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; mime_type?: string; file_name?: string };
};

function todayLabel(): string {
  // YYYY-MM-DD in the configured tz, without pulling Date.now formatting surprises.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getEnv().TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function POST(req: Request): Promise<Response> {
  const env = getEnv();

  const providedSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (providedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    // The single most common cause of "the bot ignores every message": setWebhook was registered
    // WITHOUT `&secret_token=` (Telegram then sends no header at all → providedSecret === null), or
    // with a value that doesn't match TELEGRAM_WEBHOOK_SECRET. Either way every update is dropped
    // here. Log it — otherwise the outage is completely invisible in the Vercel function logs and
    // undiagnosable. See AGENTS.md "Telegram webhook" for the fix.
    console.warn(
      providedSecret === null
        ? "telegram webhook rejected: request carried no x-telegram-bot-api-secret-token header — " +
            "re-run setWebhook with &secret_token=<TELEGRAM_WEBHOOK_SECRET>"
        : "telegram webhook rejected: secret_token mismatch — the setWebhook secret_token does not " +
            "equal TELEGRAM_WEBHOOK_SECRET",
    );
    return new Response("unauthorized", { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return Response.json({ ok: true });
  }

  const msg: TgMessage | undefined = update?.message;
  if (!msg) return Response.json({ ok: true });

  const chatId = String(msg.chat.id);
  if (chatId !== env.TELEGRAM_ALLOWED_CHAT_ID) {
    // Not the allowed chat — ignore silently.
    return Response.json({ ok: true });
  }

  // After auth, always return 200 so Telegram doesn't retry-storm on our errors.
  try {
    await handle(msg, chatId);
  } catch (err) {
    console.error("telegram handler error", err);
    try {
      await sendMessage(chatId, "Something broke on my end. Try that again in a sec.");
    } catch {
      /* ignore */
    }
  }
  return Response.json({ ok: true });
}

async function handle(msg: TgMessage, chatId: string): Promise<void> {
  const text = msg.text?.trim();

  // A pending listening check consumes the next text reply as its answer — BEFORE classifying.
  // Order is load-bearing: the classifier is told to prefer "answer" when unsure, so a bare cloze
  // reply like "跳舞" classifies as a question and gets *explained* instead of scored, and this line
  // becomes unreachable. Checking first can spend a check on a genuine question asked inside the 2h
  // window, but that failure is visible and self-correcting — the learner sees "❌ It was X", and
  // re-sending the question is answered normally because nothing is pending any more. The other order
  // fails silently and permanently: listening is never scored at all. Slash commands are exempt
  // (guarded inside consumePendingListening) so /status et al. still work while a check is open.
  if (text && (await consumePendingListening(text, chatId))) return;

  // Command layer: on-demand Chief of Staff work, plus every conversational message (intent "answer").
  // Falls through only for a photo or a "log" check-in the learner wants recorded as evidence — the
  // classifier makes that call, the route never guesses from punctuation.
  if (text && (await routeCommand(text, chatId))) return;

  // A text check-in the router declined (intent "log"). Filing lives in lib/command, NOT here: the
  // dashboard chat calls the same router, and while this handler was the only place that knew what
  // "returned false" meant, every check-in typed into the dashboard was answered and then dropped.
  if (text) {
    await sendMessage(chatId, await logTextMessage(text, chatId, "telegram"));
    return;
  }

  // Photo (Pleco SRS, corrected homework, tutor notes) → distill from the image.
  // A handwriting photo sent "without compression" arrives as a `document`, not inline `photo[]`;
  // fetch it too when it's an image mime and route it through the SAME evidence/vision path.
  // Bytes are downloaded server-side; the token-bearing Telegram URL never leaves lib/telegram
  // (audit P2-2), so it's neither sent to the model nor persisted to Notion.
  let image: { data: Uint8Array; mediaType: string } | undefined;
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    image = await getFileBytes(largest.file_id);
  } else if (msg.document) {
    if (!msg.document.mime_type?.startsWith("image/")) {
      // Honest degrade: a non-image file (PDF, doc, audio…) — never crash the vision path on it.
      await sendMessage(chatId, "I can't read that file type — send it as a photo or an image file and I'll take a look.");
      return;
    }
    image = await getFileBytes(msg.document.file_id);
  }

  const caption = msg.caption?.trim();

  let distilled: Distilled;
  try {
    distilled = await distillEvidence({ text: text ?? caption, image });
  } catch (err) {
    // Honest degrade for the one failure we can name: an image arrived but NO multimodal provider is
    // configured (neither Google nor OpenAI). Log that it came in and say so plainly — don't let a raw
    // NoProviderError reach the generic "Something broke" catch. Any other error (a transient provider
    // failure, etc.) still propagates to that genuine last-resort handler in POST.
    if (image && err instanceof NoProviderError) {
      await addEvidence({
        type: "image",
        rawText: text ?? caption ?? "(image — not read: no vision provider configured)",
        source: "telegram",
      });
      await sendMessage(
        chatId,
        "I couldn't read that image — image reading isn't set up right now, but I've noted you sent one.",
      );
      return;
    }
    throw err;
  }

  await addEvidence({
    type: distilled.type,
    rawText: text ?? caption ?? "(image)",
    source: "telegram",
    distilled: JSON.stringify(distilled),
  });

  // If this submission clearly satisfies an open assignment, close it so it stops nagging — no
  // manual /done needed. Conservative: only an unambiguous match closes anything (see command.ts).
  const closed = await autoCloseAssignmentFromEvidence(distilled);

  // Anki, and ONLY Anki. This path — tutor slides, homework photos, whiteboard shots — is the
  // learner's biggest source of new words, and it used to produce a Pleco .txt and nothing else: not
  // one of those words ever reached the SRS deck the whole retention model is built on. The .txt is
  // gone from here on purpose ("I don't want to get a msg with words to add, I want it to go
  // directly to Anki") — a file to import is homework, not a result. lib/deck.ts still exists and is
  // reachable on explicit request (/pleco). Fail-open: a queue error must never lose the evidence
  // row written above, and must never be reported as a success.
  let cardLine: string | undefined;
  if (distilled.newVocab.length) {
    try {
      const queued = await enqueueCards(distilled.newVocab, `tutor ${todayLabel()}`);
      cardLine = queued > 0 ? cardsQueuedMessage(queued, await getAgentStatus()) : NOTHING_NEW_LINE;
    } catch (err) {
      console.error("telegram: evidence logged but cards could not be queued", err);
      cardLine = `⚠️ I logged this, but couldn't queue the new words for Anki — I'll need a retry.`;
    }
  }

  // The ack is shared with the text path (lib/command) so both surfaces say the same thing.
  await sendMessage(chatId, acknowledgeEvidence(distilled, closed, cardLine));
}
