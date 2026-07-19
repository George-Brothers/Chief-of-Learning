// HSK 3.0 (GF0025-2021) reference data for the coverage engine.
//
// HSK_WORDS / HSK_CHARS are GENERATED (scripts/build-hsk-data.ts → ./generated) from the official
// per-band word lists. Each word/char is tagged with its LOWEST band, so banding is exclusive and
// the cumulative "reach HSK 3" set is the union of bands 1-3. Per-band word counts ≈ 500 / 771 / 973
// (the official per-band sizes; "HSK 3 = 973 words" is the band-3 tier). Totals are DATA-DERIVED
// below and pinned by test/hsk.test.ts, so a bad re-ingest fails loudly.
//
// HSK_GRAMMAR is hand-curated (the elementary grammar spine) — the checklist anchor the weekly
// review fills in, rather than inventing/forgetting points run to run.

import { HSK_WORDS, HSK_CHARS } from "./generated";

export type HskBand = 1 | 2 | 3;
export interface HskWord {
  w: string; // simplified headword
  py: string; // pinyin with tone marks ("" if unknown)
  band: HskBand;
}
export interface HskChar {
  c: string; // single simplified character
  band: HskBand;
}
export interface HskGrammar {
  id: string; // stable slug (checklist key)
  band: HskBand;
  point: string; // human-readable grammar point
}

export { HSK_WORDS, HSK_CHARS };

export const HSK_BANDS: HskBand[] = [1, 2, 3];

/** The vocabulary target: unique words across bands 1-3 (data-derived, not hardcoded). */
export const HSK_TARGET_WORDS = HSK_WORDS.length;

/** Deadline for reaching HSK 3.0 (study-abroad in China). */
export const HSK_DEADLINE = "2027-03-01";

// Elementary grammar spine (HSK 1-3). Curated, ordered by band. States are filled by the weekly
// review as not-introduced / learning / mastered. Not exhaustive — the high-frequency points a
// learner must own to be "at HSK 3".
export const HSK_GRAMMAR: HskGrammar[] = [
  // Band 1
  { id: "shi-a-b", band: 1, point: "是: A 是 B (identity/equation)" },
  { id: "ma-question", band: 1, point: "吗 yes/no questions" },
  { id: "wh-question", band: 1, point: "Question words 什么 / 谁 / 哪 / 几 / 多少" },
  { id: "de-possession", band: 1, point: "的 for possession & modification" },
  { id: "measure-words", band: 1, point: "Measure words (个 / 本 / 张 …) with number + MW + noun" },
  { id: "you-meiyou", band: 1, point: "有 / 没有 (have / not have)" },
  { id: "bu-negation", band: 1, point: "不 negation (non-past)" },
  { id: "adj-predicate-hen", band: 1, point: "很 + adjective as predicate (no 是)" },
  { id: "time-place-verb", band: 1, point: "Word order: time / place before the verb" },
  { id: "le-change", band: 1, point: "了 for completed action / change of state" },
  { id: "a-not-a", band: 1, point: "A-not-A questions (去不去)" },
  { id: "want-modals", band: 1, point: "想 / 要 / 会 / 能 (want / will / can)" },
  { id: "verb-object", band: 1, point: "Verb-object compounds (看书 / 跳舞 / 上课)" },
  // Band 2
  { id: "zai-progressive", band: 2, point: "在 / 正在 …(呢) progressive aspect" },
  { id: "guo-experience", band: 2, point: "过 experiential aspect" },
  { id: "yao-le-soon", band: 2, point: "(快)要…了 imminent action" },
  { id: "de-degree", band: 2, point: "得 degree/manner complement (说得很好)" },
  { id: "bi-comparison", band: 2, point: "比 comparisons (A 比 B …)" },
  { id: "gen-yiyang", band: 2, point: "跟…一样 (same as)" },
  { id: "yinwei-suoyi", band: 2, point: "因为…所以… (because…so…)" },
  { id: "suiran-danshi", band: 2, point: "虽然…但是/可是… (although…)" },
  { id: "yibian-yibian", band: 2, point: "一边…一边… (simultaneous actions)" },
  { id: "cong-dao", band: 2, point: "从…到… (from…to…)" },
  { id: "resultative", band: 2, point: "Resultative complements (听懂 / 做完 / 看见)" },
  { id: "directional", band: 2, point: "Directional complements (进来 / 出去 / 回来)" },
  { id: "hui-neng-keyi", band: 2, point: "会 / 能 / 可以 distinctions" },
  { id: "shi-de", band: 2, point: "是…的 (highlighting time/place/manner of a past event)" },
  { id: "yidianr-youdianr", band: 2, point: "(一)点儿 vs 有(一)点儿" },
  // Band 3
  { id: "ba-sentence", band: 3, point: "把 sentences (disposal of an object)" },
  { id: "bei-passive", band: 3, point: "被 passive" },
  { id: "potential-complement", band: 3, point: "Potential complements (听得懂 / 做不完)" },
  { id: "yue-yue", band: 3, point: "越来越… / 越…越… (more and more)" },
  { id: "chple-yiwai", band: 3, point: "除了…以外 (besides / except)" },
  { id: "yizhi-zong", band: 3, point: "一直 / 总是 (continuously / always)" },
  { id: "buguan-dou", band: 3, point: "不管…都… / 无论…都… (regardless)" },
  { id: "ruguo-jiu", band: 3, point: "如果…就… (if…then…)" },
  { id: "yaoshi-jiu", band: 3, point: "要是…就… (if…then…, colloquial)" },
  { id: "complement-duration", band: 3, point: "Time-duration complements (学了三年)" },
  { id: "complement-frequency", band: 3, point: "Action-frequency complements (去过两次)" },
  { id: "reduplication", band: 3, point: "Verb reduplication (看看 / 试试) for softening" },
];
