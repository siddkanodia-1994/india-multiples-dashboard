"use client";

import { useState } from "react";
import { METRIC_LABELS, METRICS, type Metric } from "@/lib/multiples/types";
import { dayLabel, inr, mult, pctText, zText } from "./format";

// The compact peer table (DECISIONS.md, option C): per metric current, mean,
// z and percentile, plus PE prices at −1 SD, mean and +1 SD. Sortable; the
// sector-median row stays at the bottom.

export interface PeerStat {
  cur: number;
  mean: number;
  z: number | null;
  pct: number;
}

export interface PeerRow {
  key: string;
  name: string;
  fallback: boolean;
  /** Quarter-end passed since the last Ace date, or null. */
  resultsDue: string | null;
  lastAceDate: string | null;
  stats: Record<Metric, PeerStat | null>;
  /** PE implied prices at −1 SD, mean, +1 SD. */
  pePrices: [number | null, number | null, number | null];
}

type Col = { key: string; label: string; get: (r: PeerRow) => number | null; render: (r: PeerRow) => React.ReactNode; first?: boolean };

const STAT_COLS: { k: keyof PeerStat; label: string; fmt: (v: number | null) => React.ReactNode }[] = [
  { k: "cur", label: "Cur", fmt: (v) => mult(v) },
  { k: "mean", label: "Mean", fmt: (v) => mult(v) },
  { k: "z", label: "z", fmt: (v) => <span className={v !== null && v > 0 ? "zpos" : "zneg"}>{zText(v)}</span> },
  { k: "pct", label: "Pctl", fmt: (v) => pctText(v) },
];

const COLS: Col[] = [
  ...METRICS.flatMap((m) =>
    STAT_COLS.map((c, i) => ({
      key: `${m}.${c.k}`,
      label: c.label,
      first: i === 0,
      get: (r: PeerRow) => r.stats[m]?.[c.k] ?? null,
      render: (r: PeerRow) => (r.stats[m] ? c.fmt(r.stats[m]![c.k]) : <span className="nmv">n.m.</span>),
    }))
  ),
  ...(["@ −1 SD", "@ Mean", "@ +1 SD"] as const).map((label, i) => ({
    key: `price.${i}`,
    label,
    first: i === 0,
    get: (r: PeerRow) => r.pePrices[i],
    render: (r: PeerRow) => inr(r.pePrices[i]),
  })),
];

export function PeerTable({ rows, median }: { rows: PeerRow[]; median: PeerRow | null }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = [...rows];
  if (sort) {
    const col = COLS.find((c) => c.key === sort.key)!;
    sorted.sort((a, b) => {
      const p = col.get(a);
      const q = col.get(b);
      if (p === null) return 1;
      if (q === null) return -1;
      return (p - q) * sort.dir;
    });
  }
  const head = (c: Col) => (
    <th
      key={c.key}
      className={c.first ? "gs" : undefined}
      aria-sort={sort?.key === c.key ? (sort.dir > 0 ? "ascending" : "descending") : undefined}
      onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir > 0 ? -1 : 1 } : { key: c.key, dir: -1 }))}
    >
      {c.label}
      {sort?.key === c.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
    </th>
  );
  const line = (r: PeerRow, med = false) => (
    <tr key={r.key} className={med ? "med" : undefined}>
      <td title={r.name}>
        {r.name.replace(/ (Ltd|Limited)\.?$/i, "")}
        {r.fallback && (
          <span className="badge" title="Standalone figures: this company has no consolidated figures">
            S
          </span>
        )}
        {r.resultsDue && (
          <span className="stale" title={`Results due — derived from ${r.lastAceDate ? dayLabel(r.lastAceDate) : "old"} figures`}>
            {" "}
            ⚠ results due
          </span>
        )}
      </td>
      {COLS.map((c) => (
        <td key={c.key} className={c.first ? "gs" : undefined}>
          {c.render(r)}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="scroll">
      <table className="peer">
        <thead>
          <tr>
            <th rowSpan={2} style={{ cursor: "default" }}>
              Company
            </th>
            {METRICS.map((m) => (
              <th key={m} colSpan={4} className="grp gs">
                {METRIC_LABELS[m].short}
              </th>
            ))}
            <th colSpan={3} className="grp gs">
              Price (PE)
            </th>
          </tr>
          <tr>{COLS.map(head)}</tr>
        </thead>
        <tbody>
          {sorted.map((r) => line(r))}
          {median && line(median, true)}
        </tbody>
      </table>
    </div>
  );
}
