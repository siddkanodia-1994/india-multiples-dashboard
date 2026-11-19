import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { aceDaily, activityLog, corporateActions, netDebt, profiles, stocks, tabStocks, tabs } from "../db/schema";
import type { BinItem, Workspace, WorkspaceOp } from "./types";

// Profiles → sector tabs → companies, shared by everyone and saved on every
// edit (BUILD-PROMPT §6). Removing sets deleted_at on the item and its
// children under one bin_id, so a restore brings them back together; the
// daily job purges bin rows after 30 days. Stock data is never touched here.
// Every edit writes activity_log, whose max(id) is the screens' change check.

export class OpError extends Error {}

const BIN_DAYS = 30;

export async function getVersion(): Promise<number> {
  const [r] = await db.select({ v: sql<number>`coalesce(max(${activityLog.id}), 0)::int` }).from(activityLog);
  return r.v;
}

export async function getWorkspace(): Promise<Workspace> {
  const [ps, ts, links, ss, lastAce, bin, last] = await Promise.all([
    db.select({ id: profiles.id, name: profiles.name }).from(profiles).where(isNull(profiles.deletedAt)).orderBy(profiles.position, profiles.id),
    db.select({ id: tabs.id, profileId: tabs.profileId, name: tabs.name }).from(tabs).where(isNull(tabs.deletedAt)).orderBy(tabs.position, tabs.id),
    db.select({ tabId: tabStocks.tabId, stockId: tabStocks.stockId }).from(tabStocks).where(isNull(tabStocks.deletedAt)).orderBy(tabStocks.position),
    db.select({ id: stocks.id, name: stocks.name, nseSymbol: stocks.nseSymbol }).from(stocks).orderBy(stocks.name),
    db.select({ stockId: aceDaily.stockId, last: sql<string>`max(${aceDaily.date})::text` }).from(aceDaily).groupBy(aceDaily.stockId),
    db.execute(sql`
      select p.bin_id::text as "binId", 'profile' as kind, p.name as label, null as "from", p.deleted_at as "removedAt", p.updated_by as "removedBy"
        from profiles p where p.deleted_at > now() - make_interval(days => ${BIN_DAYS}) and p.bin_id is not null
      union all
      select t.bin_id::text, 'tab', t.name, p.name, t.deleted_at, t.updated_by
        from tabs t join profiles p on p.id = t.profile_id
        where t.deleted_at > now() - make_interval(days => ${BIN_DAYS}) and t.bin_id is not null and t.bin_id is distinct from p.bin_id
      union all
      select l.bin_id::text, 'company', s.name, t.name, l.deleted_at, l.updated_by
        from tab_stocks l join tabs t on t.id = l.tab_id join stocks s on s.id = l.stock_id
        where l.deleted_at > now() - make_interval(days => ${BIN_DAYS}) and l.bin_id is not null and l.bin_id is distinct from t.bin_id
      union all
      select a.bin_id::text, 'action', initcap(a.type) || ' on ' || a.date::text, s.name, a.deleted_at, null
        from corporate_actions a join stocks s on s.id = a.stock_id
        where a.deleted_at > now() - make_interval(days => ${BIN_DAYS}) and a.bin_id is not null
      union all
      select n.bin_id::text, 'netDebt', 'Net debt as of ' || n.as_of::text, s.name, n.deleted_at, null
        from net_debt n join stocks s on s.id = n.stock_id
        where n.deleted_at > now() - make_interval(days => ${BIN_DAYS}) and n.bin_id is not null
      order by 5 desc`),
    db.select().from(activityLog).orderBy(desc(activityLog.id)).limit(1),
  ]);
  const lastByStock = new Map(lastAce.map((r) => [r.stockId, r.last]));
  return {
    profiles: ps.map((p) => ({
      id: p.id,
      name: p.name,
      tabs: ts.filter((t) => t.profileId === p.id).map((t) => ({ id: t.id, name: t.name, stockIds: links.filter((l) => l.tabId === t.id).map((l) => l.stockId) })),
    })),
    stocks: ss.map((s) => ({ ...s, lastAceDate: lastByStock.get(s.id) ?? null })),
    bin: (bin.rows as unknown as BinItem[]).map((b) => ({ ...b, removedAt: new Date(b.removedAt).toISOString() })),
    version: last[0]?.id ?? 0,
    lastChange: last[0] ? { id: last[0].id, profile: last[0].profile, summary: last[0].summary, at: last[0].at.toISOString() } : null,
  };
}

