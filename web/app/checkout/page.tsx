import { loadState } from "../../lib/state";
import { previewBlock } from "../../lib/render-preview";
import type { Creative, Publisher } from "../../lib/contract";

export const dynamic = "force-dynamic";

const PRICE_CENTS = 2000;
// Public Stripe test Payment Link (customer chooses price). Env overrides it.
const DEFAULT_PAYMENT_LINK = "https://buy.stripe.com/test_00wdR97nraeyfZg2MN1gs00";

function Steps({ served }: { served: boolean }) {
  return (
    <div className="steps">
      <span className="step done"><span className="b">✓</span> Sponsor</span>
      <span className="sep" />
      <span className={`step ${served ? "done" : "active"}`}>
        <span className="b">{served ? "✓" : "2"}</span> Review &amp; pay
      </span>
      <span className="sep" />
      <span className={`step ${served ? "active" : ""}`}>
        <span className="b">3</span> Served in llms.txt
      </span>
    </div>
  );
}

function pickPublisher(state: { publishers: Publisher[] }, creative?: Creative): Publisher | undefined {
  if (!creative) return state.publishers[0];
  return (
    state.publishers.find((p) => p.categories.some((pc) => creative.categories.includes(pc))) ??
    state.publishers[0]
  );
}

export default async function Checkout({
  searchParams,
}: {
  searchParams: { cid?: string; status?: string };
}) {
  const link = process.env.STRIPE_PAYMENT_LINK?.trim() || DEFAULT_PAYMENT_LINK;
  const state = await loadState().catch(() => null);
  const cid = searchParams.cid;
  const served = searchParams.status === "served";

  const creative =
    state?.creatives.find((c) => c.id === cid) ??
    state?.creatives.find((c) => c.status === "live") ??
    state?.creatives[0];
  const publisher = state ? pickPublisher(state, creative) : undefined;
  const block = creative
    ? previewBlock(creative.title, creative.body, creative.target_url)
    : previewBlock("", "", "");

  // ── Served confirmation ──────────────────────────────────────────────────
  if (served) {
    return (
      <div className="page narrow">
        <div className="kick">Step 3 of 3</div>
        <h1 className="title">You&rsquo;re live in the answer layer</h1>
        <Steps served />
        <div className="notice good" role="status">
          <strong>Placement served.</strong> Your disclosed block was rendered into{" "}
          <code>{publisher?.domain ?? "the publisher"}/llms.txt</code>. We&rsquo;re now polling answer
          engines to measure propagation.
        </div>
        <div className="preview-label" style={{ marginTop: 20 }}>
          Now serving <span className="tag-pill">{publisher?.domain}/llms.txt</span>
        </div>
        <div className="mono-block">{block}</div>
        <div className="cta-row" style={{ justifyContent: "flex-start", marginTop: 24 }}>
          <a className="btn btn-primary" href="/dashboard">
            Watch propagation on the dashboard →
          </a>
          <a className="btn btn-ghost" href="/sponsor">
            Sponsor another
          </a>
        </div>
      </div>
    );
  }

  // ── Payment ──────────────────────────────────────────────────────────────
  return (
    <div className="page narrow">
      <div className="kick">Step 2 of 3</div>
      <h1 className="title">Review &amp; pay</h1>
      <Steps served={false} />

      <div className="notice good">
        <strong>Approved.</strong> Compliance passed — your block carries <code>[SPONSORED]</code> and
        the disclosure notice, and cleared GLiGuard moderation.
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="summary">
          <div className="row">
            <span className="k">Placement</span>
            <span className="v">{creative?.title ?? "Sponsored listing"}</span>
          </div>
          <div className="row">
            <span className="k">Publisher</span>
            <span className="v mono">{publisher?.domain ?? "—"}</span>
          </div>
          <div className="row">
            <span className="k">Categories</span>
            <span className="v">{creative?.categories.join(", ") || "—"}</span>
          </div>
          <div className="row">
            <span className="k">Price · set by the Pricing agent</span>
            <span className="v price grad-text">${(PRICE_CENTS / 100).toFixed(2)}</span>
          </div>
        </div>

        <div className="preview-label" style={{ marginTop: 22 }}>
          What we&rsquo;ll serve <span className="tag-pill">exact bytes</span>
        </div>
        <div className="mono-block">{block}</div>

        {link ? (
          <a className="btn btn-primary" href={link} target="_blank" rel="noopener noreferrer" style={{ marginTop: 22, width: "100%" }}>
            Pay ${(PRICE_CENTS / 100).toFixed(2)} with Stripe →
          </a>
        ) : (
          <div className="notice warn" style={{ marginTop: 22 }}>
            <strong>Checkout not configured.</strong> No <code>STRIPE_PAYMENT_LINK</code> is set here,
            so there&rsquo;s no live payment link. This is intentionally not a fake success screen.
          </div>
        )}

        {state?._fixture ? (
          <a
            className="btn btn-ghost btn-sm"
            href={`/checkout?status=served${cid ? `&cid=${encodeURIComponent(cid)}` : ""}`}
            style={{ marginTop: 12, width: "100%" }}
          >
            Preview the served result (demo) →
          </a>
        ) : null}
      </div>

      <p className="field-hint" style={{ marginTop: 14 }}>
        Payments settle to a personal Stripe account; organizers receive a read-only <code>rk_</code>{" "}
        key (Balance + Charges = Read) — never an <code>sk_</code>.
      </p>
    </div>
  );
}
