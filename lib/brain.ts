import { readStudyMap, readLedger } from "./notion";
import { retrieveContext } from "./retrieval";

/**
 * Assemble the brain context for a live question, shared by the Telegram and web-chat adapters (never
 * fork the brain). Base context is today's Study Map + Knowledge Ledger. M3 layers retrieval on top,
 * ADDITIVELY: when the Neon index has relevant chunks they're prepended as a scoped section; when it
 * can't help (unconfigured, empty, or unreachable) `retrieveContext` returns "" and this degrades to
 * exactly the previous behavior. Both the base reads and retrieval are fail-open — a question always
 * gets answered.
 */

const BASE_BRAIN_CHARS = 6000;

export async function buildQuestionBrain(question: string): Promise<string> {
  const [map, ledger, retrieved] = await Promise.all([
    readStudyMap().catch(() => ""),
    readLedger().catch(() => ""),
    retrieveContext(question).catch(() => ""),
  ]);
  const base = `${map}\n\n${ledger}`.slice(0, BASE_BRAIN_CHARS);
  if (!retrieved) return base;
  return `=== MOST RELEVANT TO THIS QUESTION (retrieved from the index) ===\n${retrieved}\n\n${base}`;
}
