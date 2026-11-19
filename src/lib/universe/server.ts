import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { activityLog, dhanScrips, nifty500, stocks, uploadBatches } from "../db/schema";
import { isLenderIndustry, nameSimilarity, normalizeName, splitCsvLine, type Nifty500Row } from "./match";

// The universe: Ace stocks matched to NSE symbols, ISINs and DHAN security IDs
// (DECISIONS.md). DHAN's public scrip master supplies security IDs; the
// Nifty 500 file supplies industry. A match found by exact name is applied;
// anything else waits for someone to pick it once, and is then remembered.

const SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
/** NSE equity series worth matching (EQ, trade-for-trade BE/BZ, SME SM/ST/SZ). */
const EQUITY_SERIES = new Set(["EQ", "BE", "BZ", "SM", "ST", "SZ"]);

async function log(actor: string, action: string, entity: string, entityId: string, summary: string) {
  await db.insert(activityLog).values({ profile: actor, action, entity, entityId, summary });
}

/** Re-reads DHAN's NSE equity rows (≈3,000) into dhan_scrips. */
export async function refreshDhanScrips(): Promise<number> {
  const res = await fetch(SCRIP_MASTER_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`DHAN scrip master download failed (HTTP ${res.status}).`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  const h = splitCsvLine(lines[0]);
  const c = (name: string) => h.indexOf(name);
  const [ex, seg, id, isin, inst, sym, disp, series] = ["EXCH_ID", "SEGMENT", "SECURITY_ID", "ISIN", "INSTRUMENT", "UNDERLYING_SYMBOL", "DISPLAY_NAME", "SERIES"].map(c);
  if ([ex, seg, id, inst, sym, disp, series].some((i) => i < 0)) throw new Error("DHAN scrip master has unexpected columns.");
  const now = new Date();
  const rows: (typeof dhanScrips.$inferInsert)[] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("NSE,E,")) continue;
    const f = splitCsvLine(line);
    if (f[inst] !== "EQUITY" || !EQUITY_SERIES.has(f[series])) continue;
    const securityId = Number(f[id]);
    if (!Number.isInteger(securityId)) continue;
    rows.push({ securityId, symbol: f[sym], isin: f[isin] && f[isin] !== "NA" ? f[isin] : null, name: f[disp] || null, refreshedAt: now });
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(dhanScrips)
      .values(rows.slice(i, i + 1000))
      .onConflictDoUpdate({
        target: dhanScrips.securityId,
        set: { symbol: sql`excluded.symbol`, isin: sql`excluded.isin`, name: sql`excluded.name`, refreshedAt: sql`excluded.refreshed_at` },
      });
  }
  return rows.length;
}

export async function saveNifty500(rows: Nifty500Row[], fileName: string, actor: string): Promise<{ batchId: number; rows: number; stocksUpdated: number }> {
  const [batch] = await db.insert(uploadBatches).values({ kind: "nifty500", fileName, summary: { rows: rows.length }, createdBy: actor }).returning({ id: uploadBatches.id });
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(nifty500)
      .values(rows.slice(i, i + 500).map((r) => ({ ...r, batchId: batch.id })))
      .onConflictDoUpdate({ target: nifty500.isin, set: { symbol: sql`excluded.symbol`, name: sql`excluded.name`, industry: sql`excluded.industry`, batchId: sql`excluded.batch_id` } });
  }
  // Stocks already matched by ISIN pick up their industry and the Nifty 500 flag.
  const updated = await db.execute(sql`
    update stocks s set industry = n.industry, in_nifty500 = true
    from nifty500 n where n.isin = s.isin and (s.industry is distinct from n.industry or not s.in_nifty500)
    returning s.id`);
  await log(actor, "upload", "nifty500", String(batch.id), `Nifty 500 list ${fileName}: ${rows.length} companies`);
  return { batchId: batch.id, rows: rows.length, stocksUpdated: updated.rows.length };
}

export interface Candidate {
  securityId: number;
  symbol: string;
  isin: string | null;
  name: string | null;
  score: number;
}

