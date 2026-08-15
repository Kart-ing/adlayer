import { DISCLOSURE_TAG, DISCLOSURE_NOTICE } from "../../lib/contract";
import { previewBlock } from "../../lib/render-preview";

export default function Disclosure() {
  const example = previewBlock(
    "Acme Board",
    "Kanban that stays out of your way for tiny remote teams.",
    "https://acme.example",
  );
  return (
    <div className="page narrow">
      <div className="kick">Disclosed by design</div>
      <h1 className="title">Disclosure policy</h1>
      <p className="lede">
        Disclosed paid placement is advertising. Undisclosed content engineered to steer agents is
        prompt injection. AdLayer builds the first and not the second.
      </p>

      <h2 className="sec">The rule</h2>
      <div className="panel">
        <p>
          Every block AdLayer serves into a publisher&rsquo;s <code>llms.txt</code> carries the tag{" "}
          <code>{DISCLOSURE_TAG}</code> and the disclosure notice below. The invariant{" "}
          <code>assertDisclosed()</code> throws before any write, and there is deliberately no flag
          that disables it.
        </p>
        <div className="notice">{DISCLOSURE_NOTICE}</div>
      </div>

      <h2 className="sec">The exact block format</h2>
      <p className="muted">
        This is the byte-for-byte shape written to a publisher&rsquo;s file. Measurement string-matches
        against it to tell propagation from organic presence.
      </p>
      <pre className="mono-block">{example}</pre>

      <h2 className="sec">What we measure after serving</h2>
      <ul className="tight">
        <li>
          <strong>surfaced_labeled</strong> — the placement propagated and the disclosure survived
          the model.
        </li>
        <li>
          <strong>surfaced_unlabeled</strong> — the placement propagated but the model dropped the
          disclosure. We report this honestly; it is the finding, not a failure to hide.
        </li>
        <li>
          <strong>cited_unattributed</strong> — the advertiser is present but the text did not come
          from our disclosed block.
        </li>
        <li>
          <strong>absent</strong> — the engine has not surfaced the advertiser for this query.
        </li>
      </ul>

      <h2 className="sec">Compliance veto</h2>
      <p>
        A creative that would ship without disclosure, or that trips GLiGuard moderation, is{" "}
        <strong>blocked</strong> before it can serve. The veto is a hard fail, not a warning.
      </p>
    </div>
  );
}
