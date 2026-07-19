import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, isValidSessionValue } from "@/lib/auth";
import { loadDashboard, type DashboardData } from "@/lib/dashboard";
import { HSK_DEADLINE } from "@/lib/hsk/data";
import { dashStyles as s } from "./ui";
import { DashboardBody, fmtIso } from "./body";
import { LogoutButton } from "./client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Lucy \u00b7 Dashboard",
  description: "Your Chinese-learning instrument panel.",
};

/** Clock reading for the callsign bar — 24h, in the learner's timezone. */
function fmtStamp(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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
        <div className={s.topbar}>
          <h1 className={s.callsign}>
            <span className={s.callsignName}>
              LUCY <em lang="zh-Hans">学习中文</em>
            </span>
            {data ? (
              <>
                <span className={s.sep} aria-hidden>│</span>
                <span className={s.callsignFig}>D−{data.pace.daysLeft}</span>
                <span className={s.sep} aria-hidden>│</span>
                <span className={s.callsignFig}>
                  HSK3 {data.pace.etaDate ? `ETA ${fmtIso(data.pace.etaDate.toISOString(), data.timezone)}` : `BY ${HSK_DEADLINE}`}
                </span>
              </>
            ) : null}
          </h1>
          <div className={s.topMeta}>
            {data ? <span>{fmtStamp(data.generatedAt, data.timezone)} {data.timezone}</span> : null}
            <LogoutButton />
          </div>
        </div>

        {loadError || !data ? (
          <div className={s.banner}>
            <span className={s.bannerTag}>No signal</span>
            Couldn&apos;t reach the brain. This page reads live from Notion — check the Notion token and page
            IDs in the environment, then reload.
          </div>
        ) : (
          <DashboardBody data={data} />
        )}
      </div>
    </div>
  );
}
