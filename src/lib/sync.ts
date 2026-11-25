import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "./db/client";
import { aceDaily, activityLog, caSuggestions, closes, corporateActions, netDebt, profiles, stocks, syncState, tabStocks, tabs } from "./db/schema";
import { fetchDailyCloses, sleep } from "./dhan/client";
import { getDhanCredentials, type DhanCredentials } from "./dhan/token";
import { edate } from "./multiples/dates";
import { priceDropSuggestions } from "./multiples/suggest";

// DHAN daily closes (BUILD-PROMPT §5, DECISIONS.md): each stock is back-filled
// from 14 days before its last Ace date, and every run re-pulls the last 14
// days so missed sessions fill themselves in. Weekends and holidays simply
// have no DHAN close, so nothing is written for them. Runs are chunked with a
// stored cursor so the next invocation carries on where this one stopped.

const JOB = "closes";
const LOOKBACK_DAYS = 14;
/** DHAN's data APIs allow a few requests a second; stay well under. */
const GAP_MS = 300;
const HISTORY_START = "2021-01-01";

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Where a stock's pull starts. First pull: 14 days before its last Ace day.
 * After that: the last 14 days, or the day after its last saved close when
 * that is older — so closes missed while the DHAN token was missing or
 * expired, for any number of days, come back on the next sync.
 */
export function syncFrom(lastClose: string | null, lastAce: string | null, today: string): string {
  const recent = addDays(today, -LOOKBACK_DAYS);
  const start = lastClose ? (lastClose < recent ? addDays(lastClose, 1) : recent) : lastAce ? addDays(lastAce, -LOOKBACK_DAYS) : recent;
  return start < HISTORY_START ? HISTORY_START : start;
}

/** Pulls one stock's closes and records any split/bonus-looking price drops. Returns the days written. */
export async function syncStockCloses(stockId: number, securityId: number, c: DhanCredentials, today = todayIst()): Promise<number> {
  const [[lastAce], [lastClose]] = await Promise.all([
    db.select({ d: sql<string | null>`max(${aceDaily.date})::text` }).from(aceDaily).where(eq(aceDaily.stockId, stockId)),
    db.select({ d: sql<string | null>`max(${closes.date})::text` }).from(closes).where(eq(closes.stockId, stockId)),
  ]);
  const from = syncFrom(lastClose.d, lastAce.d, today);
  // DHAN serves at most about a year per request.
  const rows: { date: string; close: number }[] = [];
  for (let a = from; a <= today; a = addDays(edate(a, 12), 1)) {
    const b = edate(a, 12) < today ? edate(a, 12) : today;
    rows.push(...(await fetchDailyCloses(securityId, a, b, c)));
    if (b < today) await sleep(GAP_MS);
  }
  const good = rows.filter((r) => r.close > 0 && r.date >= HISTORY_START && r.date <= today);
  for (let i = 0; i < good.length; i += 500) {
    await db
      .insert(closes)
      .values(good.slice(i, i + 500).map((r) => ({ stockId, date: r.date, close: r.close })))
      .onConflictDoUpdate({ target: [closes.stockId, closes.date], set: { close: sql`excluded.close` } });
  }
  if (good.length) {
    const all = await db.select({ date: closes.date, price: closes.close }).from(closes).where(and(eq(closes.stockId, stockId), sql`${closes.date} >= ${addDays(from, -7)}`)).orderBy(asc(closes.date));
    const sugg = priceDropSuggestions(all, lastAce.d);
    if (sugg.length) await db.insert(caSuggestions).values(sugg.map((s) => ({ stockId, date: s.date, kind: s.kind, detail: s.detail }))).onConflictDoNothing();
  }
  return good.length;
}

export interface SyncProgress {
  done: boolean;
  processed: number;
  total: number;
  errors: string[];
}

/**
 * Works through every matched stock until `deadline` (ms epoch), resuming from
 * the stored cursor. A new IST day, or `restart` (Sync now), starts a new pass.
 */
