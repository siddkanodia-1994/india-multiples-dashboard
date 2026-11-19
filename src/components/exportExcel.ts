import { bandValue, computeBands, impliedPrice, metricRows, type Period } from "@/lib/multiples/bands";
import { METRICS, type Metric, type MultiplePoint } from "@/lib/multiples/types";
import type { StockData } from "@/lib/stock-data";
import { crore, dayLabel, inr } from "./format";
import type { PeerRow } from "./PeerTable";

// Builds the JSON api/export.py turns into the workbook (BUILD-PROMPT §8):
// the same windowed series, bands and peer table the screen shows.

export interface ExportCompany {
  name: string;
  basisLabel: string;
  actions: string[];
  netDebt: string;
  /** [date, source, pe, pbv, mcapSales, evEbitda] over the period. */
  rows: [string, string, number | null, number | null, number | null, number | null][];
  bands: Record<Metric, { mean: number; sd: number } | null>;
  /** The ladder beside each chart, as on screen: [label, multiple, implied price] rows, then SD and z. */
  ladder: Record<Metric, { rows: [string, number, number | null][]; sd: number; z: number | null } | null>;
  nm?: Partial<Record<Metric, string>>;
}

const LADDER: [string, number][] = [
  ["+2 SD", 2],
  ["+1 SD", 1],
  ["Mean", 0],
  ["−1 SD", -1],
  ["−2 SD", -2],
];

const ACTION_TEXT = (a: StockData["actions"][number]) => {
  switch (a.type) {
    case "raise":
      return `${dayLabel(a.date)} · Equity raise: ${a.newShares.toFixed(4)} cr shares at ${inr(a.price, 2)}`;
    case "buyback":
      return `${dayLabel(a.date)} · Buyback: ${a.shares.toFixed(4)} cr shares at ${inr(a.price, 2)}`;
    case "bonus":
      return `${dayLabel(a.date)} · Bonus ${a.ratioA}:${a.ratioB}`;
    case "split":
      return `${dayLabel(a.date)} · Split: face value ₹${a.fvOld} → ₹${a.fvNew}`;
    case "other":
      return `${dayLabel(a.date)} · Share count set to ${a.sharesAfter.toFixed(4)} cr${a.cash ? `, cash ${crore(a.cash)}` : ""}`;
  }
};

/** One company (or the sector median) over the period: the union of its metrics' days, with each metric's bands. */
export function exportCompany(name: string, basisLabel: string, points: MultiplePoint[], period: Period, s: StockData | null): ExportCompany {
  const byMetric = Object.fromEntries(METRICS.map((m) => [m, metricRows(points, m, period)])) as Record<Metric, ReturnType<typeof metricRows>>;
  const dates = new Set(METRICS.flatMap((m) => byMetric[m].map((r) => r.date)));
  const inRange = points.filter((p) => dates.has(p.date));
  const full = Object.fromEntries(METRICS.map((m) => [m, computeBands(byMetric[m].map((r) => r.value))])) as Record<Metric, ReturnType<typeof computeBands>>;
  const off = (m: Metric) => Boolean(s && !s.evMeaningful && m === "evEbitda");
  const bands = Object.fromEntries(METRICS.map((m) => [m, full[m] && !off(m) ? { mean: full[m]!.mean, sd: full[m]!.sd } : null])) as ExportCompany["bands"];
  // Implied prices use today's held totals, exactly as the screen's ladder (none for the sector median).
  const price = (m: Metric, x: number) => (s ? impliedPrice(m, x, s.totals) : null);
  const ladder = Object.fromEntries(
    METRICS.map((m) => {
      const b = full[m];
      if (!b || off(m)) return [m, null];
      const rows: [string, number, number | null][] = [...LADDER.map(([label, k]) => [label, bandValue(b, k), price(m, bandValue(b, k))] as [string, number, number | null]), ["Current", b.current, price(m, b.current)]];
      return [m, { rows, sd: b.sd, z: b.z }];
    })
  ) as ExportCompany["ladder"];
  const nm: ExportCompany["nm"] = {};
  if (s && !s.evMeaningful) nm.evEbitda = "not meaningful for a lender";
  return {
    name,
    basisLabel,
    actions: s ? s.actions.map(ACTION_TEXT) : [],
    netDebt: s ? (s.netDebt ? `${crore(s.netDebt.value)} — entered by ${s.netDebt.createdBy}, as of ${dayLabel(s.netDebt.asOf)}` : "Not entered — derived EV/EBITDA is n.m.") : "Median of the tab's companies each day",
    rows: inRange.map((p) => [p.date, p.source, ...METRICS.map((m) => (byMetric[m].some((r) => r.date === p.date) ? p[m] : null))] as ExportCompany["rows"][number]),
    bands,
    ladder,
    nm,
  };
}

export function peerExportRows(rows: PeerRow[], median: PeerRow | null) {
  const values = (r: PeerRow) => [...METRICS.flatMap((m) => (r.stats[m] ? [r.stats[m]!.cur, r.stats[m]!.mean, r.stats[m]!.z, r.stats[m]!.pct] : [null, null, null, null])), ...r.pePrices];
  return [
    ...rows.map((r) => ({ name: r.name, fallback: r.fallback, resultsDue: Boolean(r.resultsDue), values: values(r) })),
    ...(median ? [{ name: median.name, median: true, values: values(median) }] : []),
  ];
}

/** Posts the payload and saves the returned workbook. */
export async function downloadWorkbook(payload: unknown, fallbackName: string): Promise<void> {
  const r = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error(j?.error ?? `Export failed (HTTP ${r.status}).`);
  }
  const blob = await r.blob();
  const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

