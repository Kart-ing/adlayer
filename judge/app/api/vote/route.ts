import { NextResponse } from "next/server";
import { fromReferer, reconcile, type Attribution } from "../../../lib/attribution";
import { appendSubmission, type StoredSubmission } from "../../../lib/store";
import { VARIANT_ORDER, type Variant } from "../../../lib/spec";

export const runtime = "nodejs";

const CHOICES = new Set(["Yes", "No", "Unsure"]);

interface Body {
  submissionId?: string | null;
  taskId?: string | null;
  variant?: string;
  trust?: string;
  ad_recognition?: string;
  verbatim?: string;
}

export async function POST(req: Request) {
  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!b.variant || !VARIANT_ORDER.includes(b.variant as Variant)) {
    return NextResponse.json({ ok: false, error: "Unknown study arm." }, { status: 400 });
  }
  if (!b.trust || !CHOICES.has(b.trust) || !b.ad_recognition || !CHOICES.has(b.ad_recognition)) {
    return NextResponse.json({ ok: false, error: "Please answer both questions." }, { status: 400 });
  }

  // Attribution: trust the body, fall back to the Referer (svg-arena pattern).
  const primary: Attribution = {
    submissionId: b.submissionId ?? null,
    taskId: b.taskId ?? null,
  };
  const attr = reconcile(primary, fromReferer(req.headers.get("referer")));

  const sub: StoredSubmission = {
    submissionId: attr.submissionId ?? "anon",
    taskId: attr.taskId,
    variant: b.variant as Variant,
    trust: b.trust as StoredSubmission["trust"],
    ad_recognition: b.ad_recognition as StoredSubmission["ad_recognition"],
    verbatim: b.verbatim?.trim() || undefined,
    recorded_at: new Date().toISOString(),
  };

  try {
    await appendSubmission(sub);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Could not record response: ${String(err)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
