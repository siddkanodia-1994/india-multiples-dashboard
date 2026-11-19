// Matching Ace's company names to NSE / DHAN names. Pure.

/** "The Anup Engineering Ltd." → "anup engineering"; "ELECON ENG. CO. LTD" → "elecon eng co". */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,()'"/-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "ltd", "limited", "pvt", "private"].includes(w))
    .join(" ");
}

const words = (s: string) => new Set(normalizeName(s).split(" ").filter(Boolean));

/** Word overlap (Jaccard) of two names after normalising, 0–1. */
export function nameSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const tokens = (s: string) => normalizeName(s).split(" ").filter(Boolean);

/** An abbreviation of a word: same first letter, letters in order ("mngt" → management, "techno" → technologies). */
const abbreviates = (t: string, w: string) => {
  if (t === w) return true;
  if (t.length < 2 || t[0] !== w[0] || t.length > w.length) return false;
  let i = 0;
  for (const ch of w) if (ch === t[i]) i++;
  return i === t.length;
};

/**
 * How well a DHAN / NSE name (often abbreviated: "TATA POWER CO LTD",
 * "NIPPON L I A M LTD", "HDFC AMC", "CAMS") fits an Ace name, 0–1. A DHAN
 * word may match an Ace word exactly, as an abbreviation, as a single
 * initial, or as the initials of several Ace words in a row.
 */
export function matchScore(ace: string, dhan: string): number {
  const a = tokens(ace);
  const d = tokens(dhan);
  if (!a.length || !d.length) return 0;
  const used = new Array<boolean>(a.length).fill(false);
  let matchedD = 0;
  for (const t of d) {
    let hit = a.findIndex((w, i) => !used[i] && w === t);
    if (hit < 0) hit = a.findIndex((w, i) => !used[i] && (t.length === 1 ? w[0] === t : abbreviates(t, w)));
    if (hit >= 0) {
      used[hit] = true;
      matchedD++;
      continue;
    }
    // Initials of consecutive Ace words: "amc" → asset management company, "cams" → computer age management services.
    if (t.length >= 2 && t.length <= 5) {
      for (let i = 0; i + t.length <= a.length; i++) {
        const run = a.slice(i, i + t.length);
        if (run.every((w, j) => !used[i + j] && w[0] === t[j])) {
          run.forEach((_, j) => (used[i + j] = true));
          matchedD++;
          break;
        }
      }
    }
  }
  const matchedA = used.filter(Boolean).length;
  return (matchedA + matchedD) / (a.length + d.length);
}

/** Splits one CSV line, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface Nifty500Row {
  name: string;
  industry: string | null;
  symbol: string;
  isin: string;
}

/**
 * NSE's Nifty 500 constituents file (Company Name, Industry, Symbol, Series,
 * ISIN Code), as rows from SheetJS. Columns are found by header name.
 */
export function parseNifty500(sheetRows: unknown[][]): { rows: Nifty500Row[]; errors: string[] } {
  const norm = (c: unknown) => (typeof c === "string" ? c.trim().toLowerCase() : "");
  const headerIdx = sheetRows.findIndex((r) => r?.some((c) => norm(c) === "symbol") && r?.some((c) => norm(c).startsWith("isin")));
  if (headerIdx < 0) return { rows: [], errors: ["Header row not found: expected Symbol and ISIN Code columns."] };
  const h = sheetRows[headerIdx].map(norm);
  const col = { name: h.findIndex((c) => c === "company name"), industry: h.indexOf("industry"), symbol: h.indexOf("symbol"), isin: h.findIndex((c) => c.startsWith("isin")) };
  if (col.name < 0) return { rows: [], errors: ["Missing column: Company Name."] };
  const rows: Nifty500Row[] = [];
  const errors: string[] = [];
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const r = sheetRows[i] ?? [];
    const isin = String(r[col.isin] ?? "").trim().toUpperCase();
    const symbol = String(r[col.symbol] ?? "").trim().toUpperCase();
    if (!isin && !symbol) continue;
    if (!/^IN[A-Z0-9]{10}$/.test(isin)) {
      if (errors.length < 20) errors.push(`Row ${i + 1}: bad ISIN "${isin}".`);
      continue;
    }
    rows.push({ name: String(r[col.name] ?? "").trim(), industry: col.industry >= 0 ? String(r[col.industry] ?? "").trim() || null : null, symbol, isin });
  }
  if (!rows.length && !errors.length) errors.push("No rows found.");
  return { rows, errors };
}

/** Lenders, for whom EV/EBITDA starts switched off. NSE's broad industry for them is "Financial Services". */
export const isLenderIndustry = (industry: string | null) => (industry ?? "").trim().toLowerCase() === "financial services";
