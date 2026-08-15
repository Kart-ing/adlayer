import { loadState, engineKind } from "../../lib/state";
import { pct, signedPct, ts } from "../../lib/format";
import type { PropagationCheck, PropagationState } from "../../lib/contract";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<PropagationState, string> = {
  absent: "absent",
  surfaced_labeled: "surfaced · labeled",
  surfaced_unlabeled: "surfaced · UNLABELED",
  cited_unattributed: "cited · unattributed",
};
const STATE_CLS: Record<PropagationState, string> = {
  absent: "st-absent",
  surfaced_labeled: "st-labeled",
  surfaced_unlabeled: "st-unlabeled",
  cited_unattributed: "st-cited",
};

function Chip({ state }: { state: PropagationState }) {
  return (
    <span className={`chip ${STATE_CLS[state]}`}>
      <span className="cd" />
      {STATE_LABEL[state]}
    </span>
  );
}

function Lat({ minutes, max, crit }: { minutes: number | null; max: number; crit: boolean }) {
  if (minutes === null) {
    return (
      <div className="lat none" title="not surfaced">
        <div className="track" />
        <span className="val">—</span>
      </div>
    );
  }
  const w = max > 0 ? Math.max(8, Math.round((minutes / max) * 100)) : 0;
  return (
    <div className={`lat ${crit ? "crit" : ""}`} title={`${minutes} minutes from serve to first observation`}>
      <div className="track">
        <div className="fill" style={{ width: `${w}%` }} />
      </div>
      <span className="val">{minutes}m</span>
    </div>
  );
}

function CmpRow({ name, before, after }: { name: string; before: number; after: number }) {
  const delta = after - before;
  return (
    <div className="cmp-row">
      <div className="name">{name}</div>
      <div className="cmp-bars">
        <div className="cmp-line pred">
          <span className="tag">predicted</span>
          <div className="track">
            <div className="fill" style={{ width: `${Math.round(before * 100)}%` }} />
          </div>
          <span className="num">{pct(before)}</span>
        </div>
        <div className="cmp-line act">
          <span className="tag">actual</span>
          <div className="track">
            <div className="fill" style={{ width: `${Math.round(after * 100)}%` }} />
          </div>
          <span className="num">{pct(after)}</span>
        </div>
      </div>
      <div className={`delta ${delta >= 0 ? "up" : "down"}`}>{signedPct(delta)}</div>
    </div>
  );
}

