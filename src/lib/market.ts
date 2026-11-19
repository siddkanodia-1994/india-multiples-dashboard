// NSE cash-market hours, 9:15–15:30 IST, Monday to Friday. Holidays aren't
// tracked (DECISIONS.md): on a holiday DHAN simply has no new price. Pure, so
// both the server and the page can use it.

export function isMarketOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}
