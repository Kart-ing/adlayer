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

**⚠️ REVISED — target live-retrieval engines first.** The obvious objection is that engines take hours or months to ingest `llms.txt`, so we will measure `absent` and have nothing. That is true of **training and index refresh**. It is not true of **live retrieval**: engines that fetch at query time can surface a page within minutes.

So poll **`perplexity/sonar` first** — it is already the fallback path in `engine/retrieve` and it does live web search. Treat ingestion-based engines as the slow control arm and report them separately. Do not average the two together; they are measuring different mechanisms, and conflating them is the kind of thing a judge will catch.

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

**⚠️ REWRITTEN. Research is done — read `docs/TERAC.md` before touching this section. The schedule in v1 was impossible.**

**Panel latency is 5–6 hours, not minutes.** Confirmed from terac.com/mcp: quoted at *"$84 · eta 6h"*, typical completion *"5h 12m"*. Example CPI is **$28/response** for a specialist.

Four consequences:

**1. Sequential rounds are dead.** Launch `labeled` / `unlabeled` / `labeled_prominent` **simultaneously as parallel arms of one study**. One latency cycle. A randomized A/B is better science than a sequential before/after anyway — no time confound, no ordering effect.

**2. The before/after is now predicted-vs-actual.** Before = the model's *predicted* human verdict, recorded and frozen before the study returns. After = the actual human verdict. Plus the format change the **Format agent** ships because of it. That satisfies the guidebook's "real human input measurably improved the project" inside one cycle. Freeze the prediction in a committed file before results land, or the comparison is worthless.

**3. ⚠️ A live task URL is on YOUR critical path, ahead of the study.** Participants are sent to *our deployed app* to do the judging. Terac appends `?submissionId=...&taskId=...` to the URL we supply, and that is the only way responses tie back to participants. **Fork `github.com/TeracAI/svg-arena`** (MIT, TypeScript) — it is Terac's own reference implementation of this exact loop and already solves attribution (client-side in `app/page.tsx`, server-side via the `Referer` header), the judging UI, and JSONL export. Do not rebuild it.

**4. Feasibility-check before you launch.** `terac_request_feasibility` returns a real quote and ETA. At specialist rates n=40 is ~$1,120. Call it, read the number, then commit. General Population per the guidebook — cheapest and fastest.

Connection is **interactive OAuth**, not an API key:
```
claude mcp add --transport http terac https://terac.com/api/mcp
```

**Study design.** Show real people an assistant answer containing a paid placement. Measure:

1. Would you still trust this assistant?
2. Did you recognize that result as an ad?

Wording must be neutral. Judges include PMs from DeepMind and Stripe — a leading question gets caught.

`runStudy(variant, flags)` respects `LIVE_STUDY`. **Never fabricate results.** Fixture data must be self-evidently marked as fixture in the returned object.

**Launch by 14:00.** 5h latency from 14:00 lands at ~19:00, already past lock. Earlier is strictly better. If the feasibility quote says gen-pop latency exceeds ~4h, launch before anything else on your list is finished — a half-built judging page that collects real responses beats a polished one that launches too late.

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
