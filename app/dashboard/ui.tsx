import type { ReactNode } from "react";
import type { Verdict } from "@/lib/hsk";
import styles from "./dashboard.module.css";

const clampPct = (x: number) => Math.max(0, Math.min(100, Math.round(x * 100)));

/** An instrument block: a labelled rail, an optional right-hand reading, and the block's rows. */
export function Panel({
  tag,
  meta,
  children,
}: {
  tag: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h2 className={styles.panelTag}>{tag}</h2>
        <span className={styles.panelFill} aria-hidden />
        {meta ? <span className={styles.panelMeta}>{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** One line of the top readout: a small caps label and a figure. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.roRow}>
      <span className={styles.roLabel}>{label}</span>
      <span className={styles.roValue}>{children}</span>
    </div>
  );
}

export function Fig({ value, small, muted }: { value: string | number; small?: boolean; muted?: boolean }) {
  return (
    <span className={`${small ? styles.figSm : styles.fig} ${muted ? styles.figMuted : ""}`}>
      {value}
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <span className={styles.note}>{children}</span>;
}

/**
 * A segmented magnitude meter. `pct` is 0..1. The bar is decorative — the same numbers are printed
 * beside it — so it carries aria-hidden and the row reads out as text to a screen reader.
 */
export function Meter({
  name,
  pct,
  figure,
}: {
  name: string;
  pct: number;
  figure: ReactNode;
}) {
  return (
    <div className={styles.meterRow}>
      <span className={styles.meterName}>{name}</span>
      <div className={styles.meter} aria-hidden>
        <div className={styles.meterFill} style={{ width: `${clampPct(pct)}%` }} />
      </div>
      <span className={styles.meterFig}>{figure}</span>
    </div>
  );
}

/** Status flag — glyph + word, so the reading never depends on colour alone. */
export function Flag({
  tone,
  glyph,
  label,
}: {
  tone: "live" | "alarm" | "amber" | "muted";
  glyph: string;
  label: string;
}) {
  const cls = { live: styles.flagLive, alarm: styles.flagAlarm, amber: styles.flagAmber, muted: styles.flagMuted }[tone];
  return (
    <span className={`${styles.flag} ${cls}`}>
      <span aria-hidden>{glyph}</span>
      {label}
    </span>
  );
}

const VERDICT: Record<Verdict, { tone: "live" | "alarm" | "amber" | "muted"; glyph: string; label: string }> = {
  ahead: { tone: "live", glyph: "▲", label: "Ahead" },
  "on-track": { tone: "live", glyph: "●", label: "On track" },
  behind: { tone: "alarm", glyph: "▼", label: "Behind" },
  unknown: { tone: "muted", glyph: "○", label: "No reading" },
};

export function VerdictFlag({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return <Flag tone={v.tone} glyph={v.glyph} label={v.label} />;
}

export { styles as dashStyles, clampPct };
