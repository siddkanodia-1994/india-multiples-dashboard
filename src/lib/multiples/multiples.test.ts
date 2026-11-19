import { describe, expect, it } from "vitest";
import { goldComputeAnchor, goldDerivePoints } from "./__fixtures__/gold-derive";
import { heldAt, netDebtAt } from "./actions";
import { computeAnchor } from "./anchor";
import { bandValue, computeBands, impliedPrice, inWindow, niceYAxis } from "./bands";
import { edate, firstQuarterEndBetween } from "./dates";
import { resultsDue, sectorMedian } from "./sector";
import { buildSeries, pickBasis, type StockInput } from "./series";
import { aceShareJumps, priceDropSuggestions } from "./suggest";
import type { AceDay, CorporateAction, MultiplePoint } from "./types";

// Made-up numbers only: real Ace Equity values are licensed and never committed.

/** An Ace day from price, shares and company totals, with exact (unrounded) ratios. */
function aceDay(date: string, close: number, t: { shares: number; pat: number; bv: number; sales: number; ebitda?: number; nd?: number }): AceDay {
  const mcap = close * t.shares;
  return {
    date,
    close,
    mcap,
    pe: mcap / t.pat,
    pbv: mcap / t.bv,
    mcapSales: mcap / t.sales,
    evEbitda: t.ebitda !== undefined ? (mcap + (t.nd ?? 0)) / t.ebitda : null,
  };
}

const QIP_CO = { shares: 40, pat: 4800, bv: 24000, sales: 16000, ebitda: 9000, nd: 80000 };
const ACE_DATES = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
const base = (over: Partial<StockInput> = {}): StockInput => ({
  ace: ACE_DATES.map((d) => aceDay(d, 2400, QIP_CO)),
  closes: [],
  actions: [],
  netDebt: { asOf: "2026-11-13", debt: 80000, cash: 0 },
  evMeaningful: true,
  ...over,
});
const at = (pts: MultiplePoint[], date: string) => pts.find((p) => p.date === date)!;

describe("anchor", () => {
  it("holds the median company totals over the last 5 Ace days", () => {
    const ace = ACE_DATES.map((d) => aceDay(d, 2400, QIP_CO));
    ace[2] = { ...ace[2], pe: 21 }; // one rounding outlier, cancelled by the median
    const a = computeAnchor(ace)!;
    expect(a.date).toBe("2026-11-13");
    expect(a.shares).toBeCloseTo(40, 9);
    expect(a.pat).toBeCloseTo(4800, 9);
    expect(a.bookValue).toBeCloseTo(24000, 9);
    expect(a.sales).toBeCloseTo(16000, 9);
  });

  it("never reaches back past the quarter-end, nor past an action inside the quarter", () => {
    const old = { ...QIP_CO, pat: 2400 };
    const ace = [aceDay("2026-09-29", 2400, old), aceDay("2026-09-30", 2400, QIP_CO), aceDay("2026-10-01", 2400, QIP_CO)];
    expect(computeAnchor(ace)!.pat).toBeCloseTo(4800, 9);
    const afterRaise = { ...QIP_CO, shares: 44 };
    const ace2 = [aceDay("2026-10-05", 2400, QIP_CO), aceDay("2026-10-06", 2400, QIP_CO), aceDay("2026-10-07", 2400, afterRaise)];
    const a = computeAnchor(ace2, [{ date: "2026-10-07", type: "raise", newShares: 4, price: 2200 }])!;
    expect(a.from).toBe("2026-10-07");
    expect(a.shares).toBeCloseTo(44, 9);
  });

  it("skips a missing, zero or negative multiple, and nulls a figure with none left", () => {
    const ace = ACE_DATES.map((d) => ({ ...aceDay(d, 2400, QIP_CO), pe: -12, pbv: 0 }));
    const a = computeAnchor(ace)!;
    expect(a.pat).toBeNull();
    expect(a.bookValue).toBeNull();
    expect(a.sales).toBeCloseTo(16000, 9);
  });
});