/** The best DHAN rows for an Ace name: Nifty 500 name → ISIN first, then DHAN's own names. */
export async function candidatesFor(aceName: string, limit = 5): Promise<Candidate[]> {
  const [scrips, n500] = await Promise.all([db.select().from(dhanScrips), db.select().from(nifty500)]);
  const target = normalizeName(aceName);
  const viaN500 = new Set(n500.filter((n) => normalizeName(n.name) === target).map((n) => n.isin));
  return scrips
    .map((s) => ({
      securityId: s.securityId,
      symbol: s.symbol,
      isin: s.isin,
      name: s.name,
      score: (s.isin && viaN500.has(s.isin)) || normalizeName(s.name ?? "") === target ? 1 : Math.max(nameSimilarity(aceName, s.name ?? ""), nameSimilarity(aceName, s.symbol) * 0.9),
    }))
    .filter((c) => c.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Text search over DHAN's NSE equities, for picking a match by hand. */
export async function searchScrips(q: string): Promise<Candidate[]> {
  const like = `%${q.trim().replace(/[%_]/g, "")}%`;
  if (like.length < 4) return [];
  const rows = await db
    .select()
    .from(dhanScrips)
    .where(sql`${dhanScrips.symbol} ilike ${like} or ${dhanScrips.name} ilike ${like}`)
    .limit(12);
  return rows.map((s) => ({ securityId: s.securityId, symbol: s.symbol, isin: s.isin, name: s.name, score: 0 }));
}

/** Applies a DHAN match to an Ace stock; sets industry and the EV/EBITDA default on first match. */
export async function applyMatch(stockId: number, securityId: number, actor: string): Promise<void> {
  const [s] = await db.select().from(stocks).where(eq(stocks.id, stockId));
  const [scrip] = await db.select().from(dhanScrips).where(eq(dhanScrips.securityId, securityId));
  if (!s || !scrip) throw new Error("Unknown stock or DHAN security.");
  const [taken] = await db.select({ id: stocks.id, name: stocks.name }).from(stocks).where(and(eq(stocks.dhanSecurityId, securityId), sql`${stocks.id} <> ${stockId}`));
  if (taken) throw new Error(`${scrip.symbol} is already matched to ${taken.name}.`);
  const [n] = scrip.isin ? await db.select().from(nifty500).where(eq(nifty500.isin, scrip.isin)) : [];
  const firstMatch = s.dhanSecurityId === null;
  await db
    .update(stocks)
    .set({
      dhanSecurityId: securityId,
      nseSymbol: scrip.symbol,
      isin: scrip.isin,
      industry: n?.industry ?? s.industry,
      inNifty500: Boolean(n),
      ...(firstMatch ? { evMeaningful: !isLenderIndustry(n?.industry ?? null) } : {}),
    })
    .where(eq(stocks.id, stockId));
  await log(actor, "match", "stock", String(stockId), `Matched ${s.name} to NSE ${scrip.symbol} (DHAN ${securityId})`);
}

/** Matches every unmatched Ace stock whose name has exactly one perfect candidate. */
export async function autoMatch(actor: string): Promise<{ matched: string[]; unmatched: { stockId: number; name: string; candidates: Candidate[] }[] }> {
  const open = await db.select().from(stocks).where(isNull(stocks.dhanSecurityId));
  const matched: string[] = [];
  const unmatched: { stockId: number; name: string; candidates: Candidate[] }[] = [];
  for (const s of open) {
    const cands = await candidatesFor(s.aceName);
    const perfect = cands.filter((c) => c.score === 1);
    if (perfect.length === 1) {
      try {
        await applyMatch(s.id, perfect[0].securityId, actor);
        matched.push(`${s.name} → ${perfect[0].symbol}`);
        continue;
      } catch {
        // already taken by another stock: leave it for a person to pick
      }
    }
    unmatched.push({ stockId: s.id, name: s.name, candidates: cands });
  }
  return { matched, unmatched };
}
