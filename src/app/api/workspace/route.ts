import { applyOp, getWorkspace, OpError } from "@/lib/workspace/server";
import type { WorkspaceOp } from "@/lib/workspace/types";

export async function GET() {
  return Response.json(await getWorkspace());
}

/** One edit: `{ actor, ...op }`. Answers with the fresh workspace, or 400 with the reason. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as (WorkspaceOp & { actor?: string }) | null;
  if (!body || typeof body.op !== "string") return Response.json({ error: "Bad request." }, { status: 400 });
  try {
    await applyOp(body, body.actor);
  } catch (e) {
    if (e instanceof OpError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  return Response.json(await getWorkspace());
}
