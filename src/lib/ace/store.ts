import { and, asc, between, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { aceDaily, aceSuperseded, activityLog, caSuggestions, stocks, uploadBatches } from "../db/schema";
import { aceShareJumps } from "../multiples/suggest";
import type { AceRow } from "./parse";

// Saves parsed Ace rows as one upload batch (BUILD-PROMPT §4): an idempotent
// upsert per stock-day. Unchanged rows aren't touched; a changed row's old
// values go to ace_superseded first so the batch can be rolled back. A
// company new to the app joins the universe by its Accord Code. Big files
// arrive in chunks (Vercel caps a request at 4.5 MB): begin → save… → finish.

const CHUNK = 500;
/** A day-on-day move above this in any multiple, close or Mcap is flagged in the preview as likely bad data. */
const SPIKE = 0.25;

type AceValues = Omit<typeof aceDaily.$inferInsert, "stockId" | "date" | "batchId">;
const FIELDS = ["close", "mcap", "cPe", "cPbv", "cMcapSales", "cEvEbitda", "sPe", "sPbv", "sMcapSales", "sEvEbitda"] as const;
const FIELD_LABEL: Record<(typeof FIELDS)[number], string> = {
  close: "Close",
  mcap: "Mcap",
  cPe: "Cons PE",
  cPbv: "Cons P/BV",
  cMcapSales: "Cons Mcap/Sales",
  cEvEbitda: "Cons EV/EBITDA",
  sPe: "SA PE",
  sPbv: "SA P/BV",
  sMcapSales: "SA Mcap/Sales",
  sEvEbitda: "SA EV/EBITDA",
};

function valuesOf(r: AceRow): AceValues {
  return {
    close: r.close,
    mcap: r.mcap,
    cPe: r.C.pe,
    cPbv: r.C.pbv,
    cMcapSales: r.C.mcapSales,
    cEvEbitda: r.C.evEbitda,
    sPe: r.S.pe,
    sPbv: r.S.pbv,
    sMcapSales: r.S.mcapSales,
    sEvEbitda: r.S.evEbitda,
  };
}

// Stored as float4, so compare at float4 precision.
const f4 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.fround(v));
const sameValues = (a: AceValues, b: AceValues) => FIELDS.every((k) => f4(a[k]) === f4(b[k]));

