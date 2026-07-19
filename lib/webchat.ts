// The web dashboard's "Talk to Lucy" panel runs on the SAME brain as Telegram — this file is a thin
// adapter, not a second brain. It reuses:
//   - routeCommand  (lib/command): slash + natural-language command router (cards / feedback / status)
//   - answerQuestion (lib/ai):     Lucy's level-calibrated Q&A against the live Notion brain
// The only difference from the Telegram path is the reply sink: instead of pushing to Telegram, we
// collect Lucy's lines and return them so the HTTP response carries the reply. Notion reads/writes
// happen exactly as they do for Telegram (commands still enqueue actions, append ledger notes, etc.).

import { getEnv } from "./env";
import { routeCommand, logTextMessage, type Responder } from "./command";

/** Hard cap on inbound message size — untrusted single-user input, treated as data by the model. */
const MAX_MESSAGE_CHARS = 4000;

export type ChatReply = { reply: string; handledAs: "command" | "answer" | "log" };

/**
 * Run one web-chat turn through Lucy's real pipeline.
 * 1. Try the command router (same as Telegram). If it handles the message, return its collected
 *    reply. Every conversational message goes down this path too — the classifier's "answer" and
 *    "answer_log" intents are handled inside routeCommand.
 * 2. Otherwise the router declined, which means intent "log": a report of study. File it, exactly as
 *    the Telegram webhook does, via the shared logTextMessage.
 *
 * Step 2 used to be a fall-through to buildQuestionBrain/answerQuestion, i.e. Lucy replied to the
 * check-in and NOTHING was recorded: no evidence row, no scorecard input, no assignment closed, no
 * Anki cards. Study reported through the dashboard was lost outright. Answering is not this branch's
 * job — the router already owns every intent that wants an answer.
 */
export async function respondToMessage(rawMessage: string): Promise<ChatReply> {
  const env = getEnv();
  const message = rawMessage.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return { reply: "Say something and I'll help. 加油 (jiāyóu)!", handledAs: "answer" };

  // Actions (deck creation, assigned reading) still notify the owner on Telegram — same single user.
  const chatId = env.TELEGRAM_ALLOWED_CHAT_ID;

  const collected: string[] = [];
  const collect: Responder = async (text) => {
    collected.push(text);
  };

  const handled = await routeCommand(message, chatId, collect);
  if (handled) {
    const reply = collected.join("\n\n").trim();
    return { reply: reply || "Done. 加油 (jiāyóu)!", handledAs: "command" };
  }

  // Fail-open, like the Telegram path: if Notion is down the learner still gets a reply, and it never
  // claims the check-in was recorded when it wasn't.
  try {
    return { reply: await logTextMessage(message, chatId, "web"), handledAs: "log" };
  } catch (err) {
    console.error("web chat: could not file the check-in", err);
    return {
      reply: "I couldn't save that just now — my notes are offline. Send it again in a minute and it'll stick.",
      handledAs: "log",
    };
  }
}
