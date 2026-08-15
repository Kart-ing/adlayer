import { loadState, engineKind } from "../../lib/state";
import { pct, signedPct, latency, ts, STATE_META } from "../../lib/format";
import type { PropagationCheck } from "../../lib/contract";

export const dynamic = "force-dynamic";

function StateBadge({ check }: { check: PropagationCheck }) {
  const m = STATE_META[check.state];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function ArmTable({ title, checks }: { title: string; checks: PropagationCheck[] }) {
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>query</th>
              <th>engine</th>
              <th>state</th>
              <th>latency</th>
              <th>checked</th>
              <th>cited</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c, i) => (
              <tr key={i}>
                <td>{c.query}</td>
                <td className="muted">{c.engine}</td>
                <td>
                  <StateBadge check={c} />
                </td>
                <td>{latency(c.latency_minutes)}</td>
                <td className="muted">{ts(c.checked_at)}</td>
                <td className="muted">{c.cited_urls.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function Dashboard() {
  const state = await loadState();
  const headline = state.propagation.filter((c) => c.state === "surfaced_unlabeled");
  const live = state.propagation.filter((c) => engineKind(c.engine) === "live_retrieval");
  const ingestion = state.propagation.filter((c) => engineKind(c.engine) === "ingestion");
  const terac = state.terac;

  return (
    <>
      <h1>Dashboard</h1>
      <p className="lede">
        Does the &ldquo;sponsored&rdquo; label survive the model? Live-retrieval and ingestion
        engines are reported separately — they measure different mechanisms and are never averaged.
      </p>

      {headline.length > 0 ? (
        <div className="alarm" role="alert">
          <strong>surfaced_unlabeled × {headline.length}.</strong> A live-retrieval engine surfaced
          the placement&rsquo;s copy but dropped the disclosure. In the answer layer, the ad
          disclosure did not survive the model.
        </div>
      ) : null}

      <div className="grid cols-3" style={{ marginBottom: 8 }}>
        <div className="panel">
          <div className="kpi">${(state.revenue.total_cents / 100).toFixed(2)}</div>
          <div className="kpi-label">
            revenue · {state.revenue.transaction_count} txn
          </div>
        </div>
        <div className="panel">
          <div className="kpi">{state.placements.length}</div>
          <div className="kpi-label">placements served</div>
        </div>
        <div className="panel">
          <div className="kpi" style={{ color: headline.length ? "var(--red)" : "var(--fg)" }}>
            {headline.length}
          </div>
          <div className="kpi-label">surfaced_unlabeled</div>
        </div>
      </div>

      {state.placements.map((p) => {
        const liveP = live.filter((c) => c.placement_id === p.id);
        const ingP = ingestion.filter((c) => c.placement_id === p.id);
        const creative = state.creatives.find((c) => c.id === p.creative_id);
        return (
          <section key={p.id}>
            <h2>
              placement {p.id} · {creative?.title ?? p.creative_id} · served {ts(p.served_at)}
            </h2>
            <ArmTable title="Live retrieval (fetches at query time)" checks={liveP} />
            <ArmTable title="Ingestion (index refresh) — control arm" checks={ingP} />
          </section>
        );
      })}

      {terac ? (
        <section>
          <h2>Terac trust study — predicted vs actual ({terac.after.variant} arm)</h2>
          <div className="panel">
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>metric</th>
                    <th>predicted (before)</th>
                    <th>actual (after)</th>
                    <th>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>would still trust</td>
                    <td>{pct(terac.before.trust_rate)}</td>
                    <td>{pct(terac.after.trust_rate)}</td>
                    <td className={terac.trust_delta < 0 ? "delta-neg" : "delta-pos"}>
                      {signedPct(terac.trust_delta)}
                    </td>
                  </tr>
                  <tr>
                    <td>recognized as an ad</td>
                    <td>{pct(terac.before.ad_recognition_rate)}</td>
                    <td>{pct(terac.after.ad_recognition_rate)}</td>
                    <td className={terac.recognition_delta < 0 ? "delta-neg" : "delta-pos"}>
                      {signedPct(terac.recognition_delta)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginBottom: 4 }}>
              n = {terac.after.n_responses} · after: {ts(terac.after.ran_at)}
            </p>
            <div className="notice">
              <strong>Format agent decision.</strong> {terac.change_made}
            </div>
          </div>
        </section>
      ) : null}

      <section>
        <h2>Creatives &amp; compliance</h2>
        <div className="panel scroll-x">
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>title</th>
                <th>status</th>
                <th>compliance</th>
              </tr>
            </thead>
            <tbody>
              {state.creatives.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{c.id}</td>
                  <td>{c.title}</td>
                  <td>
                    <span
                      className="badge"
                      style={{ color: c.status === "blocked" ? "var(--red)" : undefined }}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="muted">{c.review ? c.review.rationale : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