describe("derived and live points", () => {
  it("re-prices closes after the last Ace day on the held totals", () => {
    const s = buildSeries(base({ closes: [{ date: "2026-11-13", price: 1 }, { date: "2026-11-16", price: 2640 }] }));
    expect(s.points.at(-2)!.source).toBe("ace"); // the 13 Nov close is ignored: Ace covers it
    expect(at(s.points, "2026-11-16")).toMatchObject({ source: "derived", pe: 22, pbv: 4.4, mcapSales: 6.6 });
    expect(s.lastAceDate).toBe("2026-11-13");
  });

  it("puts today's live price in place of today's derived point, but never over Ace", () => {
    const s = buildSeries(base({ closes: [{ date: "2026-11-16", price: 2400 }], live: { date: "2026-11-16", price: 1200 } }));
    expect(s.points.at(-1)).toMatchObject({ date: "2026-11-16", source: "live", pe: 10 });
    expect(s.points.filter((p) => p.date === "2026-11-16")).toHaveLength(1);
    const onAceDay = buildSeries(base({ live: { date: "2026-11-13", price: 1200 } }));
    expect(onAceDay.points.at(-1)!.source).toBe("ace");
  });
});

describe("EV/EBITDA", () => {
  it("backs EBITDA out of Ace's ratio and the entered net debt, then re-prices EV", () => {
    const s = buildSeries(base({ closes: [{ date: "2026-11-16", price: 2700 }] }));
    expect(s.ebitda).toBeCloseTo(9000, 6);
    expect(at(s.points, "2026-11-16").evEbitda).toBeCloseTo((2700 * 40 + 80000) / 9000, 9);
  });

  it("is n.m. after the last Ace day until net debt is entered, while Ace's own values still show", () => {
    const s = buildSeries(base({ netDebt: null, closes: [{ date: "2026-11-16", price: 2700 }] }));
    expect(at(s.points, "2026-11-13").evEbitda).toBeCloseTo(176000 / 9000, 9);
    expect(at(s.points, "2026-11-16").evEbitda).toBeNull();
    expect(at(s.points, "2026-11-16").pe).not.toBeNull();
  });

  it("is n.m. everywhere when switched off (lenders)", () => {
    const s = buildSeries(base({ evMeaningful: false, closes: [{ date: "2026-11-16", price: 2700 }] }));
    expect(s.points.every((p) => p.evEbitda === null)).toBe(true);
  });

  it("uses debt − cash + minority from the entry", () => {
    const s = buildSeries(base({ netDebt: { asOf: "2026-11-13", debt: 90000, cash: 12000, minority: 2000 } }));
    expect(s.totalsOn("2026-11-13")!.netDebt).toBe(80000);
  });
});

describe("corporate actions", () => {
  const anchor = computeAnchor(ACE_DATES.map((d) => aceDay(d, 2400, QIP_CO)))!;
  const after = (a: CorporateAction) => heldAt(anchor, [a], "2026-12-31");

  it("equity raise adds shares and cash", () => {
    const h = after({ date: "2026-11-16", type: "raise", newShares: 4, price: 2200 });
    expect(h.shares).toBeCloseTo(44, 9);
    expect(h.bookValue).toBeCloseTo(32800, 6);
    expect(netDebtAt({ asOf: "2026-11-13", debt: 80000, cash: 0 }, [{ date: "2026-11-16", type: "raise", newShares: 4, price: 2200 }], "2026-11-16")).toBeCloseTo(71200, 6);
  });

  it("buyback removes shares and cash", () => {
    const a: CorporateAction = { date: "2026-11-16", type: "buyback", shares: 2, price: 2500 };
    const h = after(a);
    expect(h.shares).toBeCloseTo(38, 9);
    expect(h.bookValue).toBeCloseTo(19000, 6);
    expect(netDebtAt({ asOf: "2026-11-13", debt: 80000, cash: 0 }, [a], "2026-11-20")).toBeCloseTo(85000, 6);
  });

  it("bonus a:b and split F0 → F1 scale shares only", () => {
    expect(after({ date: "2026-11-16", type: "bonus", ratioA: 1, ratioB: 2 }).shares).toBeCloseTo(60, 9);
    expect(after({ date: "2026-11-16", type: "split", fvOld: 10, fvNew: 2 }).shares).toBeCloseTo(200, 9);
    expect(after({ date: "2026-11-16", type: "split", fvOld: 10, fvNew: 2 }).bookValue).toBeCloseTo(24000, 9);
  });

  it("other sets the share count and moves optional cash", () => {
    const h = after({ date: "2026-11-16", type: "other", sharesAfter: 41, cash: 500 });
    expect(h.shares).toBe(41);
    expect(h.bookValue).toBeCloseTo(24500, 6);
  });

  it("applies only to days after the last Ace day, from the action's own date", () => {
    const a: CorporateAction = { date: "2026-11-18", type: "raise", newShares: 4, price: 2200 };
    expect(heldAt(anchor, [a], "2026-11-17").shares).toBeCloseTo(40, 9);
    expect(heldAt(anchor, [a], "2026-11-18").shares).toBeCloseTo(44, 9);
    expect(heldAt(anchor, [{ ...a, date: "2026-11-12" }], "2026-11-20").shares).toBeCloseTo(40, 9); // Ace already has it
  });

  it("net debt entered after an action unwinds it for earlier days", () => {
    const a: CorporateAction = { date: "2026-11-10", type: "raise", newShares: 4, price: 2200 };
    expect(netDebtAt({ asOf: "2026-11-20", debt: 71200, cash: 0 }, [a], "2026-11-09")).toBeCloseTo(80000, 6);
    expect(netDebtAt({ asOf: "2026-11-20", debt: 71200, cash: 0 }, [a], "2026-11-25")).toBeCloseTo(71200, 6);
  });

  it("QIP example: 4 cr shares at ₹2,200 with the price unchanged", () => {
    const s = buildSeries(base({ actions: [{ date: "2026-11-16", type: "raise", newShares: 4, price: 2200 }], closes: [{ date: "2026-11-16", price: 2400 }] }));
    const p = at(s.points, "2026-11-16");
    expect(p.pe!.toFixed(2)).toBe("22.00");
    expect(p.pbv!.toFixed(2)).toBe("3.22");
    expect(p.mcapSales!.toFixed(2)).toBe("6.60");
    expect(p.evEbitda!.toFixed(2)).toBe("19.64");
  });

  it("bonus continuity: a 1:1 bonus with the price halving leaves every ratio unchanged", () => {
    const closes = [{ date: "2026-11-16", price: 2400 }, { date: "2026-11-17", price: 1200 }];
    const s = buildSeries(base({ actions: [{ date: "2026-11-17", type: "bonus", ratioA: 1, ratioB: 1 }], closes }));
    const before = at(s.points, "2026-11-16");
    const afterBonus = at(s.points, "2026-11-17");
    for (const m of ["pe", "pbv", "mcapSales", "evEbitda"] as const) expect(afterBonus[m]).toBeCloseTo(before[m]!, 9);
  });
});

