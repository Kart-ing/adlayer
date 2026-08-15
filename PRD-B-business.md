# PRD-B — THE BUSINESS

**Own demand, proof, and money. Answer the question nobody has answered: does the "sponsored" label survive the model?**

Read `src/contract.ts` first. It is law. Emit those shapes exactly.

You consume `placements[]` from Person A. You never write to `src/serve/`.

---

## 1. What you own

```
src/prove/measure.ts               propagation polling
src/prove/classify-propagation.ts  the analytical core
src/prove/terac.ts                 the mandatory human study
src/prove/study-design.ts          study wording
web/                               advertiser self-serve, checkout, dashboard
docs/TERAC.md                      integration notes
```

Do not touch `src/serve/` or `publishers/`.

## 2. Deliverables

### 2.1 Measurement — `measure.ts`

`checkPropagation(placement, queries, flags): Promise<PropagationCheck[]>`

**Reuse `engine/retrieve/`. Do not rewrite it.** It already queries answer engines and captures cited URLs, it already caches to disk, and it already degrades on a missing key. Port nothing; import it.

Respect `RunFlags.liveMeasure`. When false, read fixtures. Cache every live response — venue wifi will fail, and the demo must re-run offline.

Poll on a schedule from 13:00. Latency is the finding; you cannot reconstruct it after the fact.

### 2.2 Classifier — `classify-propagation.ts`

`classify(answerText, citedUrls, placement): PropagationState`

This is the most important function in the project. Four states:

| State | Meaning |
|---|---|
| `absent` | Advertiser not present |
| `surfaced_labeled` | Present, and the disclosure survived |
| `surfaced_unlabeled` | Present, disclosure stripped — **the headline finding** |
| `cited_unattributed` | Domain cited, but text did not come from our block |

**Be ruthless about false positives.** An advertiser can surface for ordinary organic reasons; that is not propagation. Use the exact `rendered_block` text and `ad_id` as provenance evidence. Establish a pre-serve baseline for every query so you can tell "was already there" from "appeared because of us" — without that baseline the whole result is worthless.

Document the matching heuristic and its limits in comments. If evidence is weak, the classifier says weak. A negative result reported honestly beats a positive result that does not hold up to a judge's question.

### 2.3 Terac — mandatory, gates eligibility

Research first, and write `docs/TERAC.md`: exact endpoints or MCP tools, auth, response shape, realistic panel latency, cost. Mark confirmed vs assumed. Latency determines whether round 2 is possible at all.

**Study design.** Show real people an assistant answer containing a paid placement, in three variants: `labeled`, `unlabeled`, `labeled_prominent`. Measure:

1. Would you still trust this assistant?
2. Did you recognize that result as an ad?

Wording must be neutral. Judges include PMs from DeepMind and Stripe — a leading question gets caught. Target General Population per the guidebook.

`runStudy(variant, flags)` respects `LIVE_STUDY`. **Never fabricate results.** Fixture data must be self-evidently marked as fixture in the returned object.

Round 1 by 14:30. Change the ad format based on what round 1 says. Round 2 measures the change. That is the before/after we ship.

### 2.4 Web — `web/`

| Route | Purpose |
|---|---|
| `/` | Advertiser self-serve: title, body, target URL, categories → `pending_review` |
| `/checkout` | Stripe Payment Link from env. Absent env → clearly-marked "not configured", never a fake success |
| `/dashboard` | **The demo.** Per placement: served_at, state per query/engine, latency in minutes. `surfaced_unlabeled` rendered alarming |
| `/disclosure` | Public disclosure policy + the exact block format. A trust artifact; judges will read it |

Reads `AdLayerState` from JSON. Renders fully with zero env vars set. Fixtures visually marked as fixtures.

Design: dense, technical, information-first — an ad-tech control plane, not a marketing site. Monospace for data. No gradient hero, no emoji.

Replay QA crawls this. Real form labels, sane contrast, keyboard navigable — that is the $1,000.

### 2.5 Stripe

Payment Link with "Customer chooses price". **Same link all day** — a new one mid-event breaks organizers' revenue tracking. Restricted key `rk_` (Balance=Read, Charges=Read, all else None) goes to organizers. Never an `sk_`.

## 3. Acceptance

- [ ] `npx tsc --noEmit` clean
- [ ] Runs fully offline with `LIVE_MEASURE=0`
- [ ] Tests for all four classification states **plus** the false-positive case: advertiser cited organically before serve must classify `cited_unattributed`
- [ ] Pre-serve baseline captured for every query before 13:00
- [ ] `docs/TERAC.md` with confirmed-vs-assumed marked
- [ ] Study wording passes a banned-leading-phrase assertion
- [ ] Terac round 1 complete by 14:30, round 2 by 17:00
- [ ] Real Stripe charge visible; `rk_` key submitted
- [ ] Clean Replay report after fixing what it finds

## 4. Rules

- Never fabricate a study result or a propagation result.
- All three live flags default to 0.
- Do not run `codex exec`. Disabled globally.

## 5. The result stands either way

Three outcomes, all publishable:

- **`surfaced_labeled`** — disclosure propagates; honest agent advertising is viable
- **`surfaced_unlabeled`** — the model strips the label; ad disclosure is structurally broken in the answer layer
- **`absent`** — llms.txt does not influence this engine; the premise is weaker than the industry assumes

Ship whichever we measure. Do not chase the exciting one.
