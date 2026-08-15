import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { assertDisclosed } from "../../../lib/contract";
import { previewBlock } from "../../../lib/render-preview";
import type { AdLayerState, Creative } from "../../../lib/contract";

export const runtime = "nodejs";

const STATE_PATH = path.join(process.cwd(), "data", "state.json");

interface Body {
  title?: string;
  body?: string;
  target_url?: string;
  categories?: string[];
}

export async function POST(req: Request) {
  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const title = (payload.title ?? "").trim();
  const body = (payload.body ?? "").trim();
  const target_url = (payload.target_url ?? "").trim();
  const categories = (payload.categories ?? []).map((c) => c.trim()).filter(Boolean);

  if (!title || !body || !target_url) {
    return NextResponse.json(
      { ok: false, error: "Title, body, and target URL are required." },
      { status: 400 },
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(target_url);
  } catch {
    return NextResponse.json({ ok: false, error: "Target URL must be a valid URL." }, { status: 400 });
  }

  // Sanity: the block we would generate must carry the disclosure. This can never
  // fail for previewBlock, but we assert it so the intake path is honest by construction.
  assertDisclosed(previewBlock(title, body, target_url));

  const creative: Creative = {
    id: `cr_${randomUUID().slice(0, 8)}`,
    advertiser_id: `adv_selfserve_${randomUUID().slice(0, 6)}`,
    title,
    body,
    target_url,
    categories,
    status: "pending_review",
    review: null,
  };

  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as AdLayerState;
    state.creatives.push(creative);
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Could not persist creative: ${String(err)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id: creative.id, status: creative.status });
}
