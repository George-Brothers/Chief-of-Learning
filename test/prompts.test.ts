import { describe, it, expect } from "vitest";
import { COACH_SYSTEM, DAILY_PROMPT, DISTILL_PROMPT, WEEKLY_PROMPT } from "../lib/prompts";
import { weeklyBudgetSummary } from "../lib/rhythm";

/**
 * The prompt is the only place the flashcard-chore fix can be enforced for the live learner: the
 * Study Map / Ledger / Gradebook that feed the daily brief live in Notion and still carry the old
 * "graduate the backlog into Pleco" text. These assertions guard both halves of that fix.
 */
describe("COACH_SYSTEM flashcard automation", () => {
  it("states that card creation is automated", () => {
    expect(COACH_SYSTEM).toMatch(/Card creation is automated/i);
    expect(COACH_SYSTEM).toMatch(/never types a card or builds a deck/i);
  });

  /**
   * The automatic paths no longer produce a Pleco file at all — the photo/evidence path, the daily
   * brief and fileTextEvidence all enqueue for Anki and send a confirmation line instead. The prompt
   * documented an "ANKI/PLECO split" that the code no longer implements; a prompt describing a
   * behaviour the code doesn't have is the exact fabrication class already caught on this branch.
   */
  it("describes Anki as the only automatic destination and Pleco as request-only", () => {
    expect(COACH_SYSTEM).toMatch(/ANKI is the ONLY automatic destination/);
    expect(COACH_SYSTEM).toMatch(/NO automatic Pleco file/);
    expect(COACH_SYSTEM).toMatch(/only if they\s+ASK for it \(\/pleco\)/);
    // The stale split, and the old claim that photo vocab comes back as a file.
    expect(COACH_SYSTEM).not.toMatch(/PLECO route/);
    expect(COACH_SYSTEM).not.toMatch(/ANKI route/);
    expect(COACH_SYSTEM).not.toMatch(/comes straight back in the chat as a Pleco import file/);
    expect(COACH_SYSTEM).not.toMatch(/does NOT reach Anki/);
    expect(COACH_SYSTEM).toMatch(/EVERY source of new vocab/);
    expect(COACH_SYSTEM).toMatch(/SEND AS A PHOTO/);
    // Still honest about delivery: queued is not the same as in the deck.
    expect(COACH_SYSTEM).toMatch(/NEVER say a word "is in your deck"/);
    expect(COACH_SYSTEM).toMatch(/not at all while\s+the agent is down/);
  });

  it("prohibits assigning card-making or deck-building", () => {
    expect(COACH_SYSTEM).toMatch(/NEVER assign card-making, deck-building/);
    expect(COACH_SYSTEM).toMatch(/add words to Pleco\/Anki/);
  });

  it("allows only doing the waiting reviews as vocab work", () => {
    expect(COACH_SYSTEM).toMatch(/ONLY vocab work you may assign is DOING the reviews already waiting/);
  });

  it("overrides stale backlog chore text found in the Notion brain", () => {
    expect(COACH_SYSTEM).toMatch(/STALE/);
    expect(COACH_SYSTEM).toMatch(/Study Map, Knowledge Ledger and Gradebook/);
  });

  it("carries no graduate-into-Pleco chore text of its own", () => {
    expect(COACH_SYSTEM).not.toMatch(/graduate into Pleco/i);
    // The override section necessarily QUOTES the old chore lines, so drop just that section: what
    // must not survive is the chore stated anywhere as a live instruction.
    const start = COACH_SYSTEM.indexOf("STALE BRAIN TEXT");
    const end = COACH_SYSTEM.indexOf("THE CALIBRATION RULE");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const rest = COACH_SYSTEM.slice(0, start) + COACH_SYSTEM.slice(end);
    expect(rest).not.toMatch(/backlog.*Pleco/i);
    expect(rest).not.toMatch(/Pleco.*backlog/i);
  });
});

describe("newVocab example sentences", () => {
  it("asks both distillers for the example the card back is built from", () => {
    // VocabSchema had no `example` field, so wiring the photo/daily paths into Anki naively would
    // have produced card backs reading "pinyin — definition\n\nundefined".
    for (const p of [DISTILL_PROMPT, DAILY_PROMPT]) {
      expect(p).toMatch(/example/);
      // …and must not be pushed into inventing one, which is worse than a bare card.
      expect(p).toMatch(/(Omit example|leave example out)/);
    }
  });
});

describe("DAILY_PROMPT newVocab", () => {
  it("does not imply the learner makes cards from it", () => {
    expect(DAILY_PROMPT).not.toMatch(/worth a Pleco card/i);
    expect(DAILY_PROMPT).toMatch(/turns these into cards automatically/i);
  });
});

describe("DAILY_PROMPT listening + sizing", () => {
  it("sizes the day from the supplied budget, not a hardcoded 1.5 hours", () => {
    expect(DAILY_PROMPT).toMatch(/TODAY'S TIME BUDGET/);
    expect(DAILY_PROMPT).not.toMatch(/sized to ~1\.5 hours/);
  });

  it("grades the week against the same per-day budget model, not a 1.5h/day constant", () => {
    expect(WEEKLY_PROMPT).not.toMatch(/1\.5h\/day/);
    expect(WEEKLY_PROMPT).toContain(weeklyBudgetSummary());
    // COACH_SYSTEM carried the same stale figure in the learner profile.
    expect(COACH_SYSTEM).not.toMatch(/about 1\.5 hours a day/);
    expect(COACH_SYSTEM).toContain(weeklyBudgetSummary());
  });

  it("confines listening to the code-supplied options and asks for a reply", () => {
    expect(DAILY_PROMPT).toMatch(/TODAY'S LISTENING OPTIONS/);
    expect(DAILY_PROMPT).toMatch(/NEVER name a workbook listening section, an episode number/);
    expect(DAILY_PROMPT).toMatch(/which one he picked and ONE thing he caught/);
  });
});
