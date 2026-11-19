import { getDhanCredentials, tokenClaims, type DhanCredentials } from "./token";

// DHAN market-data endpoints only (quotes and daily history). This app never
// calls order, portfolio or funds endpoints.

const QUOTE_URL = "https://api.dhan.co/v2/marketfeed/quote";
const HISTORICAL_URL = "https://api.dhan.co/v2/charts/historical";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** DHAN takes up to 1,000 instruments per quote request. */
const QUOTE_BATCH = 1000;

function headers(c: DhanCredentials): HeadersInit {
  return { "access-token": c.token, "client-id": c.clientId, "Content-Type": "application/json", Accept: "application/json" };
}

function istStamp(d: Date): string {
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST";
}

/** Fails fast, with the time, when the token's own expiry has passed — no point asking DHAN. */
function assertNotExpired(c: DhanCredentials): void {
  const { expiresAt } = tokenClaims(c.token);
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new Error(`DHAN token expired ${istStamp(expiresAt)} — paste a new one on the Admin page.`);
}

// DHAN's 401/403 bodies look like {"data":{"808":"Authentication Failed - Client ID or Token invalid"},"status":"failed"}
// or {"errorCode":"DH-901","errorMessage":"..."}; their text is passed through.
function rejection(body: string): Error {
  let reason = "";
  try {
    const json = JSON.parse(body) as { data?: Record<string, unknown>; errorCode?: string; errorMessage?: string };
    if (json.errorCode || json.errorMessage) reason = [json.errorCode, json.errorMessage].filter(Boolean).join(": ");
    else if (json.data && typeof json.data === "object") reason = Object.entries(json.data).map(([k, v]) => `${k}: ${String(v)}`).join("; ");
  } catch {
    reason = body.slice(0, 200);
  }
  return new Error(`DHAN rejected the client ID / token${reason ? ` (${reason})` : ""} — check both, or paste a fresh token on the Admin page.`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Quote {
  securityId: number;
  lastPrice: number;
  /** Previous session's close. */
  prevClose: number | null;
  /** IST calendar date of the last trade, when DHAN reports one. */
  tradeDate: string | null;
}

interface QuoteEntry {
  last_price?: number;
  last_trade_time?: string;
  ohlc?: { close?: number };
}

// DHAN has sent last_trade_time both as "YYYY-MM-DD HH:mm:ss" and
// "DD/MM/YYYY HH:mm:ss"; anything else is treated as unknown.
function tradeDateOf(text: string | undefined): string | null {
  if (!text) return null;
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] === "1980" ? null : `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return m[3] === "1980" ? null : `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/** Full quotes (LTP, previous close, last trade date) for NSE equities, batched. */
export async function fetchQuotes(securityIds: number[], credentials?: DhanCredentials): Promise<Quote[]> {
  if (!securityIds.length) return [];
  const c = credentials ?? (await getDhanCredentials());
  assertNotExpired(c);
  const quotes: Quote[] = [];
  for (let i = 0; i < securityIds.length; i += QUOTE_BATCH) {
    if (i) await sleep(1100); // quote API: 1 request a second
    const ids = securityIds.slice(i, i + QUOTE_BATCH);
    const res = await fetch(QUOTE_URL, { method: "POST", headers: headers(c), body: JSON.stringify({ NSE_EQ: ids }), cache: "no-store" });
    if (res.status === 401 || res.status === 403) throw rejection(await res.text().catch(() => ""));
    if (!res.ok) throw new Error(`DHAN quote request failed (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = (await res.json()) as { status?: string; data?: { NSE_EQ?: Record<string, QuoteEntry> } };
    if (json.status !== "success") throw new Error(`DHAN quote request returned status "${json.status}"`);
    for (const id of ids) {
      const e = json.data?.NSE_EQ?.[String(id)];
      if (!e || typeof e.last_price !== "number" || !(e.last_price > 0)) continue;
      quotes.push({
        securityId: id,
        lastPrice: e.last_price,
        prevClose: typeof e.ohlc?.close === "number" && e.ohlc.close > 0 ? e.ohlc.close : null,
        tradeDate: tradeDateOf(e.last_trade_time),
      });
    }
  }
  return quotes;
}

export interface HistoricalClose {
  date: string;
  close: number;
}

/** Daily closes for one NSE equity over [from, to] (both inclusive). Retries transient failures. */
export async function fetchDailyCloses(securityId: number, from: string, to: string, credentials?: DhanCredentials): Promise<HistoricalClose[]> {
  const c = credentials ?? (await getDhanCredentials());
  assertNotExpired(c);
  const toExclusive = new Date(`${to}T00:00:00Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  let detail = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(HISTORICAL_URL, {
        method: "POST",
        headers: headers(c),
        body: JSON.stringify({
          securityId: String(securityId),
          exchangeSegment: "NSE_EQ",
          instrument: "EQUITY",
          expiryCode: 0,
          oi: false,
          fromDate: from,
          toDate: toExclusive.toISOString().slice(0, 10),
        }),
        cache: "no-store",
      });
      const body = await res.text();
      // DH-905: DHAN has no data for this range (e.g. only holidays).
      if (!res.ok && body.includes("DH-905")) return [];
      if (res.status === 401 || res.status === 403) throw rejection(body);
      if (res.status === 429) {
        detail = "rate limited";
        await sleep(2000 * attempt);
        continue;
      }
      if (!res.ok) {
        detail = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      } else {
        const json = JSON.parse(body) as { close?: number[]; timestamp?: number[] };
        if (json.close && json.timestamp && json.close.length === json.timestamp.length) {
          return json.timestamp.map((ts, i) => ({ date: new Date(ts * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10), close: json.close![i] }));
        }
        detail = "malformed response (close/timestamp arrays missing or mismatched)";
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("DHAN rejected")) throw err;
      detail = err instanceof Error ? err.message : "network error";
    }
    if (attempt < 3) await sleep(1500);
  }
  throw new Error(`DHAN history for security ${securityId} failed: ${detail}`);
}

/**
 * Checks a candidate pair before it is saved: the token's own client ID must
 * match the typed one, and one quote call must succeed (DHAN's error text is
 * passed through). Reliance (NSE_EQ 2885) is the test instrument.
 */
export async function testDhanCredentials(c: DhanCredentials): Promise<{ ok: true } | { ok: false; message: string }> {
  const claims = tokenClaims(c.token);
  if (claims.clientId && claims.clientId !== c.clientId) return { ok: false, message: `This token was issued to client ID …${claims.clientId.slice(-4)}, not …${c.clientId.slice(-4)}.` };
  try {
    const quotes = await fetchQuotes([2885], c);
    return quotes.length > 0 ? { ok: true } : { ok: false, message: "DHAN answered but returned no price — the account may lack Data API access." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "DHAN request failed" };
  }
}
