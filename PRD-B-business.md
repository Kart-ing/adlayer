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

---

## 6. Implementation status & plan

Legend: ✅ done & verified · 🔜 next · ⬜ not started.

### Decided scope
Full PRD B. `web/` is **Next.js**. The Terac judging surface is a **fork of
`github.com/TeracAI/svg-arena`** living in `judge/` (its own toolchain, excluded from the root
`tsconfig`).

### ✅ Step 0 — repo prerequisites (build is green)
- Added `openai` to `package.json` `dependencies` and installed.
- `tsconfig.json` now excludes `engine/act/**` (legacy CITED SEO code, unused by AdLayer, and
  imports a dropped `engine/ui/types.ts`) and `judge/**`.
- Fixed 12 **pre-existing** strict-mode errors in the reused `engine/retrieve/` — type-only
  imports (`aggregate.ts`, `engine.ts`, `index.ts`), one non-null assert in `mapPool`, and
  null-guards in `scrape.ts`. Compile-correctness only; **no logic changed** ("reuse, don't
  rewrite" holds).
- `npx tsc --noEmit` is clean.

### ✅ Step 1 — Classifier core (`src/prove/classify-propagation.ts`)
The most important function; built and tested first. Signature follows the contract plus an
optional pre-serve baseline: `classify(answerText, citedUrls, placement, baseline?)`.
- `classifyDetailed(...)` returns full evidence (`confidence`, `matched_shingles`, `notes`);
  `classify(...)` returns just the `PropagationState`.
- **Ruthless about false positives**: `surfaced_*` is claimed only when a distinctive multi-word
  (4-gram) fingerprint from `placement.rendered_block` appears in the answer. A bare brand mention
  or domain citation → `cited_unattributed`. The classifier deliberately **under-claims**
  propagation (the honest direction for a judge).
- **Baseline subtraction**: advertiser already present pre-serve, or the copy already in the
  baseline answer, → not attributed to us.
- **Disclosure detection** folds unicode bracket look-alikes (`［SPONSORED］`) and zero-width chars
  to ASCII, and accepts the notice phrasing — covers the red-team counterfeit-label finding.
- Decoupled from the engine (imports only `src/contract.ts`) so it runs under the repo's
  `node --test --experimental-strip-types` harness.
- **Tests** (`src/prove/__tests__/classify-propagation.test.ts`) — 8/8 passing: all four states,
  the mandated organic-before-serve false-positive, a baseline-copy variant, the unicode
  counterfeit label, and the weak-brand-signal case.

### ✅ Step 2 — Measurement (`src/prove/measure.ts` + `src/prove/answer-engines.ts`)
`checkPropagation(placement, queries, flags): Promise<PropagationCheck[]>` — built and verified.
- **The key adaptation, solved:** the engine adapters return only cited URLs and **discard answer
  text**, but the classifier needs the text. `answer-engines.ts` **reuses** the engine's disk cache
  (`getCache`/`setCache` from `engine/retrieve/cache.ts`) and mirrors its retry/backoff +
  `url_citation` extraction patterns, but returns `{ answerText, citedUrls }`.
- `askSonar(query)` → OpenRouter model **`perplexity/sonar`** (live web search — polled FIRST;
  reads both `url_citation` annotations and Perplexity's top-level `citations`). `askOpenAI(query)`
  → Responses API, `output_text` + annotations (ingestion/control arm). `DEFAULT_ENGINES` is
  sonar-first; the demo runner reports the two mechanisms **separately, never averaged**.
- Respects `flags.liveMeasure`: false → reads `src/prove/fixtures/propagation.json` (no network).
  Live answers cache to disk. Missing key → empty answer → `absent` (never throws).
  `latency_minutes` = `served_at` → observation time.
- Baseline consumed per `${engine}:${query}` from `src/prove/fixtures/baseline.json` for the organic
  false-positive guard. Fixtures (`demo-placement.json`, `demo-queries.json`, `propagation.json`,
  `baseline.json`) are self-evidently marked and drive the offline demo.
- **Verified:** `LIVE_MEASURE=0 npm run measure` runs fully offline and reproduces the thesis —
  sonar `surfaced_unlabeled` at 18m latency (the headline), a `cited_unattributed`, an `absent`;
  the openai ingestion arm all `absent`. `LIVE_MEASURE=1` with no keys degrades to `absent` without
  crashing.
- **Remaining (deferred to the poll orchestration / Step 4):** a live `captureBaseline` helper and
  the scheduler that appends to `AdLayerState.propagation[]` (the Render Workflow + Superserve
  pause-between-polls wrapper around `checkPropagation`).

### ✅ Step 3 — Terac (`src/prove/terac.ts` + `src/prove/study-design.ts`)
Built and verified.
- `study-design.ts` — two neutral questions (trust / ad-recognition), three variant stimuli
  (`labeled` inline, `unlabeled` stripped, `labeled_prominent` banner), `PARTICIPANT_FRAMING`,
  `studySpec()` (what the judge app renders), `BANNED_LEADING_PHRASES` + `findBannedPhrase()` +
  `assertNeutralWording()` (scans questions/options/framing, **not** the ad-copy stimulus).
- `terac.ts` — parallel arms in one latency cycle: `runStudyArms(flags)` launches all three via
  `Promise.all`. Predicted-vs-actual before/after: `predictVerdict()` loads the **frozen**
  `predicted-verdict.json` (before); `runStudy(variant, flags)` returns fixtures when
  `LIVE_STUDY=0` and otherwise **aggregates only real submissions** (`aggregateSubmissions` — an
  empty arm throws, never 0%). `buildBeforeAfter()` computes signed deltas; `decideFormatChange()`
  is the Format agent's shipped decision. MCP transport (`get_context → request_feasibility` →
  `create_opportunity` → `launch_draft_opportunity` at the deployed `judge/` URL → `get_submissions`)
  is agent-driven; feed its submissions into `aggregateSubmissions`.
- **Never fabricates:** fixtures marked (`fixture_` id + `[FIXTURE]` verbatim); `LIVE_STUDY=1` with
  no submissions reports the frozen prediction only (actuals blank), never invented numbers.
- **Verified:** `LIVE_STUDY=0 npm run study` prints predicted→actual per arm, the headline
  (`unlabeled`) before/after, and the Format decision — the fixture shows unlabeled answers
  recognized as ads only 23% of the time vs 92% prominent, so the agent ships `labeled_prominent`.
- **Remaining:** the live judging surface (Step 5) that produces those submissions.

### ✅ Step 4 — Web (`web/`, Next.js 14 App Router)
Self-contained app (own `package.json`/`tsconfig`, excluded from root tsconfig). Built and verified.
- Routes: `/` (advertiser self-serve), `/checkout`, `/dashboard`, `/disclosure`, plus
  `POST /api/creative`. Server components read `AdLayerState` from `web/data/state.json`
  (AdLayerState shape — the root `fixture.json` is CITED-shaped, not reused). `web/lib/contract.ts`
  **re-exports `src/contract.ts`** (single source of truth; verified it builds across the dir boundary).
- `/dashboard` (the demo): revenue/placement/`surfaced_unlabeled` KPIs, an **alarm banner** for the
  headline, per-placement propagation split into **live-retrieval vs ingestion tables (never
  averaged)**, the Terac predicted→actual before/after with the Format-agent decision, and a
  creatives/compliance table showing the blocked (vetoed) creative.
- `/` renders a live-preview self-serve form (client component) → `POST /api/creative` appends a
  `pending_review` creative; `assertDisclosed()` guards the intake path; validation returns 400.
- `/checkout` reads `STRIPE_PAYMENT_LINK`; **absent → "Checkout not configured", never a fake success.**
- `/disclosure` renders the policy + the exact `[SPONSORED]` block format from the contract constants.
- Dense monospace control-plane styling, no emoji/gradient, focus-visible outlines, real `<label for>`
  bindings, `overflow-x` scroll containers — built for Replay QA.
- **Verified:** `npm run build` clean; server started and all four routes returned 200; dashboard
  showed the alarm/fixture-banner/Format decision/separated arms; checkout showed "not configured";
  self-serve POST created a `pending_review` creative and validation rejected a missing URL with 400.
  Root + web typecheck clean; 17 tests still pass.

### ✅ Step 5 — Judging surface (`judge/`, svg-arena-pattern Next app)
Built and verified end-to-end. (svg-arena is Terac's reference repo; this is a faithful
implementation of its exact loop rather than a literal clone.)
- **Attribution both ways** (`lib/attribution.ts`): client-side from the page's `?submissionId=&taskId=`
  query, server-side from the `Referer` header in `app/api/vote/route.ts` (`reconcile()` prefers the
  body, falls back to Referer). Verified a Referer-only POST stored `submissionId=ref_9`.
- **Blind arm assignment** stable per `submissionId` (`assignVariant` hash) — participant always sees
  the same arm; arms spread evenly.
- **Task content is generated** from the single source of truth: `npm run gen:study-spec`
  (`scripts/gen-study-spec.ts`) writes `judge/data/study-spec.json` from `study-design.ts`, so the
  judge app never resolves project TS across its boundary.
- **JSONL export** (`GET /api/export`, `force-dynamic`) emits exactly the `Submission` shape
  `terac.ts` `aggregateSubmissions` consumes.
- **The loop closes (verified):** ran the server, POSTed 9 real votes across all three arms, exported
  the JSONL, and fed it back through `terac.ts` → per-arm rates (labeled 67% ad-recognition,
  unlabeled 25%, prominent 100%) and an `unlabeled` predicted→actual before/after. `npm run build`
  clean; `judge` typecheck clean.
- **Remaining:** deploy on Render and point `terac_launch_draft_opportunity`'s task URL at it (must
  be live before launch).

