import { saveNifty500 } from "@/lib/universe/server";
import type { Nifty500Row } from "@/lib/universe/match";

/** The one-time Nifty 500 constituents upload (parsed in the browser). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { rows?: unknown; fileName?: unknown; actor?: unknown } | null;
  const rows = Array.isArray(body?.rows) ? (body.rows as Nifty500Row[]) : [];
  const ok = rows.length > 0 && rows.length <= 2000 && rows.every((r) => typeof r?.isin === "string" && /^IN[A-Z0-9]{10}$/.test(r.isin) && typeof r.symbol === "string" && typeof r.name === "string");
  if (!ok) return Response.json({ error: "Expected up to 2,000 rows with ISIN, symbol and name." }, { status: 400 });
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "unknown";
  return Response.json(await saveNifty500(rows.map((r) => ({ name: r.name.slice(0, 200), industry: r.industry ? String(r.industry).slice(0, 100) : null, symbol: r.symbol.slice(0, 40), isin: r.isin })), String(body?.fileName ?? "nifty500"), actor));
}
