# PRD — ADLAYER

**The ad network for the answer layer. Agents read llms.txt. Nobody has priced that inventory. We do, with disclosure enforced in code, and we measure whether the label survives the model.**

**v2 — revised 12:30 after Terac research and an external audit. Changes marked ⚠️ NEW.**

Two people. One contract (`src/contract.ts`), written before any code.

Pitch line: *Your customers stopped asking Google. We sell the shelf space they ask instead — labeled, measured, and nobody works here.*

---

## 1. The thesis

Agents are becoming the traffic. Agents read `llms.txt`. That file is unpriced inventory.

Two things make this ours:

1. **CITED already generates llms.txt for clients.** We own supply on day one and skip the cold start that kills ad networks.
2. **CITED's `retrieve` already measures answer-engine citations.** We can prove propagation. Nobody else in the room can.

## 2. ⚠️ NEW — The company is agent-run, and here is which agent runs what

An external audit landed the correct criticism: v1 built a measurement instrument with one agent veto and called it a company. The brief says *agents run the company*. Fixed below. Every row is a consequential decision an agent makes and logs with a rationale.

| Brief's function | Agent | The decision it actually makes |
|---|---|---|
| Selling to customers | **Prospector** | Which companies to approach. Qualifies by *measuring* their invisibility with `retrieve` — low visibility score = they have a problem we can prove. |
| Marketing & outbound | **Closer** | Writes and sends the pitch, opening with the prospect's own measured number. |
| Handling payments | **Pricing** | Sets the placement price from category demand and measured invisibility. Issues the payment link. |
| Legal / compliance | **Compliance** | GLiGuard + disclosure. **Hard veto.** Blocks the serve. |
| Hard decisions | **Format** | Reads Terac results and decides the disclosure format we ship. Can override the default. |
| Building the product | Humans | Honest about this. Nobody's agents wrote their own hackathon submission. |

**The qualification signal is the unfair part.** We do not spray. We measure a prospect's invisibility before contact, so every pitch opens with a number about them they did not know and cannot dispute. That is the same engine that powers the measurement loop, pointed at demand generation.

Every agent decision writes a `DecisionLog` entry: input, options, choice, rationale, timestamp. That log *is* the answer to "which agent ran the company."

## 3. The open question we answer today

**Does the "sponsored" label survive the model?**

| Observed | What it means |
|---|---|
| `surfaced_labeled` | Disclosure propagates. Honest agent advertising is viable. |
| `surfaced_unlabeled` | The model strips the label. **Ad disclosure is structurally broken in the answer layer.** |
| `absent` | `llms.txt` does not move this engine. The premise is weaker than the industry assumes. |

We ship whichever we measure.

### ⚠️ NEW — Target live-retrieval engines, not ingestion

The audit predicted `absent` because engines take hours-to-months to ingest. That is true of **training and index refresh**. It is not true of **live retrieval** — engines that fetch at query time can surface a page within minutes.

So: **test `perplexity/sonar` first** (already the fallback path in `engine/retrieve`), and treat ingestion-based engines as the slow control arm. This is the single change that makes a same-day propagation result plausible, and it makes the 13:00 serve gate matter *more*.

## 4. Non-negotiable: disclosure

Every served block carries `[SPONSORED]` and the disclosure notice. `assertDisclosed()` throws before any write. There is deliberately no flag that turns it off.

Disclosed paid placement is advertising. Undisclosed content engineered to steer agents is prompt injection. We build the first and not the second — that distinction is the pitch, not a footnote.

**Red team has already broken earlier versions of this.** Confirmed findings: advertiser copy forging a rival's provenance field, unreviewed creatives reaching the renderer, and unicode bracket lookalikes shipping a counterfeit label. Treat advertiser input as hostile. Every fix carries a regression test.

## 5. ⚠️ NEW — Terac reality, and why the schedule changed

**Confirmed from terac.com/mcp:** delivery advertised at **"$84 · eta 6h"**, typical completion **"5h 12m"**. Example CPI is **$28/response** for a specialist.

Consequences:

- **Two sequential rounds are impossible.** v1's 14:30 → 17:00 plan is dead.
- **Launch parallel arms instead.** `labeled` / `unlabeled` / `labeled_prominent` simultaneously. One latency cycle. Randomized A/B is better science than sequential anyway — no time confound.
- **The before/after becomes:** model's *predicted* human verdict (before) vs the *actual* human verdict (after), plus the format change the **Format agent** ships because of it. Satisfies the guidebook criterion inside one cycle.
- **Feasibility-check before launching.** `terac_request_feasibility` returns a real quote and ETA. n=40 at specialist rates is ~$1,120. Do not launch blind.
- **⚠️ A live task URL is on the critical path.** Participants are sent to *our deployed app* to judge; Terac appends `?submissionId=&taskId=`. The judging surface must be deployed **before** the study launches. v1 missed this entirely.
- **Auth is interactive OAuth**, not an API key: `claude mcp add --transport http terac https://terac.com/api/mcp`.
- **Fork `github.com/TeracAI/svg-arena`** (MIT). Terac's own reference for this exact loop. Solves attribution, judging UI, and JSONL export.

