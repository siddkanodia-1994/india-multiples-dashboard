import { db } from "@/lib/db/client";
import { activityLog } from "@/lib/db/schema";
import { testDhanCredentials } from "@/lib/dhan/client";
import { saveDhanCredentials } from "@/lib/dhan/token";

/** Saves the shared DHAN pair after one test quote. The token is write-only and never logged or echoed. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; token?: unknown; actor?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!/^\d{5,15}$/.test(clientId)) return Response.json({ error: "The client ID is a number, e.g. 1100012345." }, { status: 400 });
  if (token.split(".").length !== 3) return Response.json({ error: "That doesn't look like a DHAN access token (a long text in three dot-separated parts)." }, { status: 400 });
  const test = await testDhanCredentials({ clientId, token });
  if (!test.ok) return Response.json({ error: test.message }, { status: 400 });
  await saveDhanCredentials({ clientId, token });
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "unknown";
  await db.insert(activityLog).values({ profile: actor, action: "settings", entity: "dhan", entityId: "", summary: `Updated the DHAN client ID and token (client …${clientId.slice(-4)})` });
  return Response.json({ ok: true });
}