// ── edits ───────────────────────────────────────────────────────────────────

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!n) throw new OpError("A name is required.");
  if (n.length > 60) throw new OpError("Names can be at most 60 characters.");
  return n;
}

async function log(actor: string, action: string, entity: string, entityId: number | string, summary: string) {
  await db.insert(activityLog).values({ profile: actor, action, entity, entityId: String(entityId), summary });
}

async function nextPosition(table: typeof profiles | typeof tabs | typeof tabStocks, where?: ReturnType<typeof eq>) {
  const [r] = await db
    .select({ p: sql<number>`coalesce(max(${table.position}), -1)::int + 1` })
    .from(table)
    .where(where ? and(where, isNull(table.deletedAt)) : isNull(table.deletedAt));
  return r.p;
}

async function liveProfile(id: number) {
  const [p] = await db.select().from(profiles).where(and(eq(profiles.id, id), isNull(profiles.deletedAt)));
  if (!p) throw new OpError("That profile no longer exists — someone may have removed it.");
  return p;
}

async function liveTab(id: number) {
  const [t] = await db.select().from(tabs).where(and(eq(tabs.id, id), isNull(tabs.deletedAt)));
  if (!t) throw new OpError("That sector tab no longer exists — someone may have removed it.");
  return t;
}

async function stockName(id: number) {
  const [s] = await db.select({ name: stocks.name }).from(stocks).where(eq(stocks.id, id));
  if (!s) throw new OpError("Unknown company.");
  return s.name;
}

/** Copies a tab and its companies into a profile; returns the new tab id. */
async function copyTabInto(tabId: number, profileId: number, name: string, actor: string): Promise<number> {
  const [t] = await db
    .insert(tabs)
    .values({ profileId, name, position: await nextPosition(tabs, eq(tabs.profileId, profileId)), updatedBy: actor })
    .returning({ id: tabs.id });
  await db.execute(sql`
    insert into tab_stocks (tab_id, stock_id, position, updated_by)
    select ${t.id}, stock_id, position, ${actor} from tab_stocks where tab_id = ${tabId} and deleted_at is null`);
  return t.id;
}

function reorder(table: typeof profiles | typeof tabs, ids: number[], actor: string) {
  if (!ids.length) return Promise.resolve();
  const [first, ...rest] = ids.map((id, i) => db.update(table).set({ position: i, updatedAt: new Date(), updatedBy: actor }).where(eq(table.id, id)));
  return db.batch([first, ...rest]);
}

