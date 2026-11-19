// Parses the Ace Equity "Query Expression" export: a title row, a header row,
// one row per company per date, then blank rows and a disclaimer footer.
// Columns are found by header name, not position. Consolidated columns are
// "NDP_Consolidated …", standalone ones plain "NDP_…"; close and Mcap are
// shared. A blank or 0.0 multiple (no results yet) is stored as null. Pure:
// the caller reads the workbook (SheetJS `sheet_to_json(ws, { header: 1, raw: true })`).

export interface AceBasisValues {
  pe: number | null;
  pbv: number | null;
  mcapSales: number | null;
  evEbitda: number | null;
}

export interface AceRow {
  accordCode: number;
  name: string;
  date: string;
  close: number | null;
  mcap: number | null;
  C: AceBasisValues;
  S: AceBasisValues;
}

const REQUIRED = { accordCode: "accord code", name: "company name", date: "ndp_date", close: "ndp_close", mcap: "ndp_mcap" } as const;

/** Each multiple's accepted header spellings (Ace writes "EBIDTA"). */
const BASIS_HEADERS: Record<"C" | "S", Record<keyof AceBasisValues, string[]>> = {
  C: {
    pe: ["ndp_consolidated pe"],
    pbv: ["ndp_consolidated price bv"],
    mcapSales: ["ndp_consolidated mcap ns"],
    evEbitda: ["ndp_consolidated ev ebidta", "ndp_consolidated ev ebitda"],
  },
  S: {
    pe: ["ndp_pe"],
    pbv: ["ndp_price_bv"],
    mcapSales: ["ndp_mcap_ns"],
    evEbitda: ["ndp_ev_ebidta", "ndp_ev_ebitda"],
  },
};

export interface ParsedAce {
  rows: AceRow[];
  errors: string[];
  /** Multiples whose column the file lacks, e.g. "Standalone EV/EBITDA". */
  missing: string[];
}

// Excel day serial → YYYY-MM-DD without touching local time (25569 = 1970-01-01).
function serialToIso(serial: number): string {
  return new Date(Math.round(serial - 25569) * 86_400_000).toISOString().slice(0, 10);
}

function toIsoDate(v: unknown): string | null {
  if (typeof v === "number" && v > 0) return serialToIso(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // SheetJS dates are local midnight; read the local calendar day.
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

/** A number, null for blank, or undefined for junk. */
function toNumber(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/,/g, "")))) return Number(v.replace(/,/g, ""));
  return undefined;
}

const LABEL: Record<keyof AceBasisValues, string> = { pe: "PE", pbv: "P/BV", mcapSales: "Mcap/Sales", evEbitda: "EV/EBITDA" };

export function parseAceRows(sheetRows: unknown[][]): ParsedAce {
  const errors: string[] = [];
  const err = (m: string) => errors.length < 20 && errors.push(m);
  const norm = (c: unknown) => (typeof c === "string" ? c.trim().toLowerCase().replace(/\s+/g, " ") : "");
  const headerIdx = sheetRows.findIndex((r) => r?.some((c) => norm(c) === REQUIRED.accordCode));
  if (headerIdx < 0) return { rows: [], errors: ["Header row not found: expected an 'Accord Code' column."], missing: [] };
  const header = sheetRows[headerIdx].map(norm);

  const col = Object.fromEntries(Object.entries(REQUIRED).map(([k, h]) => [k, header.indexOf(h)])) as Record<keyof typeof REQUIRED, number>;
  const absent = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => REQUIRED[k as keyof typeof REQUIRED]);
  if (absent.length) return { rows: [], errors: [`Missing column(s): ${absent.join(", ")}.`], missing: [] };

  const missing: string[] = [];
  const basisCol = {} as Record<"C" | "S", Record<keyof AceBasisValues, number>>;
  for (const b of ["C", "S"] as const) {
    basisCol[b] = {} as Record<keyof AceBasisValues, number>;
    for (const [m, names] of Object.entries(BASIS_HEADERS[b]) as [keyof AceBasisValues, string[]][]) {
      basisCol[b][m] = names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
      if (basisCol[b][m] < 0) missing.push(`${b === "C" ? "Consolidated" : "Standalone"} ${LABEL[m]}`);
    }
  }
  if (missing.length === 8) return { rows: [], errors: ["No PE, P/BV, Mcap/Sales or EV/EBITDA columns found."], missing };

  const rows: AceRow[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const r = sheetRows[i] ?? [];
    const code = toNumber(r[col.accordCode]);
    if (typeof code !== "number" || !Number.isInteger(code)) continue; // blank rows and the footer
    const date = toIsoDate(r[col.date]);
    if (!date) {
      err(`Row ${i + 1}: unreadable date.`);
      continue;
    }
    const close = toNumber(r[col.close]);
    const mcap = toNumber(r[col.mcap]);
    if (close === undefined || mcap === undefined) {
      err(`Row ${i + 1}: close or Mcap is not a number.`);
      continue;
    }
    const values = {} as Record<"C" | "S", AceBasisValues>;
    let bad = false;
    for (const b of ["C", "S"] as const) {
      values[b] = {} as AceBasisValues;
      for (const m of Object.keys(LABEL) as (keyof AceBasisValues)[]) {
        const v = basisCol[b][m] < 0 ? null : toNumber(r[basisCol[b][m]]);
        if (v === undefined) bad = true;
        values[b][m] = v === undefined || v === 0 ? null : v;
      }
    }
    if (bad) {
      err(`Row ${i + 1}: a multiple is not a number.`);
      continue;
    }
    const key = `${code}|${date}`;
    if (seen.has(key)) {
      err(`Row ${i + 1}: duplicate date ${date} for Accord Code ${code}.`);
      continue;
    }
    seen.add(key);
    rows.push({ accordCode: code, name: String(r[col.name] ?? "").trim(), date, close: close || null, mcap: mcap || null, ...values });
  }
  if (!rows.length && !errors.length) errors.push("No data rows found.");
  rows.sort((a, b) => a.accordCode - b.accordCode || a.date.localeCompare(b.date));
  return { rows, errors, missing };
}
