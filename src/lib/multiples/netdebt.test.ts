import { describe, expect, it } from "vitest";
import { chooseNetDebt } from "./netdebt";

// Made-up numbers only.
describe("which net debt drives EV", () => {
  const ace = { asOf: "2026-11-18", ev: 1500, mcap: 1200 };
  it("uses Ace's Latest EV − Mcap by default", () => {
    expect(chooseNetDebt(ace, null)).toMatchObject({ source: "ace", entry: { asOf: "2026-11-18", debt: 300, cash: 0, minority: 0 } });
  });
  it("lets a manual entry dated after Ace's figure override it, and not one dated before", () => {
    const later = { asOf: "2026-11-25", debt: 900, cash: 100, minority: 0 };
    expect(chooseNetDebt(ace, later)).toMatchObject({ source: "manual", entry: later });
    expect(chooseNetDebt(ace, { ...later, asOf: "2026-11-10" })?.source).toBe("ace");
    expect(chooseNetDebt(null, later)?.source).toBe("manual");
    expect(chooseNetDebt(null, null)).toBeNull();
  });
});
