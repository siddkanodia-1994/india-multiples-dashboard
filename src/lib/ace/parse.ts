// Parses the Ace Equity "Query Expression" export: a title row, a header row,
// one row per company per date, then blank rows and a disclaimer footer.
// Columns are found by header name, not position. Consolidated columns are
// "NDP_Consolidated …", standalone ones plain "NDP_…"; close and Mcap are
// shared. A blank or 0.0 multiple (no results yet) is stored as null.
// Daily Mcap comes from NDP_Mcap when the file has it; otherwise it is close ×
// the "Latest No of shares" snapshot. The "SCC_Latest …" (consolidated) and
// "SC_Latest …" (standalone) Market Cap / EV / No of shares columns are one
// snapshot repeated on every row, used for net debt (EV − Mcap). Pure:
// the caller reads the workbook (SheetJS `sheet_to_json(ws, { header: 1, raw: true })`).

export interface AceBasisValues {
  pe: number | null;
  pbv: number | null;
  mcapSales: number | null;
  evEbitda: number | null;
}

/** The "Latest" snapshot for one basis: Mcap and EV in ₹ crore, shares in crore. */
export interface AceLatest {
  mcap: number | null;
  ev: number | null;
  shares: number | null;
}

export interface AceRow {
  accordCode: number;
  name: string;
  date: string;
  close: number | null;
  mcap: number | null;
  C: AceBasisValues;
  S: AceBasisValues;
  /** Present when the file has the SCC_/SC_ Latest columns. */
  latest?: { C: AceLatest; S: AceLatest };
}

const REQUIRED = { accordCode: "accord code", name: "company name", date: "ndp_date", close: "ndp_close" } as const;
const MCAP = "ndp_mcap";
const LATEST_HEADERS: Record<"C" | "S", Record<keyof AceLatest, string>> = {
  C: { mcap: "scc_latest market cap", ev: "scc_latest ev", shares: "scc_latest no of shares" },
  S: { mcap: "sc_latest market cap", ev: "sc_latest ev", shares: "sc_latest no of shares" },
};
const CRORE = 1e7;

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
  /** Where daily Mcap came from. */
  mcapSource: "ndp_mcap" | "latest_shares";
  /** True when the file carries Latest EV, so net debt is set automatically. */
  hasLatestEv: boolean;
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
  const fail = (errors: string[], missing: string[] = []): ParsedAce => ({ rows: [], errors, missing, mcapSource: "ndp_mcap", hasLatestEv: false });
  if (headerIdx < 0) return fail(["Header row not found: expected an 'Accord Code' column."]);
  const header = sheetRows[headerIdx].map(norm);

  const col = Object.fromEntries(Object.entries(REQUIRED).map(([k, h]) => [k, header.indexOf(h)])) as Record<keyof typeof REQUIRED, number>;
  const absent = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => REQUIRED[k as keyof typeof REQUIRED]);
  if (absent.length) return fail([`Missing column(s): ${absent.join(", ")}.`]);
  const mcapCol = header.indexOf(MCAP);
  const latestCol = Object.fromEntries(
    (["C", "S"] as const).map((b) => [b, Object.fromEntries(Object.entries(LATEST_HEADERS[b]).map(([k, h]) => [k, header.indexOf(h)]))])
  ) as Record<"C" | "S", Record<keyof AceLatest, number>>;
  const hasLatest = (["C", "S"] as const).some((b) => Object.values(latestCol[b]).some((i) => i >= 0));
  const sharesCol = latestCol.C.shares >= 0 ? latestCol.C.shares : latestCol.S.shares;
  if (mcapCol < 0 && sharesCol < 0) return fail(["Missing column: NDP_Mcap, or SCC_/SC_Latest No of shares to work out Mcap from the close."]);

  const missing: string[] = [];
  const basisCol = {} as Record<"C" | "S", Record<keyof AceBasisValues, number>>;
  for (const b of ["C", "S"] as const) {
    basisCol[b] = {} as Record<keyof AceBasisValues, number>;
    for (const [m, names] of Object.entries(BASIS_HEADERS[b]) as [keyof AceBasisValues, string[]][]) {
      basisCol[b][m] = names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
      if (basisCol[b][m] < 0) missing.push(`${b === "C" ? "Consolidated" : "Standalone"} ${LABEL[m]}`);
    }
  }
  if (missing.length === 8) return fail(["No PE, P/BV, Mcap/Sales or EV/EBITDA columns found."], missing);

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
    const latest = hasLatest
      ? (Object.fromEntries(
          (["C", "S"] as const).map((b) => {
            const get = (k: keyof AceLatest) => (latestCol[b][k] < 0 ? null : (toNumber(r[latestCol[b][k]]) ?? null));
            const shares = get("shares");
            return [b, { mcap: get("mcap"), ev: get("ev"), shares: shares === null ? null : shares / CRORE }];
          })
        ) as { C: AceLatest; S: AceLatest })
      : undefined;
    const sharesCr = sharesCol < 0 ? null : (toNumber(r[sharesCol]) ?? null);
    const mcap = mcapCol >= 0 ? toNumber(r[mcapCol]) : close && sharesCr ? (close * sharesCr) / CRORE : null;
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
    rows.push({ accordCode: code, name: String(r[col.name] ?? "").trim(), date, close: close || null, mcap: mcap || null, ...values, ...(latest ? { latest } : {}) });
  }
  if (!rows.length && !errors.length) errors.push("No data rows found.");
  rows.sort((a, b) => a.accordCode - b.accordCode || a.date.localeCompare(b.date));
  return { rows, errors, missing, mcapSource: mcapCol >= 0 ? "ndp_mcap" : "latest_shares", hasLatestEv: latestCol.C.ev >= 0 || latestCol.S.ev >= 0 };
}
