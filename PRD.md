# PRD — ADLAYER

**The ad network for the answer layer. Agents read llms.txt. Nobody has priced that inventory. We do, with disclosure enforced in code, and we measure whether the label survives the model.**

Two people. Seven hours. One contract (`src/contract.ts`), written before any code, same play that shipped CITED.

Pitch line: *Your customers stopped asking Google. We sell the shelf space they ask instead — labeled, measured, and nobody works here.*

---

## 1. The thesis

Agents are becoming the traffic. Agents read `llms.txt`. That file is unpriced inventory.

Two things make this ours and not anyone's:

1. **CITED already generates llms.txt for clients.** We own supply on day one. Cold-start is the thing that kills ad networks and we skip it.
2. **CITED's `retrieve` already measures answer-engine citations.** So we can prove propagation. Nobody else in that room can.

## 2. The open question we answer today

**Does the "sponsored" label survive the model?**

We place a disclosed ad. We poll answer engines. Three outcomes, all publishable:

| Observed | What it means |
|---|---|
| `surfaced_labeled` | The disclosure propagates. Honest agent advertising is viable. |
| `surfaced_unlabeled` | The model strips the label. **Ad disclosure is structurally broken in the answer layer.** |
| `absent` | llms.txt does not influence this engine. The premise is weaker than assumed. |

We ship whichever we measure. A negative result is still a result, and it's a better talk track than most teams' working demos.

## 3. Non-negotiable: disclosure

Every served block carries `[SPONSORED]` and the disclosure notice. `assertDisclosed()` throws before any write. There is deliberately no flag that turns it off.

Disclosed paid placement is advertising. Undisclosed content engineered to steer agents is prompt injection. We build the first and not the second, and that distinction is the pitch, not a footnote.

## 4. The split

Two workstreams, disjoint directories, one contract between them. Neither blocks the other after 12:00.

### Person A — THE NETWORK  (`src/serve/`, `publishers/`)

Owns supply, serving, and the veto.

| Deliverable | Detail |
|---|---|
| Publisher registry | `Publisher[]` — domains, categories, integration mode |
| llms.txt renderer | Takes `Creative` + `Publisher` → `rendered_block`. Calls `assertDisclosed()`. |
| Ad server | Render-hosted endpoint serving blocks per publisher |
| Demo publishers | 3–5 real sites deployed on Render with real content + our llms.txt |
| **Compliance agent** | Pioneer **GLiGuard** on every creative → `ComplianceVerdict`. **Can block.** |
| Sandboxing | Publisher crawls + verification run in **Superserve** |
| Emits | `publishers[]`, `creatives[].review`, `placements[]` |

### Person B — THE BUSINESS  (`src/prove/`, `web/`)

Owns demand, proof, and money.

| Deliverable | Detail |
|---|---|
| Advertiser self-serve | Submit creative, pick categories, pay |
| **Stripe checkout** | Payment Link. Real revenue. Gates the $2,500. |
| Targeting | Pioneer **GLiNER2** extracts advertiser categories from their site |
| **Measurement loop** | Reuse `engine/retrieve` → `PropagationCheck[]`. Poll on a schedule. |
| **Terac study** | Trust + ad-recognition, labeled vs unlabeled. Round 1 by 14:30. |
| Dashboard | Live propagation view. The demo surface. Replay QA's this. |
| Emits | `advertisers[]`, `propagation[]`, `terac`, `revenue` |

### Shared, end of day
Band room wiring (both agents post there), Replay pass, Render Workflows, video, submission.

## 5. Schedule — propagation clock is the constraint

Engines take hours to pick anything up. Serving late means measuring nothing.

| Time | A — Network | B — Business |
|---|---|---|
| 11:30–12:00 | Sponsor accounts. Stripe link + `rk_` to organizers. | Same. Terac key first. |
| 12:00–13:00 | Renderer + disclosure + one demo publisher live on Render | Measurement loop running against fixtures |
| **13:00** | **FIRST REAL PLACEMENT SERVED. Propagation clock starts.** | **First engine poll fires.** |
| 13:00–14:30 | Compliance agent (GLiGuard), 2 more publishers | Stripe checkout live, advertiser intake |
| 14:30–16:00 | Superserve execution, Band wiring | **Terac round 1**, dashboard |
| 16:00–17:30 | Sell placements. Real advertisers, real charges. | Terac round 2, Replay QA + fixes |
| 17:30–18:45 | Freeze. Chart. Two-minute video. Submit. | Same. |

**13:00 is the hard gate.** Everything else can slip.

## 6. Prize map

| Track | Prize | Hook |
|---|---|---|
| Best Agent-Run Company | $2,500 | Advertisers pay real money through Stripe today |
| Best Overall Project | $2,500 | Novel category + a measured result nobody else has |
| Superserve | $1,000 | Crawls and engine polls run in sandboxes, paused between |
| Replay | $1,000 | Dashboard + checkout QA'd, bugs fixed, clean report |
| Pioneer | $500 | GLiGuard is the blocking veto; GLiNER2 does targeting |
| Band | $500 | Compliance veto travels through the room. Remove it, ads ship unreviewed. |
| Render | $500 credits | Ad server + demo publishers + Workflows |
| Terac | mandatory | Trust study, labeled vs unlabeled, measured before/after |

Linq dropped — no messaging surface.

## 7. Risks

| Risk | Call |
|---|---|
| Engines never surface it | That IS the finding. Report `absent` honestly and pivot the talk track to "llms.txt is not yet read." |
| Nobody buys a placement | Sell to teams in the room who want their project cited. $20. We need a transaction, not margin. |
| Propagation slower than 6 hours | Serve at 13:00. If nothing by 17:00, ship latency-unknown + the Terac trust result, which stands alone. |
| Scope creep across 7 sponsors | Cut order: Band, then Render Workflows, then Superserve. Never cut Terac, Stripe, disclosure, or measurement. |
| `codex exec` | Disabled globally. Adversarial self-review with tests instead. |

## 8. Definition of done, 18:45

- [ ] Disclosed placement live in a real llms.txt, timestamped
- [ ] Propagation polled on a schedule, result recorded whatever it says
- [ ] `assertDisclosed()` proven — a test showing an undisclosed block is refused
- [ ] Compliance agent blocked at least one creative, on the record in Band
- [ ] Stripe showing a real charge, `rk_` key with organizers
- [ ] Terac before/after on labeled vs unlabeled trust
- [ ] Clean Replay report after fixes
- [ ] Two-minute video, submission filed
