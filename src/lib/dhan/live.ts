import { fetchQuotes, type Quote } from "./client";

export { isMarketOpen } from "../market";

// Live prices for the open sector tab (BUILD-PROMPT §5): one batched DHAN
// quote call, cached 30 s per server instance so many open screens share it.

const TTL_MS = 30_000;
const cache = new Map<number, { at: number; quote: Quote }>();

export async function liveQuotes(securityIds: number[]): Promise<Map<number, Quote>> {
  const now = Date.now();
  const stale = securityIds.filter((id) => !(cache.get(id) && now - cache.get(id)!.at < TTL_MS));
  if (stale.length) for (const q of await fetchQuotes(stale)) cache.set(q.securityId, { at: now, quote: q });
  return new Map(securityIds.flatMap((id) => (cache.has(id) ? [[id, cache.get(id)!.quote] as const] : [])));
}
