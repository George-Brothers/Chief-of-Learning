import { describe, it, expect } from "vitest";
import {
  LISTENING_SOURCES,
  listeningSlotMinutes,
  selectListeningSources,
  renderListeningOptions,
} from "../lib/listening-sources";

describe("LISTENING_SOURCES inventory", () => {
  it("is non-empty and fully specified — a half-filled entry is how invented material gets in", () => {
    expect(LISTENING_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const s of LISTENING_SOURCES) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.where.length).toBeGreaterThan(0);
      expect(s.minutes).toBeGreaterThan(0);
      expect(s.hskMin).toBeLessThanOrEqual(s.hskMax);
      expect(s.note.length).toBeGreaterThan(0);
    }
    expect(new Set(LISTENING_SOURCES.map((s) => s.id)).size).toBe(LISTENING_SOURCES.length);
  });
});

describe("listeningSlotMinutes", () => {
  it("takes about a quarter of the day, clamped to 10–30", () => {
    expect(listeningSlotMinutes(60)).toBe(15);
    expect(listeningSlotMinutes(90)).toBe(23);
    expect(listeningSlotMinutes(120)).toBe(30);
    expect(listeningSlotMinutes(20)).toBe(10);
    expect(listeningSlotMinutes(600)).toBe(30);
  });
});

describe("selectListeningSources", () => {
  const base = { budgetMinutes: 90 };

  it("returns 2–3 real candidates from the inventory", () => {
    const picks = selectListeningSources(base);
    expect(picks.length).toBe(3);
    for (const p of picks) expect(LISTENING_SOURCES).toContain(p);
  });

  it("excludes recently-offered ids", () => {
    const first = selectListeningSources(base).map((s) => s.id);
    const next = selectListeningSources({ ...base, recentIds: first });
    expect(next.some((s) => first.includes(s.id))).toBe(false);
  });

  it("rotates through every source as the seed advances, and wraps", () => {
    // Weak version of this test only compared seeds 0 and 1, which differ by construction. The
    // real property: over one full turn of the pool the lead is a different source every day.
    const pool = LISTENING_SOURCES.length;
    const leads = Array.from({ length: pool }, (_, seed) =>
      selectListeningSources({ ...base, seed })[0].id,
    );
    expect(new Set(leads).size).toBe(pool);
    expect(selectListeningSources({ ...base, seed: pool })[0].id).toBe(leads[0]);
  });

  it("drops items that cannot fit the listening slot", () => {
    // 60-minute tutor day → 15-minute slot, so the 20-minute podcast is out.
    const picks = selectListeningSources({ budgetMinutes: 60 });
    for (const p of picks) expect(p.minutes).toBeLessThanOrEqual(15);
  });

  it("keeps the recency exclusion real on day four, when the recent set covers the inventory", () => {
    // The bug: getRecentListeningSourceIds(3 days) × 3 offers = every id in the inventory, so the
    // old `fresh.length ? fresh : sized` fell back to the UNROTATED pool and re-offered yesterday's
    // sources while still claiming to exclude them.
    const seen: string[][] = [];
    let recentIds: string[] = [];
    for (let day = 1; day <= 4; day++) {
      const ids = selectListeningSources({ ...base, recentIds, seed: day }).map((s) => s.id);
      expect(ids.length).toBe(3);
      seen.push(ids);
      // Mirror the store: newest offers first, de-duped, last three days only.
      recentIds = [...new Set([...ids, ...recentIds])].slice(0, 9);
    }
    expect(new Set(seen.slice(0, 3).flat()).size).toBe(9); // days 1–3 use each source exactly once
    for (const earlier of [seen[1], seen[2]]) {
      expect(seen[3].some((id) => earlier.includes(id))).toBe(false); // day 4 repeats neither
    }
  });

  it("cycles back to the OLDEST offers once everything is recent, never to the raw pool", () => {
    const all = LISTENING_SOURCES.map((s) => s.id); // newest-first: all[0] was offered most recently
    const picks = selectListeningSources({ ...base, recentIds: all, seed: 0 }).map((s) => s.id);
    expect(picks.length).toBe(3);
    expect(new Set(picks)).toEqual(new Set(all.slice(-3)));
  });
});

describe("renderListeningOptions", () => {
  it("names each source with its real band and duration", () => {
    const text = renderListeningOptions(selectListeningSources({ budgetMinutes: 90 }));
    expect(text.split("\n").length).toBe(3);
    expect(text).toMatch(/~\d+ min/);
    for (const line of text.split("\n")) expect(line).toMatch(/HSK \d(–\d)?/);
  });
});
