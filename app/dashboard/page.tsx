import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isValidSessionValue } from "@/lib/auth";
import { loadDashboard, type DashboardData } from "@/lib/dashboard";
import { HSK_DEADLINE } from "@/lib/hsk/data";
import { Card, Tile, BandBar, VerdictBadge, dashStyles as s, clampPct } from "./ui";
import { Chat, LogoutButton } from "./client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Lucy · Dashboard",
  description: "Your Chinese-learning command center.",
};

function fmtDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d);
}

function fmtStamp(iso: string, tz: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export default async function DashboardPage() {
  const store = await cookies();
  if (!isValidSessionValue(store.get(SESSION_COOKIE)?.value)) redirect("/login");

  let data: DashboardData | null = null;
  let loadError = false;
  try {
    data = await loadDashboard();
  } catch (err) {
    console.error("dashboard load error", err);
    loadError = true;
  }

  return (
    <div className={s.root}>
      <div className={s.shell}>
        <header className={s.header}>
          <div className={s.brand}>
            <div className={s.seal} aria-hidden>
              露
            </div>
            <div>
              <h1 className={s.brandName}>Lucy · 学习中文</h1>
              <p className={s.brandSub}>Your Chinese-learning command center</p>
            </div>
          </div>
          <div className={s.headerMeta}>
            {data ? <span className={s.stamp}>Updated {fmtStamp(data.generatedAt, data.timezone)}</span> : null}
            <LogoutButton />
          </div>
        </header>

        {loadError || !data ? (
          <div className={s.grid}>
            <div className={s.banner}>
              Couldn&apos;t reach the brain. This dashboard reads live from Notion + the AI Gateway — make sure
              the Notion token and page IDs are configured in the environment, then reload.
            </div>
          </div>
        ) : (
          <DashboardBody data={data} />
        )}
      </div>
    </div>
  );
}

function DashboardBody({ data }: { data: DashboardData }) {
  const { coverage, pace, xp } = data;
  const bandLabel = (b: number) => `HSK ${b}`;
  const cumulativePct = coverage.cumulativeTotal ? coverage.cumulativeKnown / coverage.cumulativeTotal : 0;

  return (
    <div className={s.grid}>
      {!data.hasLiveData ? (
        <div className={s.banner}>
          No known words loaded yet — showing an empty scorecard. Once your Notion brain has vocab (syllabus,
          ledger, decks), coverage and pace fill in automatically.
        </div>
      ) : null}

      {/* 1. HSK progress & scorecard */}
      <Card
        title="HSK 3.0 Progress"
        span={8}
        action={<VerdictBadge verdict={pace.verdict} />}
      >
        <div className={s.tiles} style={{ marginBottom: 18 }}>
          <Tile value={coverage.cumulativeKnown} unit={`/ ${coverage.cumulativeTotal}`} label="Words toward HSK 3" />
          <Tile value={`${clampPct(cumulativePct)}%`} label="Overall coverage" />
          <Tile value={coverage.gapToTarget} label="Word gap remaining" />
          <Tile value={pace.daysLeft} unit="days" label={`Until ${HSK_DEADLINE}`} />
        </div>
        {coverage.bands.map((b) => (
          <BandBar
            key={b.band}
            name={bandLabel(b.band)}
            sub={`${b.total} words`}
            known={b.known}
            total={b.total}
            pct={b.pct}
          />
        ))}
        <div className={s.bandRow}>
          <div className={s.bandName}>
            Reading
            <small>characters</small>
          </div>
          <div className={s.track}>
            <div
              className={s.fill}
              style={{ width: `${coverage.charsTotal ? clampPct(coverage.charsKnown / coverage.charsTotal) : 0}%` }}
            />
          </div>
          <div className={s.bandFig}>
            <b>{coverage.charsKnown}</b>/{coverage.charsTotal}
          </div>
        </div>
        <p className={s.cardNote} style={{ marginTop: 12, display: "block" }}>
          {Number.isFinite(pace.wordsPerWeekNeeded)
            ? `Need ~${Math.round(pace.wordsPerWeekNeeded)} words/week to stay on schedule`
            : "Deadline reached — pace pinned"}
          {pace.observedPerWeek !== undefined ? ` · observed ~${Math.round(pace.observedPerWeek)}/week` : ""}
          {pace.etaDate ? ` · ETA ${fmtDate(pace.etaDate.toISOString(), data.timezone)}` : ""}
        </p>
      </Card>

      {/* 5+6. Streak, XP, gamification */}
      <Card title="How I'm holding up" span={4}>
        <div className={s.tiles}>
          <Tile value={`${data.streak}🔥`} label="day streak" accent />
          <Tile value={data.xp.level} label={data.xp.title} />
        </div>
        <div style={{ marginTop: 16 }}>
          <div className={s.bandName} style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <span>Level {data.xp.level}</span>
            <span className={s.hitTag}>
              {data.xp.intoLevel} / {data.xp.forNextLevel} XP
            </span>
          </div>
          <div className={`${s.track} ${s.xpTrack}`}>
            <div className={`${s.fill} ${s.xpFill}`} style={{ width: `${clampPct(data.xp.pctToNext)}%` }} />
          </div>
          <p className={s.cardNote} style={{ marginTop: 10, display: "block" }}>
            {data.xp.xp.toLocaleString()} XP total · {data.studyDays} active days logged
          </p>
        </div>
      </Card>

      {/* 4. Focus areas & coaching */}
      <Card title="Focus areas" span={5} note="from your evidence + week focus">
        {data.weekFocus && !data.focusAreas.some((f) => f.fromWeekFocus) ? (
          <p className={s.focusSuggestion} style={{ marginBottom: 8 }}>
            <strong>This week:</strong> {data.weekFocus}
          </p>
        ) : null}
        {data.focusAreas.map((f, i) => (
          <div key={i} className={s.focusItem}>
            <div className={s.focusDot}>{i + 1}</div>
            <div>
              <p className={s.focusArea}>
                {f.area} {f.hits > 1 ? <span className={s.hitTag}>· seen {f.hits}×</span> : null}
              </p>
              <p className={s.focusSuggestion}>{f.suggestion}</p>
            </div>
          </div>
        ))}
      </Card>

      {/* 2. Recent activity */}
      <Card title="Recent activity" span={7} note={`${data.timezone}`}>
        {data.activity.length === 0 && data.lessons.length === 0 ? (
          <p className={s.empty}>Nothing logged yet. Send Lucy a check-in on Telegram or in the chat below.</p>
        ) : (
          <div>
            {data.activity.slice(0, 8).map((a) => (
              <div key={a.id} className={s.activityRow}>
                <span className={s.activityDate}>{fmtDate(a.createdTime, data.timezone)}</span>
                <span className={s.activityType}>{a.type || "note"}</span>
                <span className={s.activityText}>{a.summary || "—"}</span>
              </div>
            ))}
            {data.lessons.slice(0, 3).map((l) => (
              <div key={l.id} className={s.activityRow}>
                <span className={s.activityDate}>{l.date}</span>
                <span className={s.activityType}>lesson</span>
                <span className={s.activityText}>{l.summary || "Tutor lesson"}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 3. Study plan & map */}
      <Card title="Study plan & map" span={12} note="where Lucy is steering you">
        <div className={s.planGrid}>
          <div>
            <p className={s.cardNote} style={{ display: "block", marginBottom: 6 }}>Study Map</p>
            {data.studyMap.trim() ? (
              <div className={s.prose}>{data.studyMap.trim()}</div>
            ) : (
              <p className={s.empty}>Study Map is empty.</p>
            )}
          </div>
          <div>
            <p className={s.cardNote} style={{ display: "block", marginBottom: 6 }}>Knowledge Ledger</p>
            {data.ledger.trim() ? (
              <div className={s.prose}>{data.ledger.trim().slice(0, 2000)}</div>
            ) : (
              <p className={s.empty}>Ledger is empty.</p>
            )}
          </div>
        </div>
      </Card>

      {/* 5. Talk to Lucy */}
      <Card title="Talk to Lucy" span={12}>
        <Chat />
      </Card>
    </div>
  );
}
