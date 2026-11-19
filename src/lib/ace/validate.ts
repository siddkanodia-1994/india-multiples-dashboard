import type { AceBasisValues, AceRow } from "./parse";

// Server-side re-check of Ace rows the Admin page parsed in the browser.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 20_000;
const M = ["pe", "pbv", "mcapSales", "evEbitda"] as const;

const okNum = (v: unknown, max: number) => v === null || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < max);

export function validateAceRows(input: unknown): { rows: AceRow[]; error: string | null } {
  if (!Array.isArray(input) || input.length === 0) return { rows: [], error: "No rows to upload." };
  if (input.length > MAX_ROWS) return { rows: [], error: `At most ${MAX_ROWS.toLocaleString("en-IN")} rows per request.` };
  const rows: AceRow[] = [];
  const seen = new Set<string>();
  for (const o of input as Record<string, unknown>[]) {
    if (!Number.isInteger(o?.accordCode) || (o.accordCode as number) <= 0) return { rows: [], error: `Bad Accord Code ${String(o?.accordCode)}` };
    if (typeof o.date !== "string" || !DATE_RE.test(o.date) || o.date < "2021-01-01") return { rows: [], error: `Bad date ${String(o.date)} (history starts 1 Jan 2021)` };
    const key = `${o.accordCode}|${o.date}`;
    if (seen.has(key)) return { rows: [], error: `Duplicate ${key}` };
    seen.add(key);
    if (!okNum(o.close, 1e7) || !okNum(o.mcap, 1e8)) return { rows: [], error: `Bad close or Mcap on ${o.date}` };
    const basis = {} as Record<"C" | "S", AceBasisValues>;
    for (const b of ["C", "S"] as const) {
      const v = (o[b] ?? {}) as Record<string, unknown>;
      basis[b] = {} as AceBasisValues;
      for (const m of M) {
        if (!okNum(v[m] ?? null, 1e6)) return { rows: [], error: `Bad ${b} ${m} on ${o.date}` };
        basis[b][m] = (v[m] as number | null | undefined) ?? null;
      }
    }
    rows.push({ accordCode: o.accordCode as number, name: String(o.name ?? "").slice(0, 200), date: o.date, close: o.close as number | null, mcap: o.mcap as number | null, ...basis });
  }
  return { rows, error: null };
}
