import { readSubmissionsJsonl } from "../../../lib/store";

export const runtime = "nodejs";
// Must read the JSONL fresh on every request — never prerender/cache this route.
export const dynamic = "force-dynamic";

/**
 * JSONL export — one submission per line, exactly the shape
 * src/prove/terac.ts `aggregateSubmissions` consumes. This is the seam that
 * turns real human judgments into the Terac before/after.
 */
export async function GET() {
  const body = await readSubmissionsJsonl();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="submissions.jsonl"',
      "Cache-Control": "no-store",
    },
  });
}
