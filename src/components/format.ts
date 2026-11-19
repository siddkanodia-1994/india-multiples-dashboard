// Display helpers: Indian digit grouping, multiples, dates as 18-Nov-26.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const inr = (v: number | null | undefined, dp = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? "n.m." : `₹${v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const crore = (v: number | null | undefined) => (v === null || v === undefined ? "n.m." : `${inr(v)} cr`);

export const mult = (v: number | null | undefined, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n.m." : `${v.toFixed(dp)}x`);

export const zText = (z: number | null | undefined) => (z === null || z === undefined ? "n.m." : `${z > 0 ? "+" : ""}${z.toFixed(2)}`);

export const pctText = (p: number | null | undefined) => (p === null || p === undefined ? "n.m." : `${Math.round(p)}%`);

/** 2026-11-18 → 18-Nov-26 */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

/** Chart x value: UTC midnight of the ISO day. */
export const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

export function tickMonth(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`;
}

/** Today in India (YYYY-MM-DD). */
export function todayIst(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
