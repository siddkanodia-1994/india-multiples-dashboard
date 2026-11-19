"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bandValue, niceYAxis, type Bands } from "@/lib/multiples/bands";
import type { PointSource } from "@/lib/multiples/types";
import { dayLabel, dayMs, inr, mult, tickMonth, zText } from "./format";

// One full-width band chart with its ladder (BUILD-PROMPT §7, §9): the
// multiple, mean and ±1/±2 SD lines in the fixed colours, the dotted
// Ace → derived marker, purple action markers and a LIVE tag.

export const COLORS = { series: "#1F2A5C", mean: "#4B5563", p1: "#E07B26", p2: "#B22222", m1: "#7CAD5B", m2: "#2F4F2F", aceEnd: "#9CA3AF", grid: "#EEF0F3", action: "#7C3AED" };
export const BAND_LINES = [
  { k: 0, label: "Mean", color: COLORS.mean, dashed: false },
  { k: 1, label: "+1 SD", color: COLORS.p1, dashed: true },
  { k: 2, label: "+2 SD", color: COLORS.p2, dashed: true },
  { k: -1, label: "−1 SD", color: COLORS.m1, dashed: true },
  { k: -2, label: "−2 SD", color: COLORS.m2, dashed: true },
] as const;
const LADDER = [2, 1, 0, -1, -2] as const;
const LADDER_LABEL: Record<number, string> = { 2: "+2 SD", 1: "+1 SD", 0: "Mean", [-1]: "−1 SD", [-2]: "−2 SD" };

export interface ChartRow {
  date: string;
  value: number;
  source: PointSource;
}

export interface Marker {
  date: string;
  label: string;
}

export function BandChart({
  rows,
  bands,
  priceAt,
  lastAceDate,
  markers,
}: {
  rows: ChartRow[];
  bands: Bands;
  /** Implied share price at a multiple, or null when n.m. */
  priceAt: (multiple: number) => number | null;
  lastAceDate: string | null;
  markers: Marker[];
}) {
  const y = useMemo(() => niceYAxis(rows.map((r) => r.value), bands), [rows, bands]);
  const data = useMemo(() => rows.map((r) => ({ t: dayMs(r.date), v: r.value, date: r.date, source: r.source })), [rows]);
  const first = rows[0].date;
  const lastRow = rows[rows.length - 1];
  const showAceEnd = lastAceDate && rows.some((r) => r.source !== "ace") && lastAceDate >= first;
  const inRange = markers.filter((m) => m.date >= first && m.date <= lastRow.date);

  return (
    <div className="chartwrap">
      <div style={{ minWidth: 0 }}>
        <div style={{ height: 300 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 14, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke={COLORS.grid} />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={tickMonth} tick={{ fontSize: 11, fill: "#686b72" }} minTickGap={36} />
              <YAxis domain={[y.min, y.max]} ticks={y.ticks} width={44} tick={{ fontSize: 11, fill: "#686b72" }} tickFormatter={(v: number) => v.toFixed(y.ticks[1] - y.ticks[0] < 1 ? 1 : 0)} />
              <Tooltip
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="tip">
                      <b>{dayLabel(p.date)}</b> · {p.source}
                      <div>{mult(p.v, 2)}</div>
                    </div>
                  );
                }}
              />
              {BAND_LINES.map((b) => (
                <ReferenceLine key={b.k} y={bandValue(bands, b.k)} stroke={b.color} strokeWidth={b.dashed ? 1.6 : 2} strokeDasharray={b.dashed ? "8 6" : undefined} ifOverflow="extendDomain" />
              ))}
              {showAceEnd && (
                <ReferenceLine
                  x={dayMs(lastAceDate)}
                  stroke={COLORS.aceEnd}
                  strokeDasharray="2 3"
                  label={{ value: "Ace ends ┊", position: "insideTopRight", fontSize: 10, fill: "#6b7280" }}
                />
              )}
              {inRange.map((m) => (
                <ReferenceLine key={m.date + m.label} x={dayMs(m.date)} stroke={COLORS.action} strokeDasharray="4 3" label={{ value: m.label, position: "insideTopRight", fontSize: 10, fill: COLORS.action }} />
              ))}
              <Line type="linear" dataKey="v" stroke={COLORS.series} strokeWidth={2.2} dot={false} isAnimationActive={false} />
              {lastRow.source === "live" && <ReferenceDot x={dayMs(lastRow.date)} y={lastRow.value} r={4} fill="#b0101a" stroke="#fff" className="pulse" />}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="legend">
          <span>
            <i style={{ borderTopColor: COLORS.series, borderTopWidth: 2.2 }} />
            Multiple
          </span>
          {BAND_LINES.map((b) => (
            <span key={b.k}>
              <i style={{ borderTopColor: b.color, borderTopStyle: b.dashed ? "dashed" : "solid" }} />
              {b.label}
            </span>
          ))}
        </div>
      </div>
      <table className="ladder">
        <thead>
          <tr>
            <th />
            <th style={{ textAlign: "right" }}>x</th>
            <th style={{ textAlign: "right" }}>₹</th>
          </tr>
        </thead>
        <tbody>
          {LADDER.map((k) => {
            const v = bandValue(bands, k);
            return (
              <tr key={k} className={k === 0 ? "strong" : undefined}>
                <th>{LADDER_LABEL[k]}</th>
                <td>{mult(v)}</td>
                <td>{inr(priceAt(v))}</td>
              </tr>
            );
          })}
          <tr className="cur">
            <th>Current</th>
            <td>{mult(bands.current)}</td>
            <td>{inr(priceAt(bands.current))}</td>
          </tr>
          <tr>
            <th>SD</th>
            <td>{mult(bands.sd, 2)}</td>
            <td />
          </tr>
          <tr className="strong">
            <th>z</th>
            <td className={bands.z !== null && bands.z > 0 ? "zpos" : "zneg"}>{zText(bands.z)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
