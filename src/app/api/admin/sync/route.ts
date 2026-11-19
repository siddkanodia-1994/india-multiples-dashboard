import { syncCloses } from "@/lib/sync";

export const maxDuration = 60;

/** "Sync now": one chunk of the close sync; the Admin page calls again until done. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { restart?: unknown; actor?: unknown } | null;
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 60) : "unknown";
  try {
    return Response.json(await syncCloses(Date.now() + 45_000, `${actor} (Sync now)`, body?.restart === true));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
