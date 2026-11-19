import type { NextRequest } from "next/server";
import { getTabData } from "@/lib/stock-data";

/** ?ids=1,2,3&basis=C → each stock's daily multiples and held totals, with today's DHAN quote folded in. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const ids = (q.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 60);
  const basis = q.get("basis") === "S" ? "S" : "C";
  return Response.json(await getTabData(ids, basis));
}
