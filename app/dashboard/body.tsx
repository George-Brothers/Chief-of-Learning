import type { DashboardData } from "@/lib/dashboard";
import { HSK_DEADLINE } from "@/lib/hsk/data";
import { classifyDay, studyPlanShape } from "@/lib/rhythm";
import { Panel, Row, Fig, Note, Meter, Flag, VerdictFlag, dashStyles as s } from "./ui";
import { Markdown } from "./markdown";
import { Chat, PlanChecklist, AssignmentList } from "./client";

/** How many listening reps a week counts as covered — the same 3/wk the coach asks for. */
const LISTEN_TARGET = 3;

/** YYYY-MM-DD in the learner's timezone — dates read as data here, never as prose. */
export function fmtIso(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** HH:MM in the learner's timezone — a heartbeat needs finer resolution than a date. */
function fmtTime(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
}

/** MM-DD, for the log's left rail. */
function fmtShort(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit", day: "2-digit" }).format(d);
}

/** Everything below the callsign bar. Split out of page.tsx so it can be rendered in tests. */
export function DashboardBody({ data }: { data: DashboardData }) {
  const { coverage, pace, xp, listening } = data;
  const now = new Date(data.generatedAt);
  const shape = studyPlanShape(now, data.timezone);
  const day = classifyDay(now, data.timezone);
  const cumulativePct = coverage.cumulativeTotal ? coverage.cumulativeKnown / coverage.cumulativeTotal : 0;
  const planned = data.todayPlan.blocks.reduce((n, b) => n + (b.minutes ?? 0), 0);
  const dayKind = shape.tutorDay
    ? day.lessonTonight
      ? "tutor · tonight"
      : "tutor · morning"
    : day.dayAfterLesson
      ? "post-lesson"
      : "self-study";

  // "Down" here means the same thing the daily brief alarms on: not running, AND work stuck behind it.
  const agentDown = data.agent.presence !== "online" && data.agent.queuedTasks > 0;

  const listenTone =
    listening.weekCount >= LISTEN_TARGET ? "live" : listening.weekCount === 0 ? "alarm" : "amber";
  const listenLabel =
    listening.weekCount >= LISTEN_TARGET ? "On target" : listening.weekCount === 0 ? "Standing gap" : "Short";

  return (
    <>
      {!data.hasLiveData ? (
        <div className={s.banner}>
          <span className={s.bannerTag}>Empty brain</span>
          No known words loaded, so coverage and pace read zero. They fill in as soon as your Notion syllabus,
          ledger and decks have vocab.
        </div>
      ) : null}

      {/* THE READOUT — the three numbers the whole thing turns on. */}
      <hr className={s.hr} />
      <div className={s.readout}>
        <Row label="Retained">
          <Fig value={coverage.cumulativeKnown} />
          <span className={s.slash} aria-hidden>╱</span>
          <Fig value={coverage.cumulativeTotal} small muted />
          <Fig value={`${(cumulativePct * 100).toFixed(1)}%`} small />
          <Note>toward HSK 3 · {coverage.gapToTarget} to go</Note>
        </Row>
        <Row label="Pace">
          <Fig value={pace.observedPerWeek !== undefined ? `${Math.round(pace.observedPerWeek)}/wk` : "—/wk"} />
          <Note>
            {Number.isFinite(pace.wordsPerWeekNeeded)
              ? `need ${Math.round(pace.wordsPerWeekNeeded)}/wk · ${pace.daysLeft} days to ${HSK_DEADLINE}`
              : `deadline ${HSK_DEADLINE} reached`}
          </Note>
        </Row>
        <Row label="Status">
          <VerdictFlag verdict={pace.verdict} />
          <Note>
            {pace.etaDate
              ? `at this rate you finish ${fmtIso(pace.etaDate.toISOString(), data.timezone)}`
              : "no observed rate yet — log a week of study and this reads properly"}
          </Note>
        </Row>
        <Row label="Streak">
          <Fig value={`${data.streak}d`} small />
          <Note>
            L{xp.level} {xp.title} · {xp.intoLevel}/{xp.forNextLevel} XP · {data.studyDays} days logged
          </Note>
        </Row>
      </div>
      <hr className={s.hr} />

      {/* TODAY — the hero. Interactive, and the only loud thing on the page. */}
      <section className={s.today}>
        <div className={s.todayHead}>
          <h2 className={s.todayTag}>Today</h2>
          <span className={s.todayBudget}>
            {shape.budgetMinutes}
            <span className={s.todayUnit}>m</span>
          </span>
          <span className={s.todayKind}>{dayKind}</span>
        </div>
        <p className={s.todayNote}>
          {data.todayPlan.blocks.length === 0
            ? "Nothing on today's post-it yet — ask Lucy for a plan in the chat below."
            : `${data.todayPlan.blocks.length} blocks${planned ? ` · ${planned}m planned of ${shape.budgetMinutes}m` : ""} · ticking a box logs it exactly like texting Lucy`}
        </p>
        {data.todayPlan.blocks.length > 0 ? <PlanChecklist blocks={data.todayPlan.blocks} completedIds={data.completedBlockIds} /> : null}
        {data.todayPlan.raw.trim() ? (
          <details>
            <summary className={s.todayKind}>Post-it as Lucy wrote it</summary>
            <p className={s.rawPlan}>{data.todayPlan.raw.trim()}</p>
          </details>
        ) : null}
      </section>

      <Panel
        tag="Assignments"
        meta={data.openAssignments.length ? `${data.openAssignments.length} open` : "all clear"}
      >
        {data.openAssignments.length === 0 ? (
          <p className={s.empty}>Nothing carried over. Anything Lucy sets in a lesson shows up here.</p>
        ) : (
          <AssignmentList items={data.openAssignments} />
        )}
      </Panel>

      <Panel tag="Listen" meta={`${listening.weekCount}/${LISTEN_TARGET} this week`}>
        <div className={s.readout}>
          <Row label="Reps">
            <Fig value={`${listening.weekCount}/${LISTEN_TARGET}`} small />
            <Flag tone={listenTone} glyph={listenTone === "live" ? "●" : "▲"} label={listenLabel} />
          </Row>
          <Row label="Accuracy">
            <Fig
              value={listening.total ? `${Math.round((listening.correct / listening.total) * 100)}%` : "—"}
              small
            />
            <Note>
              {listening.total
                ? `${listening.correct} of the last ${listening.total} cloze checks`
                : "no cloze checks recorded yet"}
            </Note>
          </Row>
        </div>
        {listening.checks.length ? (
          <ul className={s.ticks}>
            {listening.checks.map((c, i) => (
              <li key={`${c.date}-${i}`} className={`${s.tick} ${c.ok ? s.tickOk : s.tickBad}`}>
                <span aria-hidden>{c.ok ? "✓" : "✗"}</span> {c.word}
              </li>
            ))}
          </ul>
        ) : null}
        {listening.unusedSources.length ? (
          <ul className={s.tags}>
            <li className={s.tagsLabel}>cold sources</li>
            {listening.unusedSources.slice(0, 6).map((src) => (
              <li key={src.id}>{src.name}</li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {/* ── AGENT PANEL ── owned by the agent-liveness change, not by the dashboard redesign.
          Deliberately minimal and built only from existing Panel/Row/Fig/Note/Flag primitives, so it
          can be restyled or moved without touching any logic. Data comes from data.agent. ── */}
      <Panel
        tag="Agent"
        meta={agentDown ? "action needed" : data.agent.presence === "online" ? "running" : "idle"}
      >
        <div className={s.readout}>
          <Row label="Laptop">
            <Flag
              tone={data.agent.presence === "online" ? "live" : agentDown ? "alarm" : "muted"}
              glyph={data.agent.presence === "online" ? "●" : agentDown ? "▼" : "○"}
              label={
                data.agent.presence === "online"
                  ? "Online"
                  : data.agent.presence === "offline"
                    ? "Offline"
                    : "No reading"
              }
            />
            <Note>
              {data.agent.lastSeenIso
                ? `last check-in ${fmtIso(data.agent.lastSeenIso, data.timezone)} ${fmtTime(data.agent.lastSeenIso, data.timezone)}`
                : "has never checked in"}
            </Note>
          </Row>
          <Row label="Anki">
            <Fig
              value={data.agent.ankiReachable === null ? "—" : data.agent.ankiReachable ? "open" : "closed"}
              small
              muted={data.agent.ankiReachable !== true}
            />
            <Note>
              {data.agent.ankiReachable === null
                ? "AnkiConnect has never been probed"
                : data.agent.ankiReachable
                  ? "AnkiConnect answered on the last attempt"
                  : "AnkiConnect did not answer on the last attempt"}
            </Note>
          </Row>
          <Row label="Queue">
            <Fig value={data.agent.queuedCards || data.agent.queuedTasks} small />
            <Note>
              {data.agent.queuedTasks === 0
                ? "nothing waiting"
                : `${data.agent.queuedCards} card${data.agent.queuedCards === 1 ? "" : "s"} in ${data.agent.queuedTasks} batch${data.agent.queuedTasks === 1 ? "" : "es"} waiting to be added`}
            </Note>
          </Row>
          {data.agent.erroredTasks > 0 ? (
            <Row label="Failed">
              <Fig value={data.agent.erroredTasks} small />
              <Flag tone="alarm" glyph="▼" label="Stuck" />
              <Note>send /agent retry on Telegram to re-queue</Note>
            </Row>
          ) : null}
        </div>
        {data.agent.errors.length ? (
          <>
            {data.agent.errors.map((e) => (
              <div key={e.id} className={s.logRow}>
                <span className={s.logDate}>error</span>
                <span className={s.logType}>{e.label}</span>
                <span className={s.logText}>{e.result || "no reason recorded"}</span>
              </div>
            ))}
          </>
        ) : null}
      </Panel>

      <Panel tag="Coverage" meta="HSK 3.0 bands">
        {coverage.bands.map((b) => (
          <Meter
            key={b.band}
            name={`HSK ${b.band}`}
            pct={b.pct}
            figure={
              <>
                <b>{b.known}</b>/{b.total} · {Math.round(b.pct * 100)}%
              </>
            }
          />
        ))}
        <Meter
          name="Reading"
          pct={coverage.charsTotal ? coverage.charsKnown / coverage.charsTotal : 0}
          figure={
            <>
              <b>{coverage.charsKnown}</b>/{coverage.charsTotal} chars
            </>
          }
        />
      </Panel>

      <Panel tag="Focus" meta="from your evidence">
        {data.focusAreas.map((f, i) => (
          <div key={i} className={s.focus}>
            <span className={s.focusIdx} aria-hidden>
              {i + 1}
            </span>
            <div>
              <p className={s.focusArea}>
                {f.area}
                {f.hits > 1 ? <Note> · seen {f.hits}×</Note> : null}
              </p>
              <p className={s.focusFix}>{f.suggestion}</p>
            </div>
          </div>
        ))}
      </Panel>

      <Panel tag="Lessons" meta={`${data.lessonHistory.length} on file`}>
        {data.lessonHistory.length === 0 ? (
          <p className={s.empty}>No lessons logged yet. Send Lucy the transcript after your next session.</p>
        ) : (
          data.lessonHistory.slice(0, 4).map((l) => (
            <article key={l.id} className={s.lesson}>
              <div className={s.lessonHead}>
                <span className={s.lessonDate}>{l.date || "—"}</span>
                {l.durationMinutes ? <Note>{l.durationMinutes}m</Note> : null}
              </div>
              {l.summary ? <Markdown source={l.summary} className={s.lessonSummary} /> : null}
              {l.couldNotSay.length ? (
                <div className={s.kv}>
                  <span className={s.kvKey}>Couldn&apos;t say</span>
                  <span className={`${s.kvVal} ${s.kvHot}`}>{l.couldNotSay.join(" · ")}</span>
                </div>
              ) : null}
              {l.errors.length ? (
                <div className={s.kv}>
                  <span className={s.kvKey}>Corrections</span>
                  <span className={s.kvVal}>
                    {l.errors.slice(0, 4).map((e, i) => (
                      <span key={i}>
                        {i > 0 ? " · " : ""}
                        <span className={s.hanzi} lang="zh-Hans">{e.quote}</span>
                        {e.correction ? (
                          <>
                            {" → "}
                            <span lang="zh-Hans">{e.correction}</span>
                          </>
                        ) : ""}
                      </span>
                    ))}
                  </span>
                </div>
              ) : null}
              {l.vocabIntroduced.length ? (
                <div className={s.kv}>
                  <span className={s.kvKey}>New vocab</span>
                  <span className={s.kvVal}>
                    {l.vocabIntroduced.slice(0, 8).map((v, i) => (
                      <span key={i}>
                        {i > 0 ? " · " : ""}
                        <span className={s.hanzi} lang="zh-Hans">{v.headword}</span> {v.pinyin}
                      </span>
                    ))}
                  </span>
                </div>
              ) : null}
              {l.grammarPoints.length ? (
                <div className={s.kv}>
                  <span className={s.kvKey}>Grammar</span>
                  <span className={s.kvVal}>{l.grammarPoints.join(" · ")}</span>
                </div>
              ) : null}
              {l.homework ? (
                <div className={s.kv}>
                  <span className={s.kvKey}>Homework</span>
                  <Markdown source={l.homework} className={s.kvVal} />
                </div>
              ) : null}
            </article>
          ))
        )}
      </Panel>

      <Panel tag="Log" meta={data.timezone}>
        {data.activity.length === 0 && data.lessons.length === 0 ? (
          <p className={s.empty}>Nothing logged yet. Send a check-in on Telegram or in the chat below.</p>
        ) : (
          <>
            {data.activity.slice(0, 10).map((a) => (
              <div key={a.id} className={s.logRow}>
                <span className={s.logDate}>{fmtShort(a.createdTime, data.timezone)}</span>
                <span className={s.logType}>{a.type || "note"}</span>
                <span className={s.logText}>{a.summary || "—"}</span>
              </div>
            ))}
            {data.lessons.slice(0, 3).map((l) => (
              <div key={l.id} className={s.logRow}>
                <span className={s.logDate}>{l.date}</span>
                <span className={s.logType}>lesson</span>
                <span className={s.logText}>{l.summary || "Tutor lesson"}</span>
              </div>
            ))}
          </>
        )}
      </Panel>

      <Panel tag="Map" meta="where Lucy is steering">
        <div className={s.docGrid}>
          <div>
            <p className={s.panelMeta}>Study map</p>
            {data.studyMap.trim() ? (
              <Markdown source={data.studyMap.trim()} label="Study map" />
            ) : (
              <p className={s.empty}>Study Map is empty.</p>
            )}
          </div>
          <div>
            <p className={s.panelMeta}>Knowledge ledger</p>
            {data.ledger.trim() ? (
              <Markdown source={data.ledger.trim().slice(0, 4000)} label="Knowledge ledger" />
            ) : (
              <p className={s.empty}>Ledger is empty.</p>
            )}
          </div>
        </div>
      </Panel>

      {data.gradebook.trim() ? (
        <Panel tag="Gradebook" meta="what Lucy has graded">
          <Markdown source={data.gradebook.trim().slice(0, 4000)} />
        </Panel>
      ) : null}

      <Panel tag="Chat" meta="same brain as Telegram">
        <Chat />
      </Panel>
    </>
  );
}
