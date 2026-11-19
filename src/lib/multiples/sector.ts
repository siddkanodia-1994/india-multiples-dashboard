import { median } from "./anchor";
import { firstQuarterEndBetween } from "./dates";
import { METRICS, type MultiplePoint, type PointSource } from "./types";

// The "Sector median" pseudo-company (BUILD-PROMPT §7): for each day and
// metric, the median across the tab's companies that have a value that day.
// The day is "live" if any input is live, else "derived" if any is derived. Pure.

const RANK: Record<PointSource, number> = { ace: 0, derived: 1, live: 2 };

export function sectorMedian(series: MultiplePoint[][]): MultiplePoint[] {
  const byDate = new Map<string, MultiplePoint[]>();
  for (const s of series) for (const p of s) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p]);
  return [...byDate.keys()].sort().map((date) => {
    const ps = byDate.get(date)!;
    const source = ps.reduce<PointSource>((s, p) => (RANK[p.source] > RANK[s] ? p.source : s), "ace");
    const point = { date, source } as MultiplePoint;
    for (const m of METRICS) {
      const xs = ps.flatMap((p) => (p[m] === null ? [] : [p[m]!]));
      point[m] = xs.length ? median(xs) : null;
    }
    return point;
  });
}

/** The amber "results due" note: the first quarter-end passed since the last Ace date, or null. */
export function resultsDue(lastAceDate: string | null, today: string): string | null {
  return lastAceDate ? firstQuarterEndBetween(lastAceDate, today) : null;
}
