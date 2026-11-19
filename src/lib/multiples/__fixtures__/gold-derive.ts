// Test-only copy of the Gold NBFC dashboard's per-share method
// (gold-nbfc-dashboard/src/lib/multiples/derive.ts), kept as the reference the
// parity test checks this app's company-total method against. Not used by the app.

interface GoldPoint {
  date: string;
  pe: number | null;
  pbv: number | null;
  mcapSales: number | null;
}
interface GoldClose {
  date: string;
  price: number;
}
type GoldMetric = "pe" | "pbv" | "mcapSales";
const METRICS: GoldMetric[] = ["pe", "pbv", "mcapSales"];
const QUARTER_ENDS = ["03-31", "06-30", "09-30", "12-31"];

function lastQuarterEndOnOrBefore(date: string): string {
  const y = Number(date.slice(0, 4));
  return [`${y - 1}-12-31`, ...QUARTER_ENDS.map((md) => `${y}-${md}`)].filter((q) => q <= date).at(-1)!;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function goldComputeAnchor(ace: GoldPoint[], closes: GoldClose[]) {
  const last = ace.at(-1);
  if (!last) return null;
  const window = ace.filter((r) => r.date >= lastQuarterEndOnOrBefore(last.date)).slice(-5);
  const closeOnOrBefore = (d: string) => [...closes].reverse().find((c) => c.date <= d)?.price;
  const implied = (m: GoldMetric) => {
    const xs = window.flatMap((r) => {
      const close = closeOnOrBefore(r.date);
      const v = r[m];
      return close && v && v > 0 ? [close / v] : [];
    });
    return xs.length ? median(xs) : null;
  };
  const anchor = { date: last.date, pe: implied("pe"), pbv: implied("pbv"), mcapSales: implied("mcapSales") };
  return METRICS.some((m) => anchor[m] !== null) ? anchor : null;
}

export function goldDerivePoints(anchor: NonNullable<ReturnType<typeof goldComputeAnchor>>, closes: GoldClose[]) {
  return closes
    .filter((c) => c.date > anchor.date && c.price > 0)
    .map((c) => ({
      date: c.date,
      pe: anchor.pe ? c.price / anchor.pe : null,
      pbv: anchor.pbv ? c.price / anchor.pbv : null,
      mcapSales: anchor.mcapSales ? c.price / anchor.mcapSales : null,
    }));
}