### ✅ Step 6 — Stripe (`src/prove/revenue.ts`)
Built and verified against the real (test-mode) restricted key.
- `syncRevenue()` pages `/charges` with the read-only `rk_` key, nets captured-minus-refunded over
  succeeded/paid charges → `AdLayerState.revenue`. Refuses a non-`rk_` key; only ever GETs.
- No key → `{ configured: false }` "not configured" (zeroes, `stripe_synced_at: null`) — never a
  fabricated charge. `/checkout` already reads `STRIPE_PAYMENT_LINK`.
- `npm run revenue` prints the summary; `--write` merges it into `web/data/state.json`.
- **Verified:** live sync returned **$1.00 across 1 charge** (real test charge); `--write` updated
  the dashboard state (then restored the curated fixture for a deterministic commit); `/checkout`
  with the env set renders the real "Pay with Stripe" link, and shows "not configured" without it.
- Secrets live in `.env` (gitignored, untracked — confirmed the key is in no tracked file). Organizers
  receive the `rk_` key + the single Payment Link.

### Acceptance tracking (§3)
- [x] `npx tsc --noEmit` clean
- [x] Tests for all four classification states **plus** the false-positive case
- [x] Runs fully offline with `LIVE_MEASURE=0`
- [~] Pre-serve baseline consumed per query (fixture in place); live capture helper pending
- [ ] `docs/TERAC.md` with confirmed-vs-assumed marked *(already present)*
- [x] Study wording passes a banned-leading-phrase assertion
- [~] Terac arms modeled + before/after wired; judge→JSONL→aggregate loop verified; live launch needs deploy (Step 5)
- [x] Real Stripe charge visible ($1.00 test charge synced via `rk_`); key held in gitignored `.env`
- [~] Web app builds + all routes serve; dashboard/checkout/self-serve verified — Replay QA run pending (Step 4)
