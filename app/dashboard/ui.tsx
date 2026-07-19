import type { ReactNode } from "react";
import type { Verdict } from "@/lib/hsk";
import styles from "./dashboard.module.css";

const clampPct = (x: number) => Math.max(0, Math.min(100, Math.round(x * 100)));

/** A titled card. `span` maps to the 12-col grid. */
export function Card({
  title,
  span,
  note,
  action,
  children,
}: {
  title: string;
  span: 4 | 5 | 6 | 7 | 8 | 12;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const spanClass = { 4: styles.span4, 5: styles.span5, 6: styles.span6, 7: styles.span7, 8: styles.span8, 12: styles.span12 }[span];
  return (
    <section className={`${styles.card} ${spanClass}`}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{title}</h2>
        {action ?? (note ? <span className={styles.cardNote}>{note}</span> : null)}
      </div>
      {children}
    </section>
  );
}

export function Tile({
  value,
  unit,
  label,
  accent,
}: {
  value: string | number;
  unit?: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className={styles.tile}>
      <div className={`${styles.tileValue} ${accent ? styles.flame : ""}`}>
        {value}
        {unit ? <span className={styles.tileUnit}>{unit}</span> : null}
      </div>
      <div className={styles.tileLabel}>{label}</div>
    </div>
  );
}

/** A labelled magnitude bar (HSK band coverage). */
export function BandBar({
  name,
  sub,
  known,
  total,
  pct,
}: {
  name: string;
  sub?: string;
  known: number;
  total: number;
  pct: number;
}) {
  return (
    <div className={styles.bandRow}>
      <div className={styles.bandName}>
        {name}
        {sub ? <small>{sub}</small> : null}
      </div>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${clampPct(pct)}%` }} />
      </div>
      <div className={styles.bandFig}>
        <b>{known}</b>/{total} · {clampPct(pct)}%
      </div>
    </div>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const map: Record<Verdict, { cls: string; icon: string; label: string }> = {
    ahead: { cls: styles.badgeGood, icon: "▲", label: "Ahead of pace" },
    "on-track": { cls: styles.badgeOn, icon: "●", label: "On track" },
    behind: { cls: styles.badgeBehind, icon: "▼", label: "Behind pace" },
    unknown: { cls: styles.badgeUnknown, icon: "○", label: "Pace unknown" },
  };
  const v = map[verdict];
  return (
    <span className={`${styles.badge} ${v.cls}`}>
      <span aria-hidden>{v.icon}</span>
      {v.label}
    </span>
  );
}

export { styles as dashStyles, clampPct };
