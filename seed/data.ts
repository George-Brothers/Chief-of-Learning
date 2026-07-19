// Seed content for Lucy's Notion brain. This is EXAMPLE starter content for one learner around
// HSK 1, working through Integrated Chinese Vol. 1. Uploaded once by scripts/seed-knowledge.ts,
// then edited live in Notion. Replace the Ledger / Study Map / Daily Log / Gradebook below with
// your own level, words, and goals. The SYLLABUS block is public textbook vocab and can stay as-is.

export const LEDGER = `# Knowledge Ledger — what the learner knows
Level: approaching HSK 1 · Integrated Chinese Vol. 1, Lessons 3–4.
Source of truth for "known + 1–2 new". Lucy reads this to calibrate every drill and deck.

## Solid / learning (HSK 1 + IC L1–L3 core)
Pronouns/questions: 我 你 他 她 我们 这 那 哪 哪儿 谁 什么 多少 几 怎么 怎么样
Numbers/measure: 一 二 三 四 五 六 七 八 九 十 个 岁 本 些 块 半 两
Time: 现在 今天 明天 昨天 上午 中午 下午 年 月 日 号 星期 点 分钟 时候 早上 晚上
People/family: 人 爸爸 妈妈 儿子 女儿 老师 学生 同学 朋友 医生 先生 小姐 名字 哥哥 弟弟 姐姐 妹妹
Verbs: 是 有 看 看见 听 说话 读 写 叫 来 去 回 吃 喝 睡觉 打电话 做 买 开 坐 住 学习 工作 喜欢 想 认识 会 能 爱
Adjectives: 好 大 小 多 少 冷 热 高兴 漂亮 忙 很
Function: 很 太 都 也 不 没 和 在 的 了 吗 呢
Set phrases: 谢谢 不客气 再见 请 对不起 没关系 喂

## Learning queue (tutor/lesson words — graduate as they stick)
最近 zuìjìn recently · 周末 zhōumò weekend · 常常 chángcháng often · 早上 zǎoshang morning ·
晚上 wǎnshang evening · 半 bàn half (5:30) · 星期六 Saturday · 星期天 Sunday ·
听音乐 tīng yīnyuè listen to music · 看电影 kàn diànyǐng watch a movie · 跳舞 tiàowǔ dance ·
跑步 pǎobù run · 游泳 yóuyǒng swim · 打球 dǎqiú play ball · 上课 shàngkè attend class ·
上班 shàngbān go to work · 非常 fēicháng very · 特别 tèbié especially

## Recurring mistakes (drill these)
- Example: puts 是 before a plain verb (said 你是喜欢跳舞; correct: 你喜欢跳舞).
  是 only before nouns or in 是不是 questions.
- Example: 是不是 vs A-not-A nuance fuzzy — knows both, unsure when each fits.
  (是不是 = emphasize the trait; A-not-A = neutral/everyday.)`;

export const STUDY_MAP = `# Study Map — what to learn + where
Where they are: Integrated Chinese Vol. 1, Lessons 3–4 (Time & Date → Hobbies).
5 sources: TB textbook · WB workbook · CharWB character workbook (handwriting) ·
Notes own lesson notes · Tutor flashcard slides.

## Current focus (L3–L4)
- Characters: work the Character Workbook in order (Basics → 3-1 → 3-2 → 4-1 → 4-2).
  Hand-write now: 忙 没 字.
- Grammar: numbers to 100, dates, telling time, 的 as modifier, invitation "我请你吃饭",
  alternative questions, A-not-A (I & II), 还 + repeat verb, 是不是 questions,
  有(一)点儿 as predicate, 不行 vs 不好, 想 (want to), verb-object compounds.
- Vocab: time & date words, hobby/activity verbs (听音乐 看电影 跳舞 跑步 游泳 打球 上课 上班),
  food & invitations, response phrases (好的/好啊/没问题/不行), degree adverbs (太…了 非常 特别).
- Speaking/tones: dinner-invite role-play; fix 我请你吃饭, 请他吃饭; drop 是 before a verb.

## The real target: HSK 3.0 by the exam date
Goal = HSK 3.0 (2021), ~2,193 words across bands 1–3 (the HSK-3 tier itself is the 973-word band),
by a fixed exam date. The HSK Scorecard computes exact per-band coverage + a pace/ETA verdict, and
study aims at whatever band is lowest-coverage. Integrated Chinese Vol. 1 only carries a learner
through ~HSK 1–2; it CANNOT reach 973/HSK-3 vocab alone.

## HSK-3 vocab track (source for band 2–3 words, beyond IC Vol. 1)
Once IC L1–L10 vocab is banked, pull new words from a dedicated HSK-3 source to feed bands 2–3:
- IC Vol. 2 (continues the same loop), and/or
- an HSK 2 → HSK 3 Pleco deck worked in band order (finish HSK 1 gaps → HSK 2 → HSK 3).
If the Scorecard shows bands 1–2 near-complete but band 3 flat, that's SOURCE EXHAUSTION, and the
weekly review should flag it: they need new material, not more IC Vol. 1.

## Standing weak spot: LISTENING (biggest gap)
The notes have almost no listening. Lucy hands out real, named listening sources each morning
(picked by code from lib/listening-sources.ts) — listen, then reply with which one you picked and
one thing you caught. If a week passes with zero listening, that becomes the day's one action.

## Per-lesson loop (reuse every lesson)
TB (learn) → Pleco (vocab) → CharWB (write) → WB (all 4 skills incl. listening) → tutor (speak)
→ log new words to the Ledger.

## Route from here
1. Lock down L3 (Time & Date): TB L3 → WB L3 → CharWB 3-1 & 3-2.
2. Do the L3 vocab reviews already waiting in the deck (cards are made automatically — never by hand).
3. Drill the 4 recurring grammar points once, well: A-not-A, 是不是, 还+repeat verb, 有(一)点儿.
4. Speak it: dinner-invitation role-play out loud, then with the tutor.
5. Fix flagged tones.
6. Move into L4 (Hobbies): verb-object compounds → WB L4 → CharWB 4-1 & 4-2.
7. Close the listening gap: listen to one of the sources Lucy offers each day, and report back.
8. Then L5 (Visiting Friends) onward, same loop.`;

