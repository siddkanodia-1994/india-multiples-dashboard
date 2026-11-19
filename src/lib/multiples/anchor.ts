import { lastQuarterEndOnOrBefore } from "./dates";
import type { AceDay, Anchor, CorporateAction } from "./types";

// The held company totals behind the latest Ace rows (BUILD-PROMPT §3.2).
// Ace's ratios are Mcap ÷ a TTM total that only moves when results come out,
// so back each total out of the last few Ace days and hold the median, which
// cancels most of Ace's 1-dp rounding. Ace's own close is used for the share
// count so a split-adjusted DHAN history can't corrupt it. Pure.

export const ANCHOR_DAYS = 5;

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const positive = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

/**
 * Up to the last 5 Ace days on or after the last quarter-end before the last
 * Ace day. Ace's TTM figures step on the quarter-end, and an action inside the
 * quarter changes the share count, so the window never reaches back past either.
 */
export function anchorWindow(ace: AceDay[], actions: CorporateAction[] = []): { from: string; days: AceDay[] } | null {
  const usable = ace.filter((d) => positive(d.close) && positive(d.mcap));
  const last = usable.at(-1);
  if (!last) return null;
  let from = lastQuarterEndOnOrBefore(last.date);
  for (const a of actions) if (a.date > from && a.date <= last.date) from = a.date;
  return { from, days: usable.filter((d) => d.date >= from).slice(-ANCHOR_DAYS) };
}

/** `ace` ascending, one basis. Null when no Ace day has a usable close and Mcap. */
export function computeAnchor(ace: AceDay[], actions: CorporateAction[] = []): Anchor | null {
  const w = anchorWindow(ace, actions);
  if (!w) return null;
  const total = (m: "pe" | "pbv" | "mcapSales") => {
    const xs = w.days.flatMap((d) => (positive(d[m]) ? [d.mcap! / d[m]] : []));
    return xs.length ? median(xs) : null;
  };
  return {
    date: w.days.at(-1)!.date,
    from: w.from,
    days: w.days.map((d) => d.date),
    shares: median(w.days.map((d) => d.mcap! / d.close!)),
    pat: total("pe"),
    bookValue: total("pbv"),
    sales: total("mcapSales"),
  };
}

/**
 * TTM EBITDA from Ace's EV/EBITDA on the anchor days, once net debt is known
 * (it is entered by hand, DECISIONS.md): (Mcap + net debt) ÷ EV/EBITDA, median.
 * Null when no anchor day has a positive EV/EBITDA, or the result isn't positive.
 */
export function computeEbitda(ace: AceDay[], anchor: Anchor, netDebtOn: (date: string) => number): number | null {
  const days = new Set(anchor.days);
  const xs = ace.flatMap((d) => (days.has(d.date) && positive(d.evEbitda) && positive(d.mcap) ? [(d.mcap + netDebtOn(d.date)) / d.evEbitda] : []));
  const e = xs.length ? median(xs) : null;
  return e !== null && e > 0 ? e : null;
}
