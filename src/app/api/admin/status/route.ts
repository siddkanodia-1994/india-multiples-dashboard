import { desc, sql } from "drizzle-orm";
import { listBatches } from "@/lib/ace/store";
import { db } from "@/lib/db/client";
import { activityLog } from "@/lib/db/schema";
import { getDhanStatus } from "@/lib/dhan/token";
import { syncStatus } from "@/lib/sync";

/** Everything the Admin page shows. Never includes the DHAN token. */
export async function GET() {
  const [dhan, size, batches, log, sync, universe] = await Promise.all([
    getDhanStatus().catch((e: unknown) => ({ configured: false, clientId: null, updatedAt: null, expiresAt: null, error: e instanceof Error ? e.message : String(e) })),
    db.execute(sql`select pg_database_size(current_database())::bigint as bytes`),
    listBatches(),
    db.select().from(activityLog).orderBy(desc(activityLog.id)).limit(150),
    syncStatus(),
    db.execute(sql`
      select s.id, s.name, s.accord_code as "accordCode", s.nse_symbol as "nseSymbol", s.isin, s.dhan_security_id as "dhanSecurityId",
             s.industry, s.in_nifty500 as "inNifty500", s.ev_meaningful as "evMeaningful",
             (select max(date)::text from ace_daily a where a.stock_id = s.id) as "lastAce",
             (select max(date)::text from closes c where c.stock_id = s.id) as "lastClose",
             (select count(*)::int from closes c where c.stock_id = s.id) as "closeDays"
      from stocks s order by s.name`),
  ]);
  return Response.json({
    dhan,
    storage: { bytes: Number((size.rows[0] as { bytes: string }).bytes), limit: 512 * 1024 * 1024 },
    batches,
    log,
    sync,
    universe: universe.rows,
    nifty500Rows: Number(((await db.execute(sql`select count(*)::int n from nifty500`)).rows[0] as { n: number }).n),
  });
}
