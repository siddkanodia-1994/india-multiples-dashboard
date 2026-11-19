import { sql } from "drizzle-orm";
import { bigserial, boolean, char, date, doublePrecision, integer, jsonb, pgTable, primaryKey, real, serial, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Layout and sizes are explained in SCHEMA.md. Daily tables use `real` and
// composite keys to stay small on Neon's free 0.5 GB; derived and live points
// are computed on request, never stored. "Who" columns hold the name of the
// profile selected in that browser (there are no logins).

const ts = (name: string) => timestamp(name, { withTimezone: true });
const day = (name: string) => date(name, { mode: "string" });

// ── Universe ────────────────────────────────────────────────────────────────

export const stocks = pgTable("stocks", {
  id: serial("id").primaryKey(),
  accordCode: integer("accord_code").unique(),
  aceName: text("ace_name").notNull(),
  name: text("name").notNull(),
  nseSymbol: text("nse_symbol").unique(),
  isin: text("isin").unique(),
  dhanSecurityId: integer("dhan_security_id").unique(),
  industry: text("industry"),
  inNifty500: boolean("in_nifty500").notNull().default(false),
  evMeaningful: boolean("ev_meaningful").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** The Nifty 500 constituents file, uploaded once on Admin: a lookup for symbol, ISIN and industry. */
export const nifty500 = pgTable("nifty500", {
  isin: text("isin").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  industry: text("industry"),
  batchId: integer("batch_id").notNull(),
});

/** NSE_EQ rows of DHAN's scrip master, refreshed when matching Ace names. */
export const dhanScrips = pgTable("dhan_scrips", {
  securityId: integer("security_id").primaryKey(),
  symbol: text("symbol").notNull(),
  isin: text("isin"),
  name: text("name"),
  refreshedAt: ts("refreshed_at").notNull(),
});

// ── Ace data and uploads ────────────────────────────────────────────────────

const aceColumns = {
  close: real("close"),
  mcap: real("mcap"),
  cPe: real("c_pe"),
  cPbv: real("c_pbv"),
  cMcapSales: real("c_mcap_sales"),
  cEvEbitda: real("c_ev_ebitda"),
  sPe: real("s_pe"),
  sPbv: real("s_pbv"),
  sMcapSales: real("s_mcap_sales"),
  sEvEbitda: real("s_ev_ebitda"),
};

/** One row per stock-day with both bases: close and Mcap are shared, so this is half the size of a row per basis. */
export const aceDaily = pgTable(
  "ace_daily",
  {
    stockId: integer("stock_id").notNull().references(() => stocks.id),
    date: day("date").notNull(),
    ...aceColumns,
    batchId: integer("batch_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.stockId, t.date] })]
);

/** Values a batch overwrote, so rolling it back can put them back. */
export const aceSuperseded = pgTable(
  "ace_superseded",
  {
    batchId: integer("batch_id").notNull(),
    stockId: integer("stock_id").notNull(),
    date: day("date").notNull(),
    ...aceColumns,
    prevBatchId: integer("prev_batch_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.stockId, t.date] })]
);

/**
 * Ace's "Latest" Market Cap / EV / shares for a stock and basis, dated to the
 * stock's last day in that upload. Net debt = EV − Mcap, set automatically by
 * every upload that carries Latest EV (₹ crore; shares in crore).
 */
export const aceSnapshots = pgTable(
  "ace_snapshots",
  {
    stockId: integer("stock_id")
      .notNull()
      .references(() => stocks.id),
    basis: char("basis", { length: 1 }).notNull(), // 'C' | 'S'
    asOf: day("as_of").notNull(),
    mcap: doublePrecision("mcap"),
    ev: doublePrecision("ev"),
    shares: doublePrecision("shares"),
    batchId: integer("batch_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.stockId, t.basis, t.asOf] })]
);

export const uploadBatches = pgTable("upload_batches", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // 'ace' | 'nifty500'
  fileName: text("file_name").notNull(),
  summary: jsonb("summary").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  rolledBackAt: ts("rolled_back_at"),
  rolledBackBy: text("rolled_back_by"),
});

// ── Prices ──────────────────────────────────────────────────────────────────

export const closes = pgTable(
  "closes",
  {
    stockId: integer("stock_id").notNull().references(() => stocks.id),
    date: day("date").notNull(),
    close: real("close").notNull(),
  },
  (t) => [primaryKey({ columns: [t.stockId, t.date] })]
);

export const syncState = pgTable("sync_state", {
  job: text("job").primaryKey(),
  cursor: jsonb("cursor"),
  status: text("status"),
  startedAt: ts("started_at"),
  updatedAt: ts("updated_at"),
});

// ── Profiles → sector tabs → companies (shared, with the bin) ───────────────

const edited = {
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
  deletedAt: ts("deleted_at"),
  binId: uuid("bin_id"),
};

export const profiles = pgTable("profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  ...edited,
});

export const tabs = pgTable("tabs", {
  id: serial("id").primaryKey(),
  profileId: integer("profile_id")
    .notNull()
    .references(() => profiles.id),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  ...edited,
});

export const tabStocks = pgTable(
  "tab_stocks",
  {
    tabId: integer("tab_id")
      .notNull()
      .references(() => tabs.id),
    stockId: integer("stock_id")
      .notNull()
      .references(() => stocks.id),
    position: integer("position").notNull(),
    ...edited,
  },
  (t) => [primaryKey({ columns: [t.tabId, t.stockId] })]
);

// ── Corporate actions, net debt, suggestions ────────────────────────────────

export const corporateActions = pgTable("corporate_actions", {
  id: serial("id").primaryKey(),
  stockId: integer("stock_id")
    .notNull()
    .references(() => stocks.id),
  date: day("date").notNull(),
  type: text("type").notNull(), // 'raise' | 'buyback' | 'bonus' | 'split' | 'other'
  newShares: doublePrecision("new_shares"), // crore
  price: doublePrecision("price"), // ₹
  ratioA: integer("ratio_a"),
  ratioB: integer("ratio_b"),
  fvOld: doublePrecision("fv_old"),
  fvNew: doublePrecision("fv_new"),
  sharesAfter: doublePrecision("shares_after"), // crore
  cash: doublePrecision("cash"), // ₹ crore, + in / − out
  note: text("note"),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
  binId: uuid("bin_id"),
});

/** Hand-entered net debt (₹ crore) per stock and basis: debt − cash + minority interest. */
export const netDebt = pgTable("net_debt", {
  id: serial("id").primaryKey(),
  stockId: integer("stock_id")
    .notNull()
    .references(() => stocks.id),
  basis: char("basis", { length: 1 }).notNull(), // 'C' | 'S'
  asOf: day("as_of").notNull(),
  debt: doublePrecision("debt").notNull(),
  cash: doublePrecision("cash").notNull(),
  minority: doublePrecision("minority").notNull().default(0),
  createdBy: text("created_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
  binId: uuid("bin_id"),
});

export const caSuggestions = pgTable(
  "ca_suggestions",
  {
    id: serial("id").primaryKey(),
    stockId: integer("stock_id")
      .notNull()
      .references(() => stocks.id),
    date: day("date").notNull(),
    kind: text("kind").notNull(), // 'price_drop' | 'ace_shares_jump'
    detail: jsonb("detail").notNull(),
    status: text("status").notNull().default("open"), // open | confirmed | dismissed
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    actionId: integer("action_id").references(() => corporateActions.id),
  },
  (t) => [unique().on(t.stockId, t.date, t.kind)]
);

// ── Admin ───────────────────────────────────────────────────────────────────

/** Every write logs here; max(id) is the one number the 30-s change check reads. */
export const activityLog = pgTable("activity_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  profile: text("profile"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  summary: text("summary").notNull(),
  detail: jsonb("detail"),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: ts("updated_at")
    .notNull()
    .default(sql`now()`),
});
