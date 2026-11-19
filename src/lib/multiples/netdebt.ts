import type { NetDebtEntry } from "./types";

// Which net debt drives EV (DECISIONS.md): Ace's own figure (Latest EV −
// Latest Mcap) from the newest upload that carries it, unless someone has
// entered a figure dated after it — a hand-entered override applies from its
// date until a later Ace upload covers a later date. Pure.

export interface AceNetDebt {
  asOf: string;
  ev: number;
  mcap: number;
}

export type NetDebtChoice = { source: "ace"; entry: NetDebtEntry; ace: AceNetDebt } | { source: "manual"; entry: NetDebtEntry } | null;

export function chooseNetDebt(ace: AceNetDebt | null, manual: NetDebtEntry | null): NetDebtChoice {
  if (manual && (!ace || manual.asOf > ace.asOf)) return { source: "manual", entry: manual };
  if (ace) return { source: "ace", entry: { asOf: ace.asOf, debt: ace.ev - ace.mcap, cash: 0, minority: 0 }, ace };
  return null;
}