const byCompany = (rows: AceRow[]) => {
  const m = new Map<number, AceRow[]>();
  for (const r of rows) m.set(r.accordCode, [...(m.get(r.accordCode) ?? []), r]);
  for (const list of m.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return m;
};

async function existingFor(stockId: number, from: string, to: string) {
  const rows = await db.select().from(aceDaily).where(and(eq(aceDaily.stockId, stockId), between(aceDaily.date, from, to)));
  return new Map(rows.map((e) => [e.date, e]));
}

export interface CompanyPreview {
  accordCode: number;
  name: string;
  /** Null when the Accord Code is new: the company will join the universe. */
  stockId: number | null;
  from: string;
  to: string;
  added: number;
  changed: number;
  unchanged: number;
  spikes: string[];
}

/** What saving these rows would do, per company, without writing anything. */
export async function previewAceRows(rows: AceRow[]): Promise<CompanyPreview[]> {
  const groups = byCompany(rows);
  const codes = [...groups.keys()];
  const known = codes.length ? await db.select({ id: stocks.id, accordCode: stocks.accordCode }).from(stocks).where(inArray(stocks.accordCode, codes)) : [];
  const out: CompanyPreview[] = [];
  for (const [code, list] of groups) {
    const stockId = known.find((k) => k.accordCode === code)?.id ?? null;
    const old = stockId ? await existingFor(stockId, list[0].date, list.at(-1)!.date) : new Map();
    let added = 0;
    let changed = 0;
    for (const r of list) {
      const e = old.get(r.date);
      if (!e) added++;
      else if (!sameValues(valuesOf(r), e)) changed++;
    }
    const spikes: string[] = [];
    for (let i = 1; i < list.length && spikes.length < 5; i++) {
      const a = valuesOf(list[i - 1]);
      const b = valuesOf(list[i]);
      for (const k of FIELDS) {
        const x = a[k];
        const y = b[k];
        if (x && y && x > 0 && Math.abs(y / x - 1) > SPIKE) {
          spikes.push(`${list[i].date} ${FIELD_LABEL[k]} ${x} → ${y}`);
          break;
        }
      }
    }
    out.push({ accordCode: code, name: list[0].name, stockId, from: list[0].date, to: list.at(-1)!.date, added, changed, unchanged: list.length - added - changed, spikes });
  }
  return out;
}

export async function beginAceBatch(fileName: string, actor: string): Promise<number> {
  const [batch] = await db.insert(uploadBatches).values({ kind: "ace", fileName: fileName.slice(0, 200), summary: { companies: [] }, createdBy: actor }).returning({ id: uploadBatches.id });
  return batch.id;
}

export interface CompanySummary {
  stockId: number;
  name: string;
  from: string;
  to: string;
  added: number;
  changed: number;
  unchanged: number;
  newStock: boolean;
}

export async function saveAceChunk(batchId: number, rows: AceRow[]): Promise<CompanySummary[]> {
  const [batch] = await db.select().from(uploadBatches).where(eq(uploadBatches.id, batchId));
  if (!batch || batch.kind !== "ace" || batch.rolledBackAt) throw new Error("Unknown or rolled-back batch.");
  const groups = byCompany(rows);
  const codes = [...groups.keys()];
  const known = codes.length ? await db.select({ id: stocks.id, accordCode: stocks.accordCode }).from(stocks).where(inArray(stocks.accordCode, codes)) : [];
  const idByCode = new Map(known.map((s) => [s.accordCode!, s.id]));
  const summaries: CompanySummary[] = [];

  for (const [code, mine] of groups) {
    let stockId = idByCode.get(code);
    const newStock = stockId === undefined;
    if (stockId === undefined) {
      const name = mine[0].name || `Accord ${code}`;
      const [s] = await db.insert(stocks).values({ accordCode: code, aceName: name, name }).returning({ id: stocks.id });
      stockId = s.id;
    }
    const old = await existingFor(stockId, mine[0].date, mine.at(-1)!.date);
    const writes: (typeof aceDaily.$inferInsert)[] = [];
    const superseded: (typeof aceSuperseded.$inferInsert)[] = [];
    let unchanged = 0;
    for (const r of mine) {
      const v = valuesOf(r);
      const e = old.get(r.date);
      if (e && sameValues(v, e)) {
        unchanged++;
        continue;
      }
      if (e) {
        const { batchId: prevBatchId, ...oldRow } = e;
        superseded.push({ ...oldRow, batchId, prevBatchId });
      }
      writes.push({ stockId, date: r.date, ...v, batchId });
    }
    for (let i = 0; i < superseded.length; i += CHUNK) await db.insert(aceSuperseded).values(superseded.slice(i, i + CHUNK)).onConflictDoNothing();
    for (let i = 0; i < writes.length; i += CHUNK) {
      await db
        .insert(aceDaily)
        .values(writes.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [aceDaily.stockId, aceDaily.date],
          set: Object.fromEntries(
            ["close", "mcap", "c_pe", "c_pbv", "c_mcap_sales", "c_ev_ebitda", "s_pe", "s_pbv", "s_mcap_sales", "s_ev_ebitda", "batch_id"].map((c) => [
              c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()),
              sql.raw(`excluded.${c}`),
            ])
          ),
        });
    }
    summaries.push({ stockId, name: mine[0].name, from: mine[0].date, to: mine.at(-1)!.date, added: writes.length - superseded.length, changed: superseded.length, unchanged, newStock });
  }
  // Merge into the batch summary (chunks arrive one at a time from one browser).
  const prev = ((batch.summary as { companies?: CompanySummary[] }).companies ?? []).filter((c) => !summaries.some((s) => s.stockId === c.stockId));
  await db.update(uploadBatches).set({ summary: { companies: [...prev, ...summaries] } }).where(eq(uploadBatches.id, batchId));
  return summaries;
}

