import { describe, expect, it } from "vitest";
import { validateAceRows } from "../ace/validate";
import { tokenClaims } from "../dhan/token";
import { isMarketOpen } from "../market";
import { syncFrom } from "../sync";
import { isLenderIndustry, matchScore, nameSimilarity, normalizeName, parseNifty500, splitCsvLine } from "./match";

// Made-up names and numbers only.

describe("name matching", () => {
  it("normalises Ace, NSE and DHAN spellings to the same words", () => {
    expect(normalizeName("The Alpha Engineering Ltd.")).toBe("alpha engineering");
    expect(normalizeName("Alpha Engineering")).toBe("alpha engineering");
    expect(normalizeName("ALPHA & BETA (INDIA) LIMITED")).toBe("alpha and beta india");
  });
  it("scores word overlap", () => {
    expect(nameSimilarity("Alpha Gears Ltd.", "Alpha Gears")).toBe(1);
    expect(nameSimilarity("Alpha Gears Ltd.", "Alpha Power")).toBeCloseTo(1 / 3, 9);
    expect(nameSimilarity("Alpha", "Beta")).toBe(0);
  });
  it("splits CSV lines with quoted commas", () => {
    expect(splitCsvLine('NSE,E,1,"Alpha, Beta",EQ')).toEqual(["NSE", "E", "1", "Alpha, Beta", "EQ"]);
  });
});

describe("abbreviated DHAN names", () => {
  // Public company names as DHAN and Ace write them (no licensed data).
  const pairs: [string, string][] = [
    ["Tata Power Company Ltd.", "TATA POWER CO LTD"],
    ["HDFC Asset Management Company Ltd.", "HDFC AMC"],
    ["Computer Age Management Services Ltd.", "CAMS"],
    ["Nippon Life India Asset Management Ltd.", "NIPPON L I A M LTD"],
    ["UTI Asset Management Company Ltd.", "UTI ASSET MNGMT CO LTD"],
    ["Dixon Technologies (India) Ltd.", "DIXON TECHNO (INDIA) LTD"],
    ["ZF Commercial Vehicle Control Systems India Ltd.", "ZF COM VE CTR SYS IND LTD"],
    ["Amber Enterprises India Ltd.", "AMBER ENTERPRISES (I) LTD"],
    ["Dr. Lal Pathlabs Ltd.", "DR. LAL PATH LABS LTD."],
  ];
  it.each(pairs)("%s ≈ %s", (ace, dhan) => {
    expect(matchScore(ace, dhan)).toBeGreaterThanOrEqual(0.75);
  });
  it("scores unrelated names low", () => {
    expect(matchScore("Tata Power Company Ltd.", "TATA STEEL LTD")).toBeLessThan(0.6);
    expect(matchScore("HDFC Asset Management Company Ltd.", "HDFC BANK LTD")).toBeLessThan(0.5);
  });
});

describe("Nifty 500 file", () => {
  it("reads columns by name and checks ISINs", () => {
    const { rows, errors } = parseNifty500([
      ["Company Name", "Industry", "Symbol", "Series", "ISIN Code"],
      ["Alpha Gears Ltd.", "Capital Goods", "ALPHAG", "EQ", "INE000A01011"],
      ["Beta Finance Ltd.", "Financial Services", "BETAFIN", "EQ", "bad"],
    ]);
    expect(rows).toEqual([{ name: "Alpha Gears Ltd.", industry: "Capital Goods", symbol: "ALPHAG", isin: "INE000A01011" }]);
    expect(errors).toHaveLength(1);
  });
  it("treats Financial Services as lenders for the EV/EBITDA default", () => {
    expect(isLenderIndustry("Financial Services")).toBe(true);
    expect(isLenderIndustry("Capital Goods")).toBe(false);
    expect(isLenderIndustry(null)).toBe(false);
  });
});

describe("DHAN token claims", () => {
  it("reads expiry and client ID from the JWT payload without verifying it", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000, dhanClientId: "1100000001" })).toString("base64url");
    const c = tokenClaims(`x.${payload}.y`);
    expect(c.expiresAt?.getTime()).toBe(1_900_000_000_000);
    expect(c.clientId).toBe("1100000001");
    expect(tokenClaims("not-a-token")).toEqual({ expiresAt: null, clientId: null });
  });
});

describe("server checks", () => {
  const row = { accordCode: 1, name: "Alpha", date: "2026-11-18", close: 100, mcap: 1000, C: { pe: 20, pbv: 2, mcapSales: 3, evEbitda: null }, S: { pe: null, pbv: null, mcapSales: null, evEbitda: null } };
  it("accepts well-formed Ace rows and refuses junk", () => {
    expect(validateAceRows([row]).error).toBeNull();
    expect(validateAceRows([{ ...row, date: "2020-12-31" }]).error).toMatch(/1 Jan 2021/);
    expect(validateAceRows([row, row]).error).toMatch(/Duplicate/);
    expect(validateAceRows([{ ...row, C: { ...row.C, pe: "x" } }]).error).toMatch(/Bad C pe/);
  });
  it("knows NSE market hours in IST", () => {
    expect(isMarketOpen(new Date("2026-11-18T04:00:00Z"))).toBe(true); // Wed 9:30 IST
    expect(isMarketOpen(new Date("2026-11-18T10:30:00Z"))).toBe(false); // Wed 16:00 IST
    expect(isMarketOpen(new Date("2026-11-21T05:00:00Z"))).toBe(false); // Saturday
  });
});

describe("close back-fill after a token gap", () => {
  it("re-pulls the last 14 days, so a 3–4 day gap fills itself", () => {
    expect(syncFrom("2026-11-20", "2026-09-30", "2026-11-25")).toBe("2026-11-11");
  });
  it("starts from the day after the last close when the gap is longer than 14 days", () => {
    expect(syncFrom("2026-10-01", "2026-09-30", "2026-11-25")).toBe("2026-10-02");
  });
  it("first pull starts 14 days before the last Ace day, never before 2021", () => {
    expect(syncFrom(null, "2026-09-30", "2026-11-25")).toBe("2026-09-16");
    expect(syncFrom(null, "2021-01-05", "2026-11-25")).toBe("2021-01-01");
  });
});
