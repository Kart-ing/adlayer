export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="wrap">
          <span className="eyebrow">
            <span className="pulse" /> The ad network for the answer layer
          </span>
          <h1 className="display">
            Advertise where agents <span className="grad-text">actually look</span>
          </h1>
          <p className="sub">
            Your customers stopped asking Google. AdLayer sells clearly-labeled sponsored placements
            inside <code>llms.txt</code> — the file agents read — enforces disclosure in code, and
            measures whether the label survives the model.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="/sponsor">
              Sponsor a placement →
            </a>
            <a className="btn btn-ghost" href="/dashboard">
              See the live data
            </a>
          </div>

          <div className="code-card" aria-hidden="true">
            <div className="bar">
              <span className="d" />
              <span className="d" />
              <span className="d" />
              <span className="name">pmweekly.example / llms.txt</span>
            </div>
            <pre>
{`# Project Management Weekly

## Tools
- [Trello](https://trello.com): kanban boards for teams
- [Linear](https://linear.app): issue tracking for software

## Sponsored
`}<span className="hl">{`- [[SPONSORED] Acme Board](https://acme.example): [SPONSORED] Kanban that stays out of your way for tiny remote teams.`}</span>{`
  [SPONSORED] This entry is a paid placement served by AdLayer.`}
            </pre>
          </div>
        </div>
      </section>

      <section className="block">
        <div className="wrap">
          <div className="section-head">
            <div className="kick">How it works</div>
            <h2 className="section-title">From creative to cited, in four steps</h2>
            <p>You bring the offer. Our agents handle review, pricing, disclosure, and measurement.</p>
          </div>
          <div className="cards c3">
            <div className="card">
              <div className="num">1</div>
              <h3>Sponsor</h3>
              <p>
                Submit your title, one-line pitch, target URL and categories. It posts to our intake
                API and enters review.
              </p>
            </div>
            <div className="card">
              <div className="num">2</div>
              <h3>Review &amp; price</h3>
              <p>
                A compliance agent runs GLiGuard + a disclosure check (missing label = hard block). A
                pricing agent sets the rate from category demand.
              </p>
            </div>
            <div className="card">
              <div className="num">3</div>
              <h3>Pay</h3>
              <p>
                Approved placements go to checkout. One Stripe link, you choose the amount, revenue is
                tracked end-to-end.
              </p>
            </div>
          </div>
          <div className="cards c3" style={{ marginTop: 18, gridTemplateColumns: "1fr" }}>
            <div className="card" style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
              <div className="num" style={{ marginBottom: 0 }}>4</div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <h3>Serve into llms.txt &amp; measure</h3>
                <p>
                  We render your disclosed block into the publisher&rsquo;s <code>llms.txt</code>, then
                  poll answer engines to prove propagation — and whether the label survived.
                </p>
              </div>
              <a className="btn btn-ghost btn-sm" href="/dashboard">
                View measurement
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="block" style={{ paddingTop: 12 }}>
        <div className="wrap">
          <div className="section-head">
            <div className="kick">The open question</div>
            <h2 className="section-title">Does the &ldquo;sponsored&rdquo; label survive the model?</h2>
            <p>Three outcomes, all publishable. We ship whichever we measure — honestly.</p>
          </div>
          <div className="cards c3">
            <div className="card outcome good">
              <h3>surfaced_labeled</h3>
              <p>Disclosure propagates. Honest agent advertising is viable.</p>
            </div>
            <div className="card outcome crit">
              <h3>surfaced_unlabeled</h3>
              <p>The model strips the label. Ad disclosure is structurally broken in the answer layer.</p>
            </div>
            <div className="card outcome neutral">
              <h3>absent</h3>
              <p><code>llms.txt</code> doesn&rsquo;t move this engine. The premise is weaker than assumed.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="block">
        <div className="wrap">
          <div className="cta-band">
            <h2>Put your offer where the answer is</h2>
            <p>Disclosed, measured, and served into the file agents actually read.</p>
            <div className="cta-row">
              <a className="btn btn-light" href="/sponsor">
                Sponsor a placement →
              </a>
              <a className="btn btn-ghost" href="/disclosure">
                Read the disclosure policy
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
