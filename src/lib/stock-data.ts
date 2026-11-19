import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "./db/client";
import { aceDaily, aceSnapshots, caSuggestions, closes, corporateActions, netDebt, stocks } from "./db/schema";
import { chooseNetDebt } from "./multiples/netdebt";
import { isMarketOpen, liveQuotes } from "./dhan/live";
import { netDebtOf } from "./multiples/actions";
import { buildSeries, pickBasis } from "./multiples/series";
import { METRICS, type AceDay, type Basis, type CorporateAction, type NetDebtEntry, type PointSource } from "./multiples/types";

// Everything the sector-tab page needs for a set of stocks and one basis:
// each stock's daily multiples (Ace, then derived), its held totals for the
// band prices, and its share/net-debt facts. Points travel as compact rows.

/** [date, pe, pbv, mcapSales, evEbitda, source] — source 0 ace, 1 derived, 2 live. */
export type CompactPoint = [string, number | null, number | null, number | null, number | null, 0 | 1 | 2];
export const SOURCE_CODE: Record<PointSource, 0 | 1 | 2> = { ace: 0, derived: 1, live: 2 };

export interface StockData {
  stockId: number;
  name: string;
  basis: Basis;
  /** True when consolidated was asked for but only standalone exists ("S" badge). */
  fallback: boolean;
  evMeaningful: boolean;
  lastAceDate: string | null;
  points: CompactPoint[];
  /** Held totals on the last point's date, for implied prices (₹ crore, crore shares). */
  totals: { shares: number; pat: number | null; bookValue: number | null; sales: number | null; ebitda: number | null; netDebt: number | null } | null;
  anchor: { date: string; from: string; shares: number; bookValue: number | null } | null;
  /** The latest hand-entered net debt for this basis (an override), if any. */
  netDebt: (NetDebtEntry & { id: number; value: number; createdBy: string }) | null;
  /** The net debt actually driving EV: Ace's Latest EV − Mcap, or the override when it's dated later. */
  netDebtInUse: { source: "ace" | "manual"; value: number; asOf: string; ev?: number; mcap?: number; by?: string } | null;
  actions: (CorporateAction & { createdBy: string; note: string | null })[];
  suggestions: { id: number; date: string; kind: string; detail: Record<string, number | string> }[];
  hasPrices: boolean;
}

export interface TabData {
  stocks: StockData[];
  live: { open: boolean; error: string | null; asOf: string | null };
}

const r6 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);

function toAction(a: typeof corporateActions.$inferSelect): CorporateAction & { createdBy: string; note: string | null } {
  const base = { id: a.id, date: a.date, createdBy: a.createdBy, note: a.note };
  switch (a.type) {
    case "raise":
      return { ...base, type: "raise", newShares: a.newShares!, price: a.price! };
    case "buyback":
      return { ...base, type: "buyback", shares: a.newShares!, price: a.price! };
    case "bonus":
      return { ...base, type: "bonus", ratioA: a.ratioA!, ratioB: a.ratioB! };
    case "split":
      return { ...base, type: "split", fvOld: a.fvOld!, fvNew: a.fvNew! };
    default:
      return { ...base, type: "other", sharesAfter: a.sharesAfter!, cash: a.cash ?? undefined };
  }
}

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * The tab's stocks with today's DHAN quote folded in: during market hours as
 * a "live" point, after hours as today's close until the evening sync stores it.
 */
