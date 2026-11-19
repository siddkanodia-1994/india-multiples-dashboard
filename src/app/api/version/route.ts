import { getVersion } from "@/lib/workspace/server";

/** The 30-s change check: one number that moves whenever anyone edits. */
export async function GET() {
  return Response.json({ version: await getVersion() });
}