export const DAILY_LOG = `# Daily Log — the heartbeat
Newest entry on top. Each morning: check if the last action got done (evidence in Telegram/Notion),
then write the next ONE action, calibrated to known + 1–2 new. Never pile new work on an undone task.

## Day 3 (example)
- ONE action: hand-write 忙 没 字, 10× each (CharWB Lesson 3-1). Photo each page.
  Then say 3 sentences aloud with NO 是 before the verb: 我喜欢跳舞 · 我常常听音乐 · 我喜欢看电影.
- Stretch (only if energy): one A-not-A question aloud — 你明天去不去?
- Strand: characters (writing) + speaking fix-up.
- Note: carried from Day 1, no homework photo yet, so nothing new piled on. Same small task, fresh day.

## Day 1 (example)
- ONE action: hand-write 忙 没 字 10× each (CharWB 3-1) + 3 sentences aloud with no 是 before the verb.
- Done: carried (no photo yet).
- Note: first tutor session logged. Speaking bit fixes a common slip, saying
  你是喜欢跳舞; drop the 是 (你喜欢跳舞).`;

export const GRADEBOOK = `WEEK FOCUS: Fix 是-before-verb in speech, and listen to one of the offered sources daily (close the listening gap).

# Gradebook — teacher's tracking sheet
The learner reads the verdict; they don't edit it. The Sunday run refreshes it.

## Headline verdict (judged by pace + time)
- Lesson pace: ~1 lesson / 2 weeks (adaptive). On L3–L4. 🟢 on schedule.
- Study time: per-day budget — 60 min on tutor days (Mon/Wed/Sat), 90 min Tue/Thu, 120 min Fri/Sun. This week: slow start (weekend task carried). 🟡

Lesson windows (flex): L3 (Time & Date) solid in ~2 weeks · L4 (Hobbies) solid in ~4 weeks.

## Skill strands
- Characters & writing 🟡 — first task (忙没字) still open, carried; no photo yet.
- Workbook (all 4 skills) ⚪ — not started.
- Listening 🔴 — known standing gap; protect it. If a week passes with zero listening it becomes the day's one action.
- Vocab / tutor words 🟡 — cards are auto-created from lessons; the gap is doing the reviews.
- Speaking & tones 🟡 — new fix: drop 是 before a verb; also 我请你吃饭 tones.
- Grammar 🟢 — strong on A-not-A; 是不是 nuance still fuzzy.

## Tutor rhythm — three sessions a week
Recent session: did well on A-not-A (去不去, 看不看, 跳不跳舞) + verb-object compounds
(听音乐, 看电影, 跳舞, 打球) + time periods. Struggled with 是 before a verb, and 是不是 vs A-not-A.
Fix-up: 3 statements aloud with no 是 before the verb.

## Weekly reports
(first Sunday review appends here)`;

