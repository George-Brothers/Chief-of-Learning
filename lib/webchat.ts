// The web dashboard's "Talk to Lucy" panel runs on the SAME brain as Telegram — this file is a thin
// adapter, not a second brain. It reuses:
//   - routeCommand  (lib/command): slash + natural-language command router (cards / feedback / status)
//   - answerQuestion (lib/ai):     Lucy's level-calibrated Q&A against the live Notion brain
// The only difference from the Telegram path is the reply sink: instead of pushing to Telegram, we
// collect Lucy's lines and return them so the HTTP response carries the reply. Notion reads/writes
// happen exactly as they do for Telegram (commands still enqueue actions, append ledger notes, etc.).

import { getEnv } from "./env";
import { routeCommand, type Responder } from "./command";
import { answerQuestion } from "./ai";
import { buildQuestionBrain } from "./brain";

/** Hard cap on inbound message size — untrusted single-user input, treated as data by the model. */
const MAX_MESSAGE_CHARS = 4000;

export type ChatReply = { reply: string; handledAs: "command" | "answer" };

/**
 * Run one web-chat turn through Lucy's real pipeline.
 * 1. Try the command router (same as Telegram). If it handles the message, return its collected reply.
 * 2. Otherwise treat it as a message to Lucy and answer it against the current brain — the same
 *    question path the Telegram handler uses. A chat panel is conversational, so non-commands go to
 *    Lucy's voice rather than being filed as silent evidence.
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

  const brain = await buildQuestionBrain(message);
  const answer = await answerQuestion(message, brain);
  return { reply: answer, handledAs: "answer" };
}