export async function getTabData(ids: number[], requested: Basis): Promise<TabData> {
  const open = isMarketOpen();
  const sids = await db.select({ id: stocks.id, sid: stocks.dhanSecurityId }).from(stocks).where(inArray(stocks.id, ids.length ? ids : [-1]));
  const withSid = sids.filter((s) => s.sid !== null);
  let error: string | null = null;
  const live = new Map<number, { date: string; price: number }>();
  const extraClose = new Map<number, { date: string; price: number }>();
  if (withSid.length) {
    try {
      const quotes = await liveQuotes(withSid.map((s) => s.sid!));
      const today = todayIst();
      for (const s of withSid) {
        const q = quotes.get(s.sid!);
        if (!q || q.tradeDate !== today) continue;
        (open ? live : extraClose).set(s.id, { date: today, price: q.lastPrice });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { stocks: await getStocksData(ids, requested, live, extraClose), live: { open, error, asOf: new Date().toISOString() } };
}

export async function getStocksData(
  ids: number[],
  requested: Basis,
  live: Map<number, { date: string; price: number }> = new Map(),
  extraClose: Map<number, { date: string; price: number }> = new Map()
): Promise<StockData[]> {
  if (!ids.length) return [];
  const [ss, ace, cl, acts, nds, sugg, snaps] = await Promise.all([
    db.select().from(stocks).where(inArray(stocks.id, ids)),
    db.select().from(aceDaily).where(inArray(aceDaily.stockId, ids)).orderBy(asc(aceDaily.stockId), asc(aceDaily.date)),
    db.select().from(closes).where(and(inArray(closes.stockId, ids), gte(closes.date, "2021-01-01"))).orderBy(asc(closes.stockId), asc(closes.date)),
    db.select().from(corporateActions).where(and(inArray(corporateActions.stockId, ids), isNull(corporateActions.deletedAt))).orderBy(asc(corporateActions.date)),
    db.select().from(netDebt).where(and(inArray(netDebt.stockId, ids), isNull(netDebt.deletedAt))).orderBy(desc(netDebt.asOf), desc(netDebt.id)),
    db.select().from(caSuggestions).where(and(inArray(caSuggestions.stockId, ids), eq(caSuggestions.status, "open"))).orderBy(asc(caSuggestions.date)),
    db.select().from(aceSnapshots).where(inArray(aceSnapshots.stockId, ids)).orderBy(desc(aceSnapshots.asOf)),
  ]);
  return ids.flatMap((id) => {
    const s = ss.find((x) => x.id === id);
    if (!s) return [];
    const rows = ace.filter((r) => r.stockId === id);
    const day = (b: Basis) => (r: (typeof rows)[number]): AceDay => ({
      date: r.date,
      close: r.close,
      mcap: r.mcap,
      pe: b === "C" ? r.cPe : r.sPe,
      pbv: b === "C" ? r.cPbv : r.sPbv,
      mcapSales: b === "C" ? r.cMcapSales : r.sMcapSales,
      evEbitda: b === "C" ? r.cEvEbitda : r.sEvEbitda,
    });
    const { basis, fallback } = pickBasis(rows.map(day("C")), requested);
    const actions = acts.filter((a) => a.stockId === id).map(toAction);
    const nd = nds.find((n) => n.stockId === id && n.basis === basis) ?? null;
    const manual: NetDebtEntry | null = nd ? { asOf: nd.asOf, debt: nd.debt, cash: nd.cash, minority: nd.minority } : null;
    const snap = snaps.find((x) => x.stockId === id && x.basis === basis && x.ev !== null && x.mcap !== null);
    const choice = chooseNetDebt(snap ? { asOf: snap.asOf, ev: snap.ev!, mcap: snap.mcap! } : null, manual);
    const entry = choice?.entry ?? null;
    const myCloses = cl.filter((c) => c.stockId === id).map((c) => ({ date: c.date, price: c.close }));
    const after = extraClose.get(id);
    if (after && !myCloses.some((c) => c.date === after.date)) myCloses.push(after);
    const series = buildSeries({
      ace: rows.map(day(basis)),
      closes: myCloses,
      actions,
      netDebt: entry,
      evMeaningful: s.evMeaningful,
      live: live.get(id) ?? null,
    });
    const lastDate = series.points.at(-1)?.date;
    const t = lastDate ? series.totalsOn(lastDate) : null;
    return [
      {
        stockId: id,
        name: s.name,
        basis,
        fallback,
        evMeaningful: s.evMeaningful,
        lastAceDate: series.lastAceDate,
        points: series.points.map((p) => [p.date, ...METRICS.map((m) => r6(p[m])), SOURCE_CODE[p.source]] as CompactPoint),
        totals: t,
        anchor: series.anchor ? { date: series.anchor.date, from: series.anchor.from, shares: series.anchor.shares, bookValue: series.anchor.bookValue } : null,
        netDebt: nd && manual ? { ...manual, id: nd.id, value: netDebtOf(manual), createdBy: nd.createdBy } : null,
        netDebtInUse: choice
          ? choice.source === "ace"
            ? { source: "ace", value: netDebtOf(choice.entry), asOf: choice.entry.asOf, ev: choice.ace.ev, mcap: choice.ace.mcap }
            : { source: "manual", value: netDebtOf(choice.entry), asOf: choice.entry.asOf, by: nd?.createdBy }
          : null,
        actions,
        suggestions: sugg.filter((x) => x.stockId === id).map((x) => ({ id: x.id, date: x.date, kind: x.kind, detail: x.detail as Record<string, number | string> })),
        hasPrices: s.dhanSecurityId !== null,
      },
    ];
  });
}

export async function stockExists(id: number) {
  const [s] = await db.select({ id: stocks.id }).from(stocks).where(eq(stocks.id, id));
  return Boolean(s);
}
