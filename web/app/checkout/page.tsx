import { loadState } from "../../lib/state";

export const dynamic = "force-dynamic";

export default async function Checkout() {
  const link = process.env.STRIPE_PAYMENT_LINK?.trim();
  const state = await loadState().catch(() => null);
  const price = state?.placements[0]?.price_cents ?? 2000;

  return (
    <>
      <p className="kicker">Money</p>
      <h1>Checkout</h1>
      <p className="lede">
        One Payment Link, used all day, with &ldquo;customer chooses price&rdquo;. Organizers track
        revenue through the same link.
      </p>

      <div className="panel" style={{ maxWidth: 540 }}>
        <div className="stat" style={{ border: "none", padding: 0, background: "none" }}>
          <div className="stat-label">placement</div>
          <div style={{ margin: "6px 0 16px" }}>
            Sponsored entry in <code>pmweekly.example/llms.txt</code>
          </div>
          <div className="stat-label">suggested price</div>
          <div className="stat-num" style={{ marginTop: 4 }}>
            ${(price / 100).toFixed(2)}
          </div>
        </div>

        {link ? (
          <p>
            <a className="btn" href={link} target="_blank" rel="noopener noreferrer">
              Pay with Stripe →
            </a>
          </p>
        ) : (
          <div className="notice warn" role="status" style={{ marginTop: 18 }}>
            <strong>Checkout not configured.</strong> No <code>STRIPE_PAYMENT_LINK</code> is set in
            this environment, so there is no live payment link to send you to. This is intentionally
            not a fake success screen — set the env var to enable real checkout.
          </div>
        )}
      </div>

      <p className="faint" style={{ marginTop: 16, fontSize: 12.5 }}>
        Payments settle to a personal Stripe account; organizers receive a read-only <code>rk_</code>{" "}
        key (Balance + Charges = Read) — never an <code>sk_</code>.
      </p>
    </>
  );
}
