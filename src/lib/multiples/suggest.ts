import type { AceDay, Close } from "./types";

// Possible corporate actions to flag for one-click review (BUILD-PROMPT §3.4).
// Nothing here applies an action; the caller stores these as open suggestions
// that a user confirms (with an editable form) or dismisses. Pure.

export interface Suggestion {
  date: string;
  kind: "price_drop" | "ace_shares_jump";
  detail: Record<string, number | string>;
}

/** Overnight price ratios a split or bonus leaves behind: ½, ⅓, ¼, ⅕, 1/10. */
const COMMON_RATIOS = [2, 3, 4, 5, 10];
const PRICE_TOLERANCE = 0.03;

/**
 * (a) A DHAN close that drops overnight to within ±3% of 1/2, 1/3, 1/4, 1/5
 * or 1/10 of the previous close, after the last Ace day.
 */
export function priceDropSuggestions(closes: Close[], lastAceDate: string | null): Suggestion[] {
  const out: Suggestion[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if ((lastAceDate && cur.date <= lastAceDate) || prev.price <= 0 || cur.price <= 0) continue;
    const ratio = cur.price / prev.price;
    const d = COMMON_RATIOS.find((n) => Math.abs(ratio * n - 1) <= PRICE_TOLERANCE);
    if (d) out.push({ date: cur.date, kind: "price_drop", detail: { prevClose: prev.price, close: cur.price, ratio: `1/${d}`, factor: d } });
  }
  return out;
}

/** Share changes Ace's 1-dp close and Mcap can't resolve, or that are just ESOP allotments, aren't flagged. */
const MIN_SHARE_JUMP = 0.01;

/**
 * (b) Ace's implied share count (Mcap ÷ close) jumping more than 1% day-on-day.
 * The bar rises with the rounding a 1-dp close and Mcap can cause on their own,
 * so a ₹5 stock's 0.05 rounding (±1%) doesn't trip it.
 */
export function aceShareJumps(ace: AceDay[]): Suggestion[] {
  const usable = ace.filter((d) => d.close !== null && d.close > 0 && d.mcap !== null && d.mcap > 0);
  const out: Suggestion[] = [];
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1];
    const b = usable[i];
    const sa = a.mcap! / a.close!;
    const sb = b.mcap! / b.close!;
    const rounding = 0.05 / a.close! + 0.05 / b.close! + 0.05 / a.mcap! + 0.05 / b.mcap!;
    const change = sb / sa - 1;
    if (Math.abs(change) > Math.max(MIN_SHARE_JUMP, rounding)) {
      out.push({ date: b.date, kind: "ace_shares_jump", detail: { sharesBefore: sa, sharesAfter: sb, changePct: change * 100 } });
    }
  }
  return out;
}
