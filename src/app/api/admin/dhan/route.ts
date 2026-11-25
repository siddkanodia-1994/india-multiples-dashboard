import { after } from "next/server";
import { db } from "@/lib/db/client";
import { activityLog } from "@/lib/db/schema";
import { testDhanCredentials } from "@/lib/dhan/client";
import { saveDhanCredentials, tokenClaims } from "@/lib/dhan/token";
import { syncCloses } from "@/lib/sync";

export const maxDuration = 300;

/**
 * Saves the shared DHAN pair after one test quote. The client ID is read from
 * the token itself (DHAN tokens carry it); a typed one is only needed for a
 * token that doesn't. The token is write-only and never logged or echoed.
 *
 * A new token then back-fills, in the background, every close missed while
 * the old one was missing or expired: each stock is pulled from the day after
 * its last saved close (lib/sync.ts), however long the gap.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; token?: unknown; actor?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const typed = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  if (token.split(".").length !== 3) return Response.json({ error: "That doesn't look like a DHAN access token (a long text in three dot-separated parts)." }, { status: 400 });
  const fromToken = tokenClaims(token).clientId;
  if (fromToken && typed && typed !== fromToken) return Response.json({ error: `This token was issued to client ID …${fromToken.slice(-4)}, not …${typed.slice(-4)}. Leave the client ID blank to use the token's own.` }, { status: 400 });
  const clientId = fromToken ?? typed;
  if (!clientId) return Response.json({ error: "This token doesn't name its client ID — type the client ID too.", needClientId: true }, { status: 400 });
  if (!/^\d{5,15}$/.test(clientId)) return Response.json({ error: "The client ID is a number, e.g. 1100012345." }, { status: 400 });
  const test = await testDhanCredentials({ clientId, token });
  if (!test.ok) return Response.json({ error: test.message }, { status: 400 });
  await saveDhanCredentials({ clientId, token });
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "unknown";
  await db.insert(activityLog).values({ profile: actor, action: "settings", entity: "dhan", entityId: "", summary: `Updated the DHAN token (client …${clientId.slice(-4)}${fromToken ? ", read from the token" : ""})` });
  after(async () => {
    try {
      const p = await syncCloses(Date.now() + 240_000, `${actor} (new DHAN token)`, true);
      // Not finished in time: the daily job's route carries on from the saved cursor.
      if (!p.done && process.env.CRON_SECRET) await fetch(new URL("/api/cron/sync", request.url), { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    } catch {
      // the error is in sync_state, which the Admin page shows
    }
  });
  return Response.json({ ok: true, clientId: `…${clientId.slice(-4)}`, fromToken: Boolean(fromToken) });
}