export async function applyOp(o: WorkspaceOp, actorRaw: unknown): Promise<void> {
  const actor = typeof actorRaw === "string" && actorRaw.trim() ? actorRaw.trim().slice(0, 60) : "unknown";
  const now = new Date();
  switch (o.op) {
    case "addProfile": {
      const name = cleanName(o.name);
      const [p] = await db.insert(profiles).values({ name, position: await nextPosition(profiles), updatedBy: actor }).returning({ id: profiles.id });
      return log(actor, "add", "profile", p.id, `Added profile ${name}`);
    }
    case "renameProfile": {
      const p = await liveProfile(o.id);
      const name = cleanName(o.name);
      await db.update(profiles).set({ name, updatedAt: now, updatedBy: actor }).where(eq(profiles.id, o.id));
      return log(actor, "rename", "profile", o.id, `Renamed profile ${p.name} to ${name}`);
    }
    case "removeProfile": {
      const p = await liveProfile(o.id);
      const binId = crypto.randomUUID();
      const live = await db.select({ id: tabs.id }).from(tabs).where(and(eq(tabs.profileId, o.id), isNull(tabs.deletedAt)));
      const tabIds = live.map((t) => t.id);
      const gone = { deletedAt: now, binId, updatedAt: now, updatedBy: actor };
      await db.batch([
        db.update(profiles).set(gone).where(eq(profiles.id, o.id)),
        db.update(tabs).set(gone).where(and(eq(tabs.profileId, o.id), isNull(tabs.deletedAt))),
        db.update(tabStocks).set(gone).where(and(inArray(tabStocks.tabId, tabIds.length ? tabIds : [-1]), isNull(tabStocks.deletedAt))),
      ]);
      return log(actor, "remove", "profile", o.id, `Removed profile ${p.name} (with ${tabIds.length} tab${tabIds.length === 1 ? "" : "s"})`);
    }
    case "duplicateProfile": {
      const p = await liveProfile(o.id);
      const [copy] = await db
        .insert(profiles)
        .values({ name: `${p.name} (copy)`.slice(0, 60), position: await nextPosition(profiles), updatedBy: actor })
        .returning({ id: profiles.id });
      const ts = await db.select().from(tabs).where(and(eq(tabs.profileId, o.id), isNull(tabs.deletedAt))).orderBy(tabs.position, tabs.id);
      for (const t of ts) await copyTabInto(t.id, copy.id, t.name, actor);
      return log(actor, "duplicate", "profile", copy.id, `Duplicated profile ${p.name}`);
    }
    case "reorderProfiles":
      await reorder(profiles, o.ids, actor);
      return log(actor, "reorder", "profile", "", "Reordered profiles");
    case "addTab": {
      const p = await liveProfile(o.profileId);
      const name = cleanName(o.name);
      const [t] = await db
        .insert(tabs)
        .values({ profileId: o.profileId, name, position: await nextPosition(tabs, eq(tabs.profileId, o.profileId)), updatedBy: actor })
        .returning({ id: tabs.id });
      return log(actor, "add", "tab", t.id, `Added sector tab ${name} to ${p.name}`);
    }
    case "renameTab": {
      const t = await liveTab(o.id);
      const name = cleanName(o.name);
      await db.update(tabs).set({ name, updatedAt: now, updatedBy: actor }).where(eq(tabs.id, o.id));
      return log(actor, "rename", "tab", o.id, `Renamed sector tab ${t.name} to ${name}`);
    }
    case "removeTab": {
      const t = await liveTab(o.id);
      const binId = crypto.randomUUID();
      const gone = { deletedAt: now, binId, updatedAt: now, updatedBy: actor };
      await db.batch([
        db.update(tabs).set(gone).where(eq(tabs.id, o.id)),
        db.update(tabStocks).set(gone).where(and(eq(tabStocks.tabId, o.id), isNull(tabStocks.deletedAt))),
      ]);
      return log(actor, "remove", "tab", o.id, `Removed sector tab ${t.name}`);
    }
    case "duplicateTab": {
      const t = await liveTab(o.id);
      const id = await copyTabInto(t.id, t.profileId, `${t.name} (copy)`.slice(0, 60), actor);
      return log(actor, "duplicate", "tab", id, `Duplicated sector tab ${t.name}`);
    }
    case "moveTab": {
      const t = await liveTab(o.id);
      const p = await liveProfile(o.profileId);
      if (o.copy) {
        const id = await copyTabInto(t.id, p.id, t.name, actor);
        return log(actor, "copy", "tab", id, `Copied sector tab ${t.name} to ${p.name}`);
      }
      if (t.profileId === p.id) return;
      await db
        .update(tabs)
        .set({ profileId: p.id, position: await nextPosition(tabs, eq(tabs.profileId, p.id)), updatedAt: now, updatedBy: actor })
        .where(eq(tabs.id, t.id));
      return log(actor, "move", "tab", t.id, `Moved sector tab ${t.name} to ${p.name}`);
    }
    case "reorderTabs":
      await reorder(tabs, o.ids, actor);
      return log(actor, "reorder", "tab", o.profileId, "Reordered sector tabs");
    case "addStock": {
      const t = await liveTab(o.tabId);
      const name = await stockName(o.stockId);
      await addLink(o.tabId, o.stockId, actor, t.name, name);
      return log(actor, "add", "company", `${o.tabId}:${o.stockId}`, `Added ${name} to ${t.name}`);
    }
    case "removeStock": {
      const t = await liveTab(o.tabId);
      const name = await stockName(o.stockId);
      await db
        .update(tabStocks)
        .set({ deletedAt: now, binId: crypto.randomUUID(), updatedAt: now, updatedBy: actor })
        .where(and(eq(tabStocks.tabId, o.tabId), eq(tabStocks.stockId, o.stockId), isNull(tabStocks.deletedAt)));
      return log(actor, "remove", "company", `${o.tabId}:${o.stockId}`, `Removed ${name} from ${t.name}`);
    }
    case "reorderStocks": {
      await liveTab(o.tabId);
      if (o.stockIds.length) {
        const [first, ...rest] = o.stockIds.map((id, i) =>
          db
            .update(tabStocks)
            .set({ position: i, updatedAt: now, updatedBy: actor })
            .where(and(eq(tabStocks.tabId, o.tabId), eq(tabStocks.stockId, id)))
        );
        await db.batch([first, ...rest]);
      }
      return log(actor, "reorder", "company", o.tabId, "Reordered companies");
    }
    case "moveStock": {
      const from = await liveTab(o.tabId);
      const to = await liveTab(o.toTabId);
      const name = await stockName(o.stockId);
      await addLink(to.id, o.stockId, actor, to.name, name);
      if (!o.copy) {
        // A move isn't a removal: the old link leaves no bin entry and is purged with the bin.
        await db
          .update(tabStocks)
          .set({ deletedAt: now, binId: null, updatedAt: now, updatedBy: actor })
          .where(and(eq(tabStocks.tabId, from.id), eq(tabStocks.stockId, o.stockId), isNull(tabStocks.deletedAt)));
      }
      return log(actor, o.copy ? "copy" : "move", "company", `${to.id}:${o.stockId}`, `${o.copy ? "Copied" : "Moved"} ${name} from ${from.name} to ${to.name}`);
    }
    case "restore": {
      const binId = o.binId;
      const [p] = await db.select().from(profiles).where(eq(profiles.binId, binId)).limit(1);
      const [t] = await db.select().from(tabs).where(eq(tabs.binId, binId)).limit(1);
      const [l] = await db.select().from(tabStocks).where(eq(tabStocks.binId, binId)).limit(1);
      const [a] = await db.select().from(corporateActions).where(eq(corporateActions.binId, binId)).limit(1);
      const [n] = await db.select().from(netDebt).where(eq(netDebt.binId, binId)).limit(1);
      if (a || n) {
        if (a) await db.update(corporateActions).set({ deletedAt: null, binId: null }).where(eq(corporateActions.binId, binId));
        if (n) await db.update(netDebt).set({ deletedAt: null, binId: null }).where(eq(netDebt.binId, binId));
        return log(actor, "restore", a ? "action" : "net_debt", binId, a ? `Restored ${a.type} on ${a.date} for ${await stockName(a.stockId)}` : `Restored net debt as of ${n!.asOf} for ${await stockName(n!.stockId)}`);
      }
      if (!p && !t && !l) throw new OpError("Nothing to restore — it was already restored or purged.");
      if (!p && t) await liveProfile(t.profileId).catch(() => Promise.reject(new OpError("Its profile was removed too — restore the profile first.")));
      if (!p && !t && l) {
        await liveTab(l.tabId).catch(() => Promise.reject(new OpError("Its sector tab was removed too — restore the tab first.")));
        const [dup] = await db.select().from(tabStocks).where(and(eq(tabStocks.tabId, l.tabId), eq(tabStocks.stockId, l.stockId), isNull(tabStocks.deletedAt)));
        if (dup) throw new OpError("That company is already back in its tab.");
      }
      const back = { deletedAt: null, binId: null, updatedAt: now, updatedBy: actor };
      await db.batch([
        db.update(profiles).set(back).where(eq(profiles.binId, binId)),
        db.update(tabs).set(back).where(eq(tabs.binId, binId)),
        db.update(tabStocks).set(back).where(eq(tabStocks.binId, binId)),
      ]);
      const label = p ? `profile ${p.name}` : t ? `sector tab ${t.name}` : `${await stockName(l!.stockId)}`;
      return log(actor, "restore", p ? "profile" : t ? "tab" : "company", binId, `Restored ${label}`);
    }
  }
}

async function addLink(tabId: number, stockId: number, actor: string, tabName: string, name: string) {
  const [existing] = await db.select().from(tabStocks).where(and(eq(tabStocks.tabId, tabId), eq(tabStocks.stockId, stockId)));
  if (existing && !existing.deletedAt) throw new OpError(`${name} is already in ${tabName}.`);
  const position = await nextPosition(tabStocks, eq(tabStocks.tabId, tabId));
  await db
    .insert(tabStocks)
    .values({ tabId, stockId, position, updatedBy: actor })
    .onConflictDoUpdate({
      target: [tabStocks.tabId, tabStocks.stockId],
      set: { deletedAt: null, binId: null, position, updatedAt: new Date(), updatedBy: actor },
    });
}
