import { edate } from "./dates";
import type { Totals } from "./series";
import type { Metric, MultiplePoint } from "./types";

// Mean and ±1/±2 SD of a multiple over the window shown -- sample SD (n − 1),
// as Excel's STDEV.S -- plus where today sits and the share price each band
// implies on today's totals (BUILD-PROMPT §3.11). Pure.

export type Period = { kind: "months"; months: number } | { kind: "all" } | { kind: "custom"; from: string; to: string };

export interface Bands {
  mean: number;
  sd: number;
  current: number;
  z: number | null;
  /** Share of window days (0–100) when the multiple was at or below today's. */
  percentile: number;
  n: number;
}

/** Window by the toolbar's period, counted back from the series' own last day. */
export function inWindow<T extends { date: string }>(rows: T[], period: Period): T[] {
  if (!rows.length || period.kind === "all") return rows;
  if (period.kind === "custom") return rows.filter((r) => r.date >= period.from && r.date <= period.to);
  const from = edate(rows[rows.length - 1].date, -period.months);
  return rows.filter((r) => r.date >= from);
}

/** The metric's non-n.m. values inside the window, ascending by date. */
export function metricRows(points: MultiplePoint[], metric: Metric, period: Period) {
  const rows = points.flatMap((p) => (p[metric] === null ? [] : [{ date: p.date, value: p[metric]!, source: p.source }]));
  return inWindow(rows, period);
}

export function computeBands(values: number[]): Bands | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const current = values[n - 1];
  const percentile = (values.filter((v) => v <= current).length / n) * 100;
  return { mean, sd, current, z: sd > 0 ? (current - mean) / sd : null, percentile, n };
}

export function bandValue(b: Bands, k: number): number {
  return b.mean + k * b.sd;
}

/**
 * Share price at a band multiple on today's totals: band × TTM PAT (book value,
 * sales) ÷ shares, or (band × EBITDA − net debt) ÷ shares for EV/EBITDA.
 * Null (shown "n.m.") when the band, a total or the result isn't positive.
 */
export function impliedPrice(metric: Metric, band: number, t: Totals | null): number | null {
  if (!t || band <= 0 || t.shares <= 0) return null;
  const total = { pe: t.pat, pbv: t.bookValue, mcapSales: t.sales, evEbitda: t.ebitda }[metric];
  if (total === null || total <= 0) return null;
  const equity = metric === "evEbitda" ? (t.netDebt === null ? null : band * total - t.netDebt) : band * total;
  return equity !== null && equity > 0 ? equity / t.shares : null;
}

/**
 * Y-axis spanning the series and all five band lines, padded 5%, on a
 * "nice" step (1/2/2.5/5 × 10^k). It may go below 0, so a negative −2 SD
 * line (a spiky series) stays visible.
 */
export function niceYAxis(values: number[], b: Bands): { min: number; max: number; ticks: number[] } {
  let lo = Math.min(...values, bandValue(b, -2));
  let hi = Math.max(...values, bandValue(b, 2));
  const pad = hi > lo ? (hi - lo) * 0.05 : 1;
  lo -= pad;
  hi += pad;
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let i = 0; min + i * step <= max + step / 1e6; i++) ticks.push(Number((min + i * step).toFixed(6)));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}