Full detail in `docs/TERAC.md`.

## 6. The split

Two workstreams, disjoint directories, one contract. See `PRD-A-network.md` and `PRD-B-business.md`.

- **A — THE NETWORK** (`src/serve/`, `publishers/`): rendering, disclosure, compliance veto, publisher sites.
- **B — THE BUSINESS** (`src/prove/`, `web/`): measurement, Terac, Stripe, dashboard.
- **⚠️ NEW — `src/company/`**: the agent org and `DecisionLog`. Shared; whoever is free.

## 7. ⚠️ NEW — Revised schedule

Ordered by what gates what. Terac and the judging surface are now ahead of everything.

| Time | Task | Why it is here |
|---|---|---|
| **NOW** | Connect Terac MCP (interactive OAuth). Run `terac_request_feasibility` for general population. | Gates a mandatory requirement. Nothing else matters if this fails. |
| **NOW** | Stripe account, Payment Link, `rk_` key to organizers. | Gates $2,500. Ten minutes. |
| **13:00** | **First placement served.** Propagation clock starts. Pre-serve baselines captured. | Cannot be reconstructed later. |
| **13:00** | **One real charge.** | Revenue is judged on money received, not a flow that could charge. |
| **13:30** | Judging surface deployed at a public URL. | Blocks the Terac launch. |
| **14:00** | **Terac study launched, all arms parallel.** | 5h latency + 14:00 = ~19:00. Already tight. Earlier is better. |
| 14:00–17:00 | Agent org + decision log. Measurement polling on sonar. Dashboard. Replay QA. | |
| 17:00–18:00 | Terac results land. Format agent decides. Ship the change. | |
| 18:00–18:45 | Freeze, chart, two-minute video, submit. | |

**If the feasibility quote says gen-pop latency exceeds ~4h, launch the study before anything else is finished.** A half-built judging page that collects real responses beats a polished one that launches too late.

## 8. Prize map

| Track | Prize | Hook |
|---|---|---|
| Best Agent-Run Company | $2,500 | Real Stripe revenue + an agent org with a logged decision trail |
| Best Overall Project | $2,500 | Novel category, a measured result, and a disclosure standard |
| Superserve | $1,000 | Measurement polls run in sandboxes, paused between polls — their exact feature |
| Replay | $1,000 | Dashboard + checkout QA'd, bugs fixed, plus the $50 false-positive report |
| Pioneer | $500 | GLiGuard is the blocking veto; GLiNER2 categorizes advertiser intake |
| Band | $500 | ⚠️ Only qualifies if the veto *routes through* Band. Display does not count. Cut this first. |
| Render | $500 credits | ⚠️ Requires Render **Workflows**, not hosting. Run the poll loop as a Workflow. |
| Terac | mandatory | Parallel-arm trust study, model-predicted vs actual |

Linq dropped — no messaging surface.

## 9. Risks

| Risk | Call |
|---|---|
| ⚠️ Terac latency exceeds the window | Launch immediately, small n, gen-pop only. This is the top risk — it gates a mandatory requirement. |
| ⚠️ Judging surface not deployed in time | Fork svg-arena. Do not build it from scratch. |
| Engines never surface it | Target live-retrieval (sonar) first. If still absent, report it honestly and lean the demo on the Terac result, which stands alone. |
| Nobody buys a placement | Prospector qualifies by measured invisibility; Closer pitches. $20. We need a transaction, not margin. |
| Scope creep | Cut order: **Band first**, then Render Workflows, then Superserve. Never cut Terac, Stripe, disclosure, or measurement. |
| `codex exec` | Disabled globally. Adversarial self-review with tests instead. |

## 10. Definition of done, 18:45

- [ ] Disclosed placement live in a real llms.txt, timestamped
- [ ] Pre-serve baselines captured before the first serve
- [ ] Propagation polled on a schedule; result recorded whatever it says
- [ ] `assertDisclosed()` proven — test showing an undisclosed block is refused
- [ ] All red team findings fixed with regression tests
- [ ] **`DecisionLog` showing agents making consequential choices with rationales**
- [ ] Stripe showing a real charge, `rk_` key with organizers
- [ ] Terac arms launched and results returned
- [ ] Clean Replay report after fixes
- [ ] Two-minute video, submission filed
