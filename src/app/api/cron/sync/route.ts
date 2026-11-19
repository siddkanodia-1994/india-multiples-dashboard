import { after, type NextRequest } from "next/server";
import { purgeBin, syncCloses } from "@/lib/sync";

export const maxDuration = 300;

/**
 * The daily job (Vercel Cron, 7:05 PM IST): DHAN closes for every matched
 * stock, in chunks — if time runs out it calls itself to carry on — then the
 * 30-day purge of Recently removed.
 */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const progress = await syncCloses(Date.now() + 240_000);
  if (!progress.done) {
    const next = new URL(request.url);
    after(() => fetch(next, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }).then(() => undefined));
    return Response.json({ ...progress, continuing: true });
  }
  return Response.json({ ...progress, purged: await purgeBin() });
}
