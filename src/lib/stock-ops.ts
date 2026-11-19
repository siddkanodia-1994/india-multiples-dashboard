import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/client";
import { activityLog, caSuggestions, corporateActions, netDebt, stocks } from "./db/schema";
import { OpError } from "./workspace/server";

// Edits to one stock's shared facts (BUILD-PROMPT §3.3–3.7, §7): corporate
// actions, the hand-entered net debt, the EV/EBITDA switch, and decisions on
// suggested actions. Removals go to the bin (restorable for 30 days); every
// edit is logged. Shares are in crore, money in ₹ crore, prices in ₹.

export type ActionInput =
  | { type: "raise"; date: string; newShares: number; price: number; note?: string }
  | { type: "buyback"; date: string; shares: number; price: number; note?: string }
  | { type: "bonus"; date: string; ratioA: number; ratioB: number; note?: string }
  | { type: "split"; date: string; fvOld: number; fvNew: number; note?: string }
  | { type: "other"; date: string; sharesAfter: number; cash?: number | null; note?: string };

export type StockOp =
  | { op: "addAction"; action: ActionInput; suggestionId?: number }
  | { op: "removeAction"; id: number }
  | { op: "addNetDebt"; basis: "C" | "S"; asOf: string; debt: number; cash: number; minority?: number }
  | { op: "removeNetDebt"; id: number }
  | { op: "setEvMeaningful"; value: boolean }
  | { op: "dismissSuggestion"; id: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pos = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new OpError(`${what} must be a positive number.`);
  return v;
};
const num = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new OpError(`${what} must be a number.`);
  return v;
};
const day = (v: unknown) => {
  if (typeof v !== "string" || !DATE.test(v) || v < "2021-01-01") throw new OpError("Pick a date on or after 1 Jan 2021.");
  return v;
};

function actionRow(a: ActionInput) {
  const base = { date: day(a.date), type: a.type, note: typeof a.note === "string" ? a.note.slice(0, 200) || null : null };
  switch (a.type) {
    case "raise":
      return { ...base, newShares: pos(a.newShares, "New shares"), price: pos(a.price, "Issue price") };
    case "buyback":
      return { ...base, newShares: pos(a.shares, "Shares bought back"), price: pos(a.price, "Buyback price") };
    case "bonus":
      if (!Number.isInteger(a.ratioA) || !Number.isInteger(a.ratioB) || a.ratioA <= 0 || a.ratioB <= 0) throw new OpError("A bonus ratio is two whole numbers, e.g. 1:1.");
      return { ...base, ratioA: a.ratioA, ratioB: a.ratioB };
    case "split":
      if (pos(a.fvOld, "Old face value") <= pos(a.fvNew, "New face value")) throw new OpError("A split lowers the face value (e.g. ₹10 → ₹2).");
      return { ...base, fvOld: a.fvOld, fvNew: a.fvNew };
    case "other":
      return { ...base, sharesAfter: pos(a.sharesAfter, "Shares after"), cash: a.cash === null || a.cash === undefined ? null : num(a.cash, "Cash") };
    default:
      throw new OpError("Unknown action type.");
  }
}

const TYPE_LABEL: Record<ActionInput["type"], string> = { raise: "equity raise", buyback: "buyback", bonus: "bonus", split: "split", other: "share-count change" };

export async function applyStockOp(stockId: number, o: StockOp, actorRaw: unknown): Promise<void> {
  const actor = typeof actorRaw === "string" && actorRaw.trim() ? actorRaw.trim().slice(0, 60) : "unknown";
  const [s] = await db.select().from(stocks).where(eq(stocks.id, stockId));
  if (!s) throw new OpError("Unknown company.");
  const log = (action: string, entity: string, entityId: number | string, summary: string) =>
    db.insert(activityLog).values({ profile: actor, action, entity, entityId: String(entityId), summary });
  const now = new Date();

  switch (o.op) {
    case "addAction": {
      const row = actionRow(o.action);
      const [a] = await db
        .insert(corporateActions)
        .values({ ...row, stockId, createdBy: actor })
        .returning({ id: corporateActions.id });
      if (o.suggestionId) {
        await db
          .update(caSuggestions)
          .set({ status: "confirmed", decidedBy: actor, decidedAt: now, actionId: a.id })
          .where(and(eq(caSuggestions.id, o.suggestionId), eq(caSuggestions.stockId, stockId)));
      }
      return void (await log("add", "action", a.id, `Added ${TYPE_LABEL[o.action.type]} on ${row.date} to ${s.name}${o.suggestionId ? " (confirmed suggestion)" : ""}`));
    }
    case "removeAction": {
      const [a] = await db.select().from(corporateActions).where(and(eq(corporateActions.id, o.id), eq(corporateActions.stockId, stockId), isNull(corporateActions.deletedAt)));
      if (!a) throw new OpError("That action no longer exists.");
      await db.update(corporateActions).set({ deletedAt: now, binId: crypto.randomUUID() }).where(eq(corporateActions.id, o.id));
      return void (await log("remove", "action", o.id, `Removed ${TYPE_LABEL[a.type as ActionInput["type"]]} on ${a.date} from ${s.name}`));
    }
    case "addNetDebt": {
      const basis = o.basis === "S" ? "S" : "C";
      const row = { asOf: day(o.asOf), debt: num(o.debt, "Debt"), cash: num(o.cash, "Cash"), minority: o.minority === undefined ? 0 : num(o.minority, "Minority interest") };
      const [n] = await db
        .insert(netDebt)
        .values({ ...row, basis, stockId, createdBy: actor })
        .returning({ id: netDebt.id });
      return void (await log(
        "add",
        "net_debt",
        n.id,
        `Set ${basis === "C" ? "consolidated" : "standalone"} net debt for ${s.name}: ₹${(row.debt - row.cash + row.minority).toLocaleString("en-IN")} cr as of ${row.asOf}`
      ));
    }
    case "removeNetDebt": {
      const [n] = await db.select().from(netDebt).where(and(eq(netDebt.id, o.id), eq(netDebt.stockId, stockId), isNull(netDebt.deletedAt)));
      if (!n) throw new OpError("That net-debt entry no longer exists.");
      await db.update(netDebt).set({ deletedAt: now, binId: crypto.randomUUID() }).where(eq(netDebt.id, o.id));
      return void (await log("remove", "net_debt", o.id, `Removed net debt as of ${n.asOf} from ${s.name}`));
    }
    case "setEvMeaningful": {
      await db.update(stocks).set({ evMeaningful: Boolean(o.value) }).where(eq(stocks.id, stockId));
      return void (await log("settings", "stock", stockId, `Turned EV/EBITDA ${o.value ? "on" : "off"} for ${s.name}`));
    }
    case "dismissSuggestion": {
      await db
        .update(caSuggestions)
        .set({ status: "dismissed", decidedBy: actor, decidedAt: now })
        .where(and(eq(caSuggestions.id, o.id), eq(caSuggestions.stockId, stockId)));
      return void (await log("dismiss", "suggestion", o.id, `Marked a suggested corporate action for ${s.name} as not one`));
    }
    default:
      throw new OpError("Unknown edit.");
  }
}
