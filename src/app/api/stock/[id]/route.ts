import { applyStockOp, type StockOp } from "@/lib/stock-ops";
import { OpError } from "@/lib/workspace/server";

/** One edit to a stock's shared facts: `{ actor, ...op }`. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as (StockOp & { actor?: string }) | null;
  if (!body || typeof body.op !== "string") return Response.json({ error: "Bad request." }, { status: 400 });
  try {
    await applyStockOp(Number(id), body, body.actor);
  } catch (e) {
    if (e instanceof OpError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  return Response.json({ ok: true });
}
