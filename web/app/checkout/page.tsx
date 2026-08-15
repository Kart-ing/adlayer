import { loadState } from "../../lib/state";

export const dynamic = "force-dynamic";

export default async function Checkout() {
  const link = process.env.STRIPE_PAYMENT_LINK?.trim();
  const state = await loadState().catch(() => null);
  const price = state?.placements[0]?.price_cents ?? 2000;

  return (
    <>
      <h1>Checkout</h1>
      <p className="lede">
        One Payment Link, used all day, with &ldquo;customer chooses price&rdquo;. Organizers track
        revenue through it.
      </p>

      <div className="panel" style={{ maxWidth: 520 }}>
        <div className="kpi-label">placement</div>
        <div style={{ margin: "4px 0 12px" }}>
          Sponsored entry in <code>pmweekly.example/llms.txt</code>
        </div>
        <div className="kpi-label">suggested price</div>
        <div className="kpi">${(price / 100).toFixed(2)}</div>

        {link ? (
          <p>
            <a className="btn" href={link} target="_blank" rel="noopener noreferrer">
              Pay with Stripe →
            </a>
          </p>
        ) : (
          <div className="notice warn" role="status" style={{ marginTop: 16 }}>
            <strong>Checkout not configured.</strong> No <code>STRIPE_PAYMENT_LINK</code> is set in
            this environment, so there is no live payment link to send you to. This is intentionally
            not a fake success screen — set the env var to enable real checkout.
          </div>
        )}
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        Payments settle to a personal Stripe account; organizers receive a read-only{" "}
        <code>rk_</code> key (Balance + Charges = Read) — never an <code>sk_</code>.
      </p>
    </>
  );
}
