import { beginAceBatch, finishAceBatch, previewAceRows, rollbackAceBatch, saveAceChunk } from "@/lib/ace/store";
import { validateAceRows } from "@/lib/ace/validate";
import { db } from "@/lib/db/client";
import { stocks } from "@/lib/db/schema";
import { getDhanCredentials } from "@/lib/dhan/token";
import { syncStockCloses } from "@/lib/sync";
import { autoMatch, ensureFreshScrips } from "@/lib/universe/server";
import { and, inArray, isNotNull } from "drizzle-orm";

// Finishing an upload also matches its new companies to DHAN and back-fills their closes.
export const maxDuration = 300;

/**
 * The Ace upload, driven by the Admin page: preview (no writes) → begin →
 * save (one chunk of rows at a time) → finish; and rollback of the latest batch.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "unknown";
  try {
    switch (body?.action) {
      case "preview": {
        const { rows, error } = validateAceRows(body.rows);
        if (error) return Response.json({ error }, { status: 400 });
        return Response.json({ companies: await previewAceRows(rows) });
      }
      case "begin":
        return Response.json({ batchId: await beginAceBatch(String(body.fileName ?? "upload"), actor) });
      case "save": {
        const { rows, error } = validateAceRows(body.rows);
        if (error) return Response.json({ error }, { status: 400 });
        return Response.json({ companies: await saveAceChunk(Number(body.batchId), rows) });
      }
      case "finish": {
        const companies = await finishAceBatch(Number(body.batchId), actor);
        return Response.json({ companies, dhan: await matchAndBackfill(companies.filter((c) => c.newStock).map((c) => c.stockId), actor) });
      }
      case "rollback":
        return Response.json(await rollbackAceBatch(Number(body.batchId), actor));
      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** New companies from an upload: match to DHAN, then back-fill closes for those matched. */
async function matchAndBackfill(newIds: number[], actor: string) {
  if (!newIds.length) return { matched: [] as string[], unmatched: [] as string[], backfilled: 0, errors: [] as string[] };
  const errors: string[] = [];
  let matched: string[] = [];
  let unmatched: string[] = [];
  try {
    await ensureFreshScrips();
    const r = await autoMatch(actor);
    matched = r.matched;
    unmatched = r.unmatched.map((u) => u.name);
  } catch (e) {
    errors.push(`DHAN matching: ${e instanceof Error ? e.message : String(e)}`);
  }
  let backfilled = 0;
  const ready = await db.select({ id: stocks.id, sid: stocks.dhanSecurityId, name: stocks.name }).from(stocks).where(and(inArray(stocks.id, newIds), isNotNull(stocks.dhanSecurityId)));
  try {
    const c = await getDhanCredentials();
    const deadline = Date.now() + 200_000;
    for (const s of ready) {
      if (Date.now() > deadline) {
        errors.push("Time ran out — use Sync now for the rest.");
        break;
      }
      try {
        await syncStockCloses(s.id, s.sid!, c);
        backfilled++;
      } catch (e) {
        errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof Error && /DHAN (rejected|token expired)/.test(e.message)) break;
      }
    }
  } catch (e) {
    errors.push(`Closes not back-filled: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { matched, unmatched, backfilled, errors: errors.slice(0, 10) };
}
