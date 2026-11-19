// Shared types for the valuation-multiple methodology. Units throughout:
// prices in ₹ per share, company totals (Mcap, PAT, sales, book value,
// EBITDA, net debt, cash) in ₹ crore, share counts in crore.

export const METRICS = ["pe", "pbv", "mcapSales", "evEbitda"] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LABELS: Record<Metric, { short: string; long: string }> = {
  pe: { short: "PE", long: "TTM PE (x)" },
  pbv: { short: "P/BV", long: "Price / Book (x)" },
  mcapSales: { short: "Mcap/Sales", long: "Mcap / Sales (x)" },
  evEbitda: { short: "EV/EBITDA", long: "EV / EBITDA (x)" },
};

/** "C" consolidated, "S" standalone. */
export type Basis = "C" | "S";

/** One Ace Equity day for one stock and basis. Close and Mcap are shared by both bases. */
export interface AceDay {
  date: string;
  close: number | null;
  mcap: number | null;
  pe: number | null;
  pbv: number | null;
  mcapSales: number | null;
  evEbitda: number | null;
}

export type PointSource = "ace" | "derived" | "live";

/** One day of multiples on the chart. A null metric is "n.m." and stays out of the line and the bands. */
export type MultiplePoint = Record<Metric, number | null> & { date: string; source: PointSource };

export interface Close {
  date: string;
  price: number;
}

/**
 * Company totals held from the last Ace days (BUILD-PROMPT §3.2), before any
 * corporate action after `date`. A figure whose multiple was missing, zero or
 * negative on every anchor day is null.
 */
export interface Anchor {
  /** Last Ace date. */
  date: string;
  /** First day of the anchor window (the quarter-end, or the last action inside the quarter). */
  from: string;
  /** Ace days the medians were taken over. */
  days: string[];
  shares: number;
  pat: number | null;
  bookValue: number | null;
  sales: number | null;
}

export type CorporateAction =
  | { id?: number; date: string; type: "raise"; newShares: number; price: number }
  | { id?: number; date: string; type: "buyback"; shares: number; price: number }
  | { id?: number; date: string; type: "bonus"; ratioA: number; ratioB: number }
  | { id?: number; date: string; type: "split"; fvOld: number; fvNew: number }
  | { id?: number; date: string; type: "other"; sharesAfter: number; cash?: number };

/** Hand-entered net debt for one stock and basis (DECISIONS.md): debt − cash + minority interest, as of a date. */
export interface NetDebtEntry {
  asOf: string;
  debt: number;
  cash: number;
  minority?: number;
}
