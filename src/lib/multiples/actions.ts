import type { Anchor, CorporateAction, NetDebtEntry } from "./types";

// Corporate actions move the held totals between Ace files (BUILD-PROMPT §3.3).
// Bonus and split change only the share count, so Mcap and every ratio stay
// continuous across the ex-date; raises and buybacks also move cash, which
// lands in book value and net debt. Pure.

const byDate = (a: CorporateAction, b: CorporateAction) => a.date.localeCompare(b.date);

export function sharesAfter(shares: number, a: CorporateAction): number {
  switch (a.type) {
    case "raise":
      return shares + a.newShares;
    case "buyback":
      return shares - a.shares;
    case "bonus":
      return (shares * (a.ratioA + a.ratioB)) / a.ratioB;
    case "split":
      return (shares * a.fvOld) / a.fvNew;
    case "other":
      return a.sharesAfter;
  }
}

/** Cash into the company (₹ crore): adds to book value, takes off net debt. */
export function cashIn(a: CorporateAction): number {
  switch (a.type) {
    case "raise":
      return a.newShares * a.price;
    case "buyback":
      return -a.shares * a.price;
    case "other":
      return a.cash ?? 0;
    default:
      return 0;
  }
}

export interface Held {
  shares: number;
  pat: number | null;
  bookValue: number | null;
  sales: number | null;
}

/** The anchor's totals moved by every action after the last Ace day, up to and including `date`. */
export function heldAt(anchor: Anchor, actions: CorporateAction[], date: string): Held {
  const held: Held = { shares: anchor.shares, pat: anchor.pat, bookValue: anchor.bookValue, sales: anchor.sales };
  for (const a of [...actions].sort(byDate)) {
    if (a.date <= anchor.date || a.date > date) continue;
    held.shares = sharesAfter(held.shares, a);
    if (held.bookValue !== null) held.bookValue += cashIn(a);
  }
  return held;
}

export function netDebtOf(e: NetDebtEntry): number {
  return e.debt - e.cash + (e.minority ?? 0);
}

/**
 * Net debt on `date`: the hand-entered figure as of its date, moved by the
 * cash of every action between the two dates (forwards after it, unwound
 * before it).
 */
export function netDebtAt(entry: NetDebtEntry, actions: CorporateAction[], date: string): number {
  let nd = netDebtOf(entry);
  for (const a of actions) {
    if (a.date > entry.asOf && a.date <= date) nd -= cashIn(a);
    else if (a.date > date && a.date <= entry.asOf) nd += cashIn(a);
  }
  return nd;
}
