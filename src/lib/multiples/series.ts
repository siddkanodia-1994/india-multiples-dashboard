import { heldAt, netDebtAt, type Held } from "./actions";
import { computeAnchor, computeEbitda } from "./anchor";
import { METRICS, type AceDay, type Anchor, type Basis, type Close, type CorporateAction, type Metric, type MultiplePoint, type NetDebtEntry } from "./types";

// One stock's daily multiples for one basis (BUILD-PROMPT §3.5–3.10): Ace's
// own values up to the last Ace day, then "derived" days re-priced on the held
// totals (moved by corporate actions), then today's "live" point. Mcap is
// price × shares, so PE here is on a market-cap (diluted) basis. Pure.

export interface StockInput {
  /** Ace days for this basis, ascending. */
  ace: AceDay[];
  /** DHAN closes, ascending. Only days after the last Ace day are used. */
  closes: Close[];
  actions: CorporateAction[];
  /** The latest hand-entered net debt for this basis, or null. */
  netDebt: NetDebtEntry | null;
  /** The stock's "EV/EBITDA meaningful" switch (off for lenders). */
  evMeaningful: boolean;
  live?: Close | null;
}

export interface StockSeries {
  points: MultiplePoint[];
  anchor: Anchor | null;
  /** TTM EBITDA (₹ crore) held from the anchor days; null without net debt or a usable EV/EBITDA. */
  ebitda: number | null;
  /** Ace's last date, where the dotted Ace → derived marker goes. */
  lastAceDate: string | null;
  /** Held totals and net debt on a date, for implied prices. */
  totalsOn: (date: string) => Totals | null;
}

export interface Totals extends Held {
  netDebt: number | null;
  ebitda: number | null;
}

const pos = (v: number | null) => (v !== null && Number.isFinite(v) && v > 0 ? v : null);

/** Multiples at a price from the totals held on that day. A non-positive ratio is n.m. */
export function multiplesFrom(price: number, t: Totals, evMeaningful: boolean): Record<Metric, number | null> {
  const mcap = price * t.shares;
  return {
    pe: t.pat !== null && t.pat > 0 ? mcap / t.pat : null,
    pbv: t.bookValue !== null && t.bookValue > 0 ? mcap / t.bookValue : null,
    mcapSales: t.sales !== null && t.sales > 0 ? mcap / t.sales : null,
    evEbitda: evMeaningful && t.ebitda !== null && t.netDebt !== null ? pos((mcap + t.netDebt) / t.ebitda) : null,
  };
}

function acePoint(d: AceDay, evMeaningful: boolean): MultiplePoint {
  return { date: d.date, pe: pos(d.pe), pbv: pos(d.pbv), mcapSales: pos(d.mcapSales), evEbitda: evMeaningful ? pos(d.evEbitda) : null, source: "ace" };
}

/** Adds (or replaces) today's point at the live price, unless Ace already covers that day. */
export function withLivePoint(points: MultiplePoint[], live: Close | null | undefined, priceAt: (c: Close) => Record<Metric, number | null> | null): MultiplePoint[] {
  const last = points.at(-1);
  if (!live || !last || live.date < last.date || (last.date === live.date && last.source === "ace")) return points;
  const m = priceAt(live);
  if (!m) return points;
  const point: MultiplePoint = { date: live.date, ...m, source: "live" };
  return last.date === live.date ? [...points.slice(0, -1), point] : [...points, point];
}

export function buildSeries(input: StockInput): StockSeries {
  const { ace, closes, actions, netDebt, evMeaningful, live } = input;
  const anchor = computeAnchor(ace, actions);
  const netDebtOn = (date: string) => (netDebt ? netDebtAt(netDebt, actions, date) : null);
  const ebitda = anchor && netDebt ? computeEbitda(ace, anchor, (d) => netDebtOn(d)!) : null;
  const totalsOn = (date: string): Totals | null => (anchor ? { ...heldAt(anchor, actions, date), netDebt: netDebtOn(date), ebitda } : null);
  const priceAt = (c: Close) => {
    const t = totalsOn(c.date);
    return t ? multiplesFrom(c.price, t, evMeaningful) : null;
  };

  const acePoints = ace.map((d) => acePoint(d, evMeaningful)).filter((p) => METRICS.some((m) => p[m] !== null));
  const lastAceDate = ace.at(-1)?.date ?? null;
  const derived: MultiplePoint[] = anchor
    ? closes.filter((c) => c.date > anchor.date && c.price > 0).map((c) => ({ date: c.date, ...priceAt(c)!, source: "derived" as const }))
    : [];
  return { points: withLivePoint([...acePoints, ...derived], live, priceAt), anchor, ebitda, lastAceDate, totalsOn };
}

/**
 * The basis to show: the one asked for, unless consolidated was asked for and
 * the company has no consolidated figures, in which case standalone with the
 * "S" badge (BUILD-PROMPT §3.12).
 */
export function pickBasis(consolidated: AceDay[], requested: Basis): { basis: Basis; fallback: boolean } {
  if (requested === "S") return { basis: "S", fallback: false };
  const has = consolidated.some((d) => [d.pe, d.pbv, d.mcapSales, d.evEbitda].some((v) => pos(v) !== null));
  return has ? { basis: "C", fallback: false } : { basis: "S", fallback: true };
}