describe("parity with the Gold dashboard's per-share method", () => {
  // Constant 25 cr shares, prices and ratios that wander across a quarter-end.
  const prices = [910, 925, 948, 931, 902, 915, 940, 957];
  const dates = ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-03", "2026-10-06", "2026-10-07"];
  const ratios = [
    [14.1, 2.3, 3.4],
    [14.3, 2.3, 3.5],
    [14.7, 2.4, 3.5],
    [12.2, 2.1, 3.1],
    [11.9, 2.0, 3.0],
    [12.1, 2.1, 3.1],
    [12.4, 2.1, 3.2],
    [12.7, 2.2, 3.2],
  ];
  const ace: AceDay[] = dates.map((date, i) => ({ date, close: prices[i], mcap: prices[i] * 25, pe: ratios[i][0], pbv: ratios[i][1], mcapSales: ratios[i][2], evEbitda: null }));
  const closes = [...dates.map((date, i) => ({ date, price: prices[i] })), { date: "2026-10-08", price: 971.35 }, { date: "2026-10-09", price: 1003.8 }, { date: "2026-10-12", price: 884.15 }];

  it("PE, P/BV and Mcap/Sales match to 6 decimals with no corporate actions", () => {
    const gold = goldDerivePoints(goldComputeAnchor(ace, closes)!, closes);
    const ours = buildSeries({ ace, closes, actions: [], netDebt: null, evMeaningful: true }).points.filter((p) => p.source === "derived");
    expect(ours).toHaveLength(gold.length);
    gold.forEach((g, i) => {
      expect(ours[i].date).toBe(g.date);
      for (const m of ["pe", "pbv", "mcapSales"] as const) expect(ours[i][m]!.toFixed(6)).toBe(g[m]!.toFixed(6));
    });
  });
});