/** Logs the batch and flags implied-share jumps (a likely corporate action) in what it wrote. */
export async function finishAceBatch(batchId: number, actor: string): Promise<CompanySummary[]> {
  const [batch] = await db.select().from(uploadBatches).where(eq(uploadBatches.id, batchId));
  if (!batch) throw new Error("Unknown batch.");
  const companies = (batch.summary as { companies?: CompanySummary[] }).companies ?? [];
  for (const c of companies) {
    const rows = await db
      .select()
      .from(aceDaily)
      .where(and(eq(aceDaily.stockId, c.stockId), between(aceDaily.date, c.from, c.to)))
      .orderBy(asc(aceDaily.date));
    const jumps = aceShareJumps(rows.map((r) => ({ date: r.date, close: r.close, mcap: r.mcap, pe: null, pbv: null, mcapSales: null, evEbitda: null })));
    if (jumps.length) await db.insert(caSuggestions).values(jumps.map((j) => ({ stockId: c.stockId, date: j.date, kind: j.kind, detail: j.detail }))).onConflictDoNothing();
  }
  await db.insert(activityLog).values({
    profile: actor,
    action: "upload",
    entity: "ace",
    entityId: String(batchId),
    summary: `Ace upload ${batch.fileName}: ${companies.length} companies, ${companies.reduce((s, c) => s + c.added, 0)} new and ${companies.reduce((s, c) => s + c.changed, 0)} changed days`,
  });
  return companies;
}

/** For the command-line import: the whole file as one batch. */
export async function saveAceRows(rows: AceRow[], fileName: string, actor: string): Promise<{ batchId: number; companies: CompanySummary[] }> {
  const batchId = await beginAceBatch(fileName, actor);
  const groups = [...byCompany(rows).values()];
  let chunk: AceRow[] = [];
  for (const g of groups) {
    chunk.push(...g);
    if (chunk.length >= 5000) {
      await saveAceChunk(batchId, chunk);
      chunk = [];
    }
  }
  if (chunk.length) await saveAceChunk(batchId, chunk);
  return { batchId, companies: await finishAceBatch(batchId, actor) };
}

export async function listBatches(limit = 30) {
  return db.select().from(uploadBatches).orderBy(desc(uploadBatches.id)).limit(limit);
}

/**
 * Undoes the latest Ace batch: removes the days it added and puts back the
 * values it overwrote. Only the latest live batch can be rolled back, so a
 * later upload's values are never lost.
 */
export async function rollbackAceBatch(batchId: number, actor: string): Promise<{ removed: number; restored: number }> {
  const [latest] = await db
    .select()
    .from(uploadBatches)
    .where(and(eq(uploadBatches.kind, "ace"), isNull(uploadBatches.rolledBackAt)))
    .orderBy(desc(uploadBatches.id))
    .limit(1);
  if (!latest || latest.id !== batchId) throw new Error("Only the most recent Ace upload can be rolled back.");
  const back = await db.select().from(aceSuperseded).where(eq(aceSuperseded.batchId, batchId));
  const removed = await db.delete(aceDaily).where(eq(aceDaily.batchId, batchId)).returning({ d: aceDaily.date });
  for (let i = 0; i < back.length; i += CHUNK) {
    await db
      .insert(aceDaily)
      .values(
        back.slice(i, i + CHUNK).map((r) => {
          const { prevBatchId, ...row } = r;
          return { ...row, batchId: prevBatchId };
        })
      )
      .onConflictDoNothing();
  }
  await db.update(uploadBatches).set({ rolledBackAt: new Date(), rolledBackBy: actor }).where(eq(uploadBatches.id, batchId));
  await db.insert(activityLog).values({
    profile: actor,
    action: "rollback",
    entity: "ace",
    entityId: String(batchId),
    summary: `Rolled back Ace upload ${latest.fileName}: ${removed.length - back.length} days removed, ${back.length} restored`,
  });
  return { removed: removed.length - back.length, restored: back.length };
}
