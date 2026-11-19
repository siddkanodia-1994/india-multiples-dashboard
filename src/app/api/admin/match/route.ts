import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { stocks } from "@/lib/db/schema";
import { getDhanCredentials } from "@/lib/dhan/token";
import { syncStockCloses } from "@/lib/sync";
import { applyMatch, autoMatch, candidatesFor, refreshDhanScrips, searchScrips } from "@/lib/universe/server";

export const maxDuration = 60;

/** Matching Ace stocks to DHAN security IDs; a new match back-fills that stock's closes straight away. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "unknown";
  try {
    switch (body?.action) {
      case "refresh":
        return Response.json({ scrips: await refreshDhanScrips() });
      case "auto":
        return Response.json(await autoMatch(actor));
      case "candidates": {
        const [s] = await db.select().from(stocks).where(eq(stocks.id, Number(body.stockId)));
        return Response.json({ candidates: s ? await candidatesFor(s.aceName) : [] });
      }
      case "search":
        return Response.json({ candidates: await searchScrips(String(body.q ?? "")) });
      case "apply": {
        const stockId = Number(body.stockId);
        const securityId = Number(body.securityId);
        await applyMatch(stockId, securityId, actor);
        let backfill: string;
        try {
          const days = await syncStockCloses(stockId, securityId, await getDhanCredentials());
          backfill = `${days} daily closes back-filled.`;
        } catch (e) {
          backfill = `Closes not back-filled yet: ${e instanceof Error ? e.message : String(e)}`;
        }
        return Response.json({ ok: true, backfill });
      }
      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