// Integrated Chinese Vol. 1 vocab spine (clean hanzi from the character workbook) — seeds the
// Syllabus Index so de-dupe + calibration know the whole known/learning set, lesson by lesson.
export const SYLLABUS: Array<{ chapter: string; section: string; vocab: string; grammar: string }> = [
  { chapter: "Basics — Numerals", section: "character-workbook", vocab: "一 二 三 四 五 六 七 八 九 十", grammar: "numbers 1–10" },
  { chapter: "Basics — Radicals", section: "character-workbook", vocab: "人 刀 力 又 口 土 夕 囗 大 女 子 寸 小 工 幺 弓 心 戈 手 日 月 木 水 火 田 目 示 糸 言 衣 耳 贝 走 足 金 门 雨 食 隹 马", grammar: "strokes, stroke order, radicals" },
  { chapter: "Lesson 1 — Greetings", section: "textbook", vocab: "你 好 请 问 贵 姓 我 呢 叫 什么 姐 字 先生 名字 朋友 是 老师 吗 也 学生 不 学 中国 北京 美国", grammar: "是 (A 是 B); 吗 questions; wh-questions 什么/谁; 呢" },
  { chapter: "Lesson 2 — Family", section: "textbook", vocab: "那 的 照片 这 个 谁 男孩子 女孩子 她 他 弟弟 哥哥 儿子 女儿 有 没 都 高 文 医生 英文 爱 两 家 几 妹妹 做 和", grammar: "的 possession; measure words 个; 有/没有; 两 vs 二; 都" },
  { chapter: "Lesson 3 — Time & Date", section: "textbook", vocab: "号 星期 天 今天 年 多 大 岁 吃 饭 怎么样 太…了 谢谢 喜欢 菜 还是 可是 我们 点 半 晚上 见 再见 现在 刻 事 很 忙 明天 为什么 因为 同学 认识 朋友 生日", grammar: "numbers to 100; dates; telling time; 的 as modifier; alternative questions; A-not-A (I); 还 + repeat verb; 太…了" },
  { chapter: "Lesson 4 — Hobbies", section: "textbook", vocab: "周末 打球 看 电视 唱歌 跳舞 听 音乐 书 对 有的 时候 电影 常常 那 去 外国 请客 昨天 所以 好久 不错 想 觉得 有意思 只 睡觉 算了 找 别人", grammar: "word order (time-place-verb); A-not-A (II); 那么; 去 + action; 想 want to; verb-object compounds; 是不是 questions" },
  { chapter: "Lesson 5 — Visiting Friends", section: "textbook", vocab: "呀 进 快 来 介绍 一下 高兴 坐 哪 漂亮 玩 图书馆 聊天 才 回 喝 学校 茶 咖啡 吧 瓶 要 给 杯 起", grammar: "一下 / (一)点儿; adjectives as predicate with 很; 在; 吧; 了; 要" },
  { chapter: "Lesson 6 — Making Appointments", section: "textbook", vocab: "话 喂 就 您 位 时间 问题 节 课 开会 上课 考试 以后 有空 方便 到 公室 行 办 等 天气 帮 准备 练习 说 但是 跟 见面", grammar: "的 time clauses; 给 + person; alternative expressions; 就; 从…到" },
  { chapter: "Lesson 7 — Studying Chinese", section: "textbook", vocab: "复习 写 慢 枝 张 笔 教 纸 懂 里 真 预习 第 语法 容易 词 汉字 难 用功 平常 早 开始 念 录音 帅 酷", grammar: "得 (degree complement); 太…了; 快…了; ordinal 第; 有一点儿" },
  { chapter: "Lesson 8 — School Life", section: "textbook", vocab: "篇 日记 累 起床 洗澡 一边 发 新 电脑 餐厅 宿舍 网 正在 告诉 已经 知道 以前 封 信 最近 专业 希望 除了 除了…以外 用 笑 能 祝", grammar: "正在 (progressive); 就; 一边…一边; 除了…以外; 能 vs 会" },
  { chapter: "Lesson 9 — Shopping", section: "textbook", vocab: "商店 买 东西 售货员 服务 件 衬衫 颜色 红 黄 穿 裤子 合适 便宜 长 短 少 一共 钱 块 毛 分 百 双 黑 鞋 换 虽然 种 挺 它 刷卡 收 付 过", grammar: "的 (nominalizer); 多 + adj; 虽然…可是; 跟…一样; 越…越" },
  { chapter: "Lesson 10 — Transportation", section: "textbook", vocab: "寒假 飞机 机场 汽车 火车 票 或者 地铁 站 绿 线 蓝 麻烦 出租车 送 邮件 让 花 每 城市 特 高速 紧张 自己", grammar: "或者 vs 还是; 先…再; 每…都; complements; 让" },
];
