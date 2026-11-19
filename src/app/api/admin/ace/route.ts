import { beginAceBatch, finishAceBatch, previewAceRows, rollbackAceBatch, saveAceChunk } from "@/lib/ace/store";
import { validateAceRows } from "@/lib/ace/validate";

export const maxDuration = 60;

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
      case "finish":
        return Response.json({ companies: await finishAceBatch(Number(body.batchId), actor) });
      case "rollback":
        return Response.json(await rollbackAceBatch(Number(body.batchId), actor));
      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