export async function syncCloses(deadline: number, actor = "daily sync", restart = false): Promise<SyncProgress> {
  const c = await getDhanCredentials();
  const today = todayIst();
  const list = await db.select({ id: stocks.id, sid: stocks.dhanSecurityId, name: stocks.name }).from(stocks).where(isNotNull(stocks.dhanSecurityId)).orderBy(asc(stocks.id));
  const [state] = await db.select().from(syncState).where(eq(syncState.job, JOB));
  const cur = (state?.cursor ?? null) as { day: string; next: number; errors: string[] } | null;
  let { next, errors } = cur && cur.day === today && !restart ? cur : { next: 0, errors: [] as string[] };
  const save = (status: string) =>
    db
      .insert(syncState)
      .values({ job: JOB, cursor: { day: today, next, errors }, status, startedAt: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({ target: syncState.job, set: { cursor: { day: today, next, errors }, status, updatedAt: new Date() } });
  let ranAny = false;
  while (next < list.length && Date.now() < deadline) {
    ranAny = true;
    const s = list[next];
    try {
      await syncStockCloses(s.id, s.sid!, c, today);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("DHAN rejected") || msg.startsWith("DHAN token expired")) {
        await save(`failed: ${msg}`);
        throw e;
      }
      errors = [...errors, `${s.name}: ${msg}`].slice(-20);
    }
    next++;
    await save(next < list.length ? "running" : "done");
    await sleep(GAP_MS);
  }
  const done = next >= list.length;
  if (done && ranAny) await db.insert(activityLog).values({ profile: actor, action: "sync", entity: "closes", entityId: today, summary: `Synced DHAN closes for ${list.length} stocks${errors.length ? ` (${errors.length} errors)` : ""}` });
  return { done, processed: next, total: list.length, errors };
}

export async function syncStatus() {
  const [state] = await db.select().from(syncState).where(eq(syncState.job, JOB));
  return state ? { status: state.status, cursor: state.cursor, updatedAt: state.updatedAt?.toISOString() ?? null } : null;
}

const BIN_DAYS = 30;

/** The daily purge of Recently removed (approved product behaviour, BUILD-PROMPT §6). Children first. */
export async function purgeBin(): Promise<number> {
  const cutoff = new Date(Date.now() - BIN_DAYS * 86_400_000);
  const counts = await db.batch([
    db.delete(tabStocks).where(and(isNotNull(tabStocks.deletedAt), lt(tabStocks.deletedAt, cutoff))).returning({ id: tabStocks.tabId }),
    db
      .delete(tabStocks)
      .where(sql`${tabStocks.tabId} in (select id from tabs where deleted_at < ${cutoff})`)
      .returning({ id: tabStocks.tabId }),
    db
      .delete(tabs)
      .where(and(isNotNull(tabs.deletedAt), lt(tabs.deletedAt, cutoff), sql`not exists (select 1 from tab_stocks l where l.tab_id = ${tabs.id})`))
      .returning({ id: tabs.id }),
    db
      .delete(profiles)
      .where(and(isNotNull(profiles.deletedAt), lt(profiles.deletedAt, cutoff), sql`not exists (select 1 from tabs t where t.profile_id = ${profiles.id})`))
      .returning({ id: profiles.id }),
    db.delete(caSuggestions).where(sql`${caSuggestions.actionId} in (select id from corporate_actions where deleted_at < ${cutoff})`).returning({ id: caSuggestions.id }),
    db.delete(corporateActions).where(and(isNotNull(corporateActions.deletedAt), lt(corporateActions.deletedAt, cutoff))).returning({ id: corporateActions.id }),
    db.delete(netDebt).where(and(isNotNull(netDebt.deletedAt), lt(netDebt.deletedAt, cutoff))).returning({ id: netDebt.id }),
  ]);
  const n = counts.reduce((s, r) => s + r.length, 0);
  if (n) await db.insert(activityLog).values({ profile: "daily job", action: "purge", entity: "bin", entityId: "", summary: `Purged ${n} items removed more than ${BIN_DAYS} days ago` });
  return n;
}
