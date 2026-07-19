import { z } from "zod";
import { enqueueAction, appendLedgerNotes, addAssignment } from "./notion";
import { sendMessage } from "./telegram";

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_anki_cards"),
    cards: z.array(z.object({
      headword: z.string(), pinyin: z.string(), definition: z.string(), example: z.string(),
    })),
  }),
  z.object({ type: z.literal("assign_reading"), topic: z.string(), level: z.string() }),
  z.object({ type: z.literal("queue_drill"), drill: z.string() }),
]);
export type Action = z.infer<typeof ActionSchema>;

export async function dispatchActions(actions: Action[], chatId: string): Promise<void> {
  for (const a of actions) {
    if (a.type === "create_anki_cards") {
      if (a.cards.length === 0) continue;
      await enqueueAction({ type: "create_anki_cards", payload: JSON.stringify({ cards: a.cards }) });
    } else if (a.type === "assign_reading") {
      await sendMessage(chatId, `📖 Read today (${a.level}): ${a.topic}. Screenshot when you finish.`);
      // Record durably so the next daily brief can check whether it got done.
      await appendLedgerNotes(`Reading assigned (${a.level}): ${a.topic}`);
      await addAssignment({ kind: "reading", description: `${a.topic} (${a.level})`, date: new Date().toISOString().slice(0, 10) });
    } else if (a.type === "queue_drill") {
      await appendLedgerNotes(`Drill queued: ${a.drill}`);
      await addAssignment({ kind: "drill", description: a.drill, date: new Date().toISOString().slice(0, 10) });
    }
  }
}
