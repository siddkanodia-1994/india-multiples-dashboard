import { describe, expect, it } from "vitest";
import { validateAceRows } from "../ace/validate";
import { tokenClaims } from "../dhan/token";
import { isMarketOpen } from "../market";
import { isLenderIndustry, nameSimilarity, normalizeName, parseNifty500, splitCsvLine } from "./match";

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
