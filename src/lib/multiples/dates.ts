// Calendar helpers on ISO dates (YYYY-MM-DD), no time zones involved.

const QUARTER_ENDS = ["03-31", "06-30", "09-30", "12-31"];

/** Last quarter-end (31 Mar, 30 Jun, 30 Sep, 31 Dec) on or before `date`. */
export function lastQuarterEndOnOrBefore(date: string): string {
  const y = Number(date.slice(0, 4));
  return [`${y - 1}-12-31`, ...QUARTER_ENDS.map((md) => `${y}-${md}`)].filter((q) => q <= date).at(-1)!;
}

/** First quarter-end q with after < q <= upTo, or null. Drives the "results due" note. */
export function firstQuarterEndBetween(after: string, upTo: string): string | null {
  for (let y = Number(after.slice(0, 4)); y <= Number(upTo.slice(0, 4)); y++) {
    for (const md of QUARTER_ENDS) {
      const q = `${y}-${md}`;
      if (q > after && q <= upTo) return q;
    }
  }
  return null;
}

/** `date` moved by whole months, clamped to the month's last day (Excel EDATE). */
export function edate(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