describe("bands", () => {
  it("uses the sample SD, the last value as current, and a percentile", () => {
    const b = computeBands([1, 2, 3, 4, 2.5])!;
    expect(b.mean).toBe(2.5);
    expect(b.sd).toBeCloseTo(Math.sqrt(5 / 4), 12);
    expect(b.z).toBe(0);
    expect(b.percentile).toBe(60);
  });

  it("implies prices from today's totals, and EV/EBITDA net of debt", () => {
    const s = buildSeries(base());
    const t = s.totalsOn("2026-11-13");
    expect(impliedPrice("pe", 20, t)).toBeCloseTo(2400, 6);
    expect(impliedPrice("pbv", 4, t)).toBeCloseTo(2400, 6);
    expect(impliedPrice("evEbitda", 176000 / 9000, t)).toBeCloseTo(2400, 6);
    expect(impliedPrice("evEbitda", 5, t)).toBeNull(); // EV below net debt: no equity value
    expect(impliedPrice("pe", -1, t)).toBeNull();
  });

  it("keeps every band line on the axis, even a negative −2 SD", () => {
    const vals = [5, 6, 60, 7];
    const b = computeBands(vals)!;
    const y = niceYAxis(vals, b);
    expect(y.min).toBeLessThanOrEqual(bandValue(b, -2));
    expect(y.max).toBeGreaterThanOrEqual(bandValue(b, 2));
  });

  it("windows by months back from the series' last day", () => {
    const rows = ["2023-11-13", "2023-11-14", "2026-11-13"].map((date) => ({ date }));
    expect(inWindow(rows, { kind: "months", months: 36 })).toHaveLength(3); // from 13 Nov 2023, inclusive
    expect(inWindow(rows, { kind: "months", months: 12 })).toHaveLength(1);
    expect(edate("2024-02-29", -12)).toBe("2023-02-28");
  });
});

describe("suggested corporate actions", () => {
  it("flags an overnight drop near 1/2, 1/3, 1/4, 1/5 or 1/10 after the last Ace day only", () => {
    const closes = [
      { date: "2026-11-10", price: 1000 },
      { date: "2026-11-11", price: 495 }, // before the last Ace day: ignored
      { date: "2026-11-16", price: 500 },
      { date: "2026-11-17", price: 98 }, // ≈ 1/5
      { date: "2026-11-18", price: 70 }, // −29%: not a common ratio
    ];
    const s = priceDropSuggestions(closes, "2026-11-13");
    expect(s.map((x) => [x.date, x.detail.ratio])).toEqual([["2026-11-17", "1/5"]]);
  });

  it("flags an Ace implied-share jump over 1%, but not ESOP-sized moves or rounding", () => {
    const row = (date: string, close: number, mcap: number): AceDay => ({ date, close, mcap, pe: null, pbv: null, mcapSales: null, evEbitda: null });
    expect(aceShareJumps([row("2026-11-10", 1000, 40000), row("2026-11-11", 1000, 40240)])).toHaveLength(0); // +0.6%
    expect(aceShareJumps([row("2026-11-10", 1000, 40000), row("2026-11-11", 1000, 44000)])[0]).toMatchObject({ date: "2026-11-11", kind: "ace_shares_jump" });
    expect(aceShareJumps([row("2026-11-10", 4.1, 41), row("2026-11-11", 4.0, 40.4)])).toHaveLength(0); // 1-dp rounding on a ₹4 stock
  });
});

describe("sector median, basis fallback and the stale note", () => {
  it("takes the daily median over companies with a value that day", () => {
    const p = (date: string, pe: number | null, source: MultiplePoint["source"] = "ace"): MultiplePoint => ({ date, pe, pbv: null, mcapSales: null, evEbitda: null, source });
    const m = sectorMedian([[p("2026-11-13", 10), p("2026-11-16", 12, "derived")], [p("2026-11-13", 20)], [p("2026-11-13", null), p("2026-11-16", 30, "live")]]);
    expect(m).toEqual([
      { date: "2026-11-13", pe: 15, pbv: null, mcapSales: null, evEbitda: null, source: "ace" },
      { date: "2026-11-16", pe: 21, pbv: null, mcapSales: null, evEbitda: null, source: "live" },
    ]);
  });

  it("falls back to standalone when there are no consolidated figures", () => {
    const empty: AceDay = { date: "2026-11-13", close: 10, mcap: 100, pe: null, pbv: 0, mcapSales: null, evEbitda: null };
    expect(pickBasis([empty], "C")).toEqual({ basis: "S", fallback: true });
    expect(pickBasis([{ ...empty, pe: 12 }], "C")).toEqual({ basis: "C", fallback: false });
  });

  it("says results are due once a quarter-end passes the last Ace date", () => {
    expect(resultsDue("2026-11-13", "2026-12-30")).toBeNull();
    expect(resultsDue("2026-11-13", "2027-01-05")).toBe("2026-12-31");
    expect(firstQuarterEndBetween("2026-09-30", "2026-09-30")).toBeNull();
  });
});