export default async function Dashboard() {
  const state = await loadState();
  const checks = state.propagation;
  const headline = checks.filter((c) => c.state === "surfaced_unlabeled");
  const terac = state.terac;

  const queries = [...new Set(checks.map((c) => c.query))];
  const engines = [...new Set(checks.map((c) => c.engine))];
  const liveEngines = engines.filter((e) => engineKind(e) === "live_retrieval");
  const ingEngines = engines.filter((e) => engineKind(e) === "ingestion");
  const orderedEngines = [...liveEngines, ...ingEngines];
  const maxLat = Math.max(1, ...checks.map((c) => c.latency_minutes ?? 0));
  const fastest = checks
    .map((c) => c.latency_minutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b)[0];
  const cell = (q: string, e: string): PropagationCheck | undefined =>
    checks.find((c) => c.query === q && c.engine === e);

  return (
    <div className="page">
      <p className="kick">Propagation · answer layer</p>
      <h1 className="title">Does the &ldquo;sponsored&rdquo; label survive the model?</h1>
      <p className="lede">
        We serve a disclosed placement into a publisher&rsquo;s <code>llms.txt</code>, then poll answer
        engines. Live-retrieval and ingestion engines are reported separately — they measure different
        mechanisms and are never averaged.
      </p>

      {headline.length > 0 ? (
        <div className="alarm" role="alert">
          <span className="glyph">surfaced_unlabeled ×{headline.length}</span>
          <span className="body">
            A live-retrieval engine surfaced the placement&rsquo;s exact copy but <strong>dropped the
            disclosure</strong>. In the answer layer, the ad label did not survive the model — the
            headline finding.
          </span>
        </div>
      ) : null}

      <div className="stat-grid" style={{ marginTop: 14 }}>
        <div className="stat is-good">
          <div className="stat-num">${(state.revenue.total_cents / 100).toFixed(2)}</div>
          <div className="stat-label">revenue</div>
          <div className="stat-sub">{state.revenue.transaction_count} real charge(s)</div>
        </div>
        <div className="stat">
          <div className="stat-num">{state.placements.length}</div>
          <div className="stat-label">placements served</div>
          <div className="stat-sub">{checks.length} propagation checks</div>
        </div>
        <div className="stat">
          <div className="stat-num">{fastest === undefined ? "—" : `${fastest}m`}</div>
          <div className="stat-label">fastest surface</div>
          <div className="stat-sub">live retrieval, from serve</div>
        </div>
        <div className={`stat ${headline.length ? "is-crit" : ""}`}>
          <div className="stat-num">{headline.length}</div>
          <div className="stat-label">surfaced_unlabeled</div>
          <div className="stat-sub">label stripped by the model</div>
        </div>
      </div>

      {state.placements.map((p) => {
        const creative = state.creatives.find((c) => c.id === p.creative_id);
        return (
          <section key={p.id}>
            <h2 className="sec">
              placement · {creative?.title ?? p.creative_id} → {p.publisher_id} · served {ts(p.served_at)}
            </h2>
            <div className="legend">
              <span className="chip st-labeled"><span className="cd" />surfaced · labeled</span>
              <span className="chip st-unlabeled"><span className="cd" />surfaced · UNLABELED</span>
              <span className="chip st-cited"><span className="cd" />cited · unattributed</span>
              <span className="chip st-absent"><span className="cd" />absent</span>
            </div>
            <div className="panel scroll-x" style={{ padding: 0 }}>
              <table className="matrix">
                <thead>
                  <tr>
                    <th rowSpan={2}>query</th>
                    {liveEngines.length ? (
                      <th className="grp live" colSpan={liveEngines.length}>
                        ▸ Live retrieval (fetches at query time)
                      </th>
                    ) : null}
                    {ingEngines.length ? (
                      <th className="grp" colSpan={ingEngines.length}>
                        Ingestion · control arm (index refresh)
                      </th>
                    ) : null}
                  </tr>
                  <tr>
                    {orderedEngines.map((e) => (
                      <th key={e}>{e}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queries.map((q) => (
                    <tr key={q}>
                      <td className="q">{q}</td>
                      {orderedEngines.map((e) => {
                        const c = cell(q, e);
                        return (
                          <td key={e}>
                            {c ? (
                              <div className="cell">
                                <Chip state={c.state} />
                                <Lat
                                  minutes={c.latency_minutes}
                                  max={maxLat}
                                  crit={c.state === "surfaced_unlabeled"}
                                />
                              </div>
                            ) : (
                              <span className="faint">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {terac ? (
        <section>
          <h2 className="sec">Terac trust study · predicted → actual ({terac.after.variant} arm)</h2>
          <div className="panel">
            <div className="cmp">
              <CmpRow name="Would still trust" before={terac.before.trust_rate} after={terac.after.trust_rate} />
              <CmpRow
                name="Recognized as an ad"
                before={terac.before.ad_recognition_rate}
                after={terac.after.ad_recognition_rate}
              />
            </div>
            <p className="faint" style={{ margin: "14px 0 0", fontSize: 12 }}>
              n = {terac.after.n_responses} real respondents · before = frozen model prediction · after{" "}
              {ts(terac.after.ran_at)}
            </p>
            <div className="callout">
              <div className="lbl">Format agent decision</div>
              {terac.change_made}
            </div>
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="sec">Creatives &amp; compliance</h2>
        <div className="panel scroll-x" style={{ padding: 0 }}>
          <table className="data">
            <thead>
              <tr>
                <th>id</th>
                <th>title</th>
                <th>status</th>
                <th>compliance rationale</th>
              </tr>
            </thead>
            <tbody>
              {state.creatives.map((c) => (
                <tr key={c.id}>
                  <td className="id">{c.id}</td>
                  <td>{c.title}</td>
                  <td>
                    <span
                      className={`badge ${
                        c.status === "blocked" ? "blocked" : c.status === "live" ? "live" : c.status === "pending_review" ? "pending" : ""
                      }`}
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
    </div>
  );
}
