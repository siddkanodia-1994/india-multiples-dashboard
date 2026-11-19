import { describe, expect, it } from "vitest";
import { parseAceRows } from "./parse";

// Made-up numbers only: real Ace Equity values are licensed and never committed.
const HEADER = [
  "Accord Code",
  "Company Name",
  "NDP_Date",
  "NDP_Consolidated EV EBIDTA",
  "NDP_Consolidated MCAP NS",
  "NDP_Consolidated Price BV",
  "NDP_Consolidated PE",
  "NDP_MCAP_NS",
  "NDP_EV_EBIDTA",
  "NDP_Price_BV",
  "NDP_PE",
  "NDP_Close",
  "NDP_Mcap",
];

describe("parseAceRows", () => {
  it("reads both bases by header name, Excel dates, and 0.0 or blank as null", () => {
    const { rows, errors, missing } = parseAceRows([
      ["Query - Query Expression"],
      HEADER,
      [111, "Alpha Gears Ltd.", 46344, 12.5, 2.1, 3.2, 20.4, 2.3, 11.9, 3.0, 19.8, 250.5, 5010],
      [111, "Alpha Gears Ltd.", "2026-11-19", 0, null, "", null, 2.4, 12.1, 3.1, 20.2, 255, 5100],
      [],
      ["Source:Ace Equity Nxt... Disclaimer"],
    ]);
    expect(errors).toEqual([]);
    expect(missing).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      accordCode: 111,
      name: "Alpha Gears Ltd.",
      date: "2026-11-18",
      close: 250.5,
      mcap: 5010,
      C: { pe: 20.4, pbv: 3.2, mcapSales: 2.1, evEbitda: 12.5 },
      S: { pe: 19.8, pbv: 3.0, mcapSales: 2.3, evEbitda: 11.9 },
    });
    expect(rows[1].C).toEqual({ pe: null, pbv: null, mcapSales: null, evEbitda: null });
  });

  it("reports absent multiples, and refuses a file without the key columns", () => {
    const { missing } = parseAceRows([HEADER.filter((h) => !h.includes("EV")), [1, "A", 46344, 1, 1, 1, 1, 1, 1, 10, 100]]);
    expect(missing).toEqual(["Consolidated EV/EBITDA", "Standalone EV/EBITDA"]);
    expect(parseAceRows([["Accord Code", "NDP_Date"]]).errors[0]).toMatch(/Missing column/);
  });

  it("skips junk and duplicate rows with a reason", () => {
    const { rows, errors } = parseAceRows([HEADER, [1, "A", 46344, 1, 1, 1, "x", 1, 1, 1, 1, 10, 100], [2, "B", 46344, 1, 1, 1, 1, 1, 1, 1, 1, 10, 100], [2, "B", 46344, 1, 1, 1, 1, 1, 1, 1, 1, 10, 100]]);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual(["Row 2: a multiple is not a number.", "Row 4: duplicate date 2026-11-18 for Accord Code 2."]);
  });

  it("works out Mcap from the Latest share count when NDP_Mcap is absent, and reads the Latest snapshot", () => {
    const head = [...HEADER.filter((h) => h !== "NDP_Mcap"), "SCC_Latest Market Cap", "SCC_Latest EV", "SCC_Latest No of shares", "SC_Latest Market Cap", "SC_Latest EV", "SC_Latest No of Shares"];
    const { rows, errors, mcapSource, hasLatestEv } = parseAceRows([head, [7, "Gamma Power Ltd.", 46344, 12, 2, 3, 20, 2.1, 11, 2.9, 19, 100, 1200, 1500, 120000000, 1200, 1300, 120000000]]);
    expect(errors).toEqual([]);
    expect(mcapSource).toBe("latest_shares");
    expect(hasLatestEv).toBe(true);
    expect(rows[0].mcap).toBeCloseTo(1200, 9); // ₹100 × 12 cr shares
    expect(rows[0].latest).toEqual({ C: { mcap: 1200, ev: 1500, shares: 12 }, S: { mcap: 1200, ev: 1300, shares: 12 } });
  });

  it("refuses a file with neither NDP_Mcap nor a Latest share count", () => {
    expect(parseAceRows([HEADER.filter((h) => h !== "NDP_Mcap"), [7, "G", 46344, 1, 1, 1, 1, 1, 1, 1, 1, 100]]).errors[0]).toMatch(/NDP_Mcap/);
  });
});
