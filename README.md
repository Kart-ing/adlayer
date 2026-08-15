# ADLAYER

**The ad network for the answer layer.**

Agents are becoming the traffic. Agents read `llms.txt`. Nobody has priced that inventory.

AdLayer sells placements in `llms.txt`, enforces disclosure in code, and then measures the thing nobody has measured: **does the "sponsored" label survive the model?**

Built for the [Zero Human Company Hackathon](https://www.hackathoncompany.com/platform/hackathons/the-world-s-first-zero-human-company-hackathon) by Terac — Humanmade, San Francisco, 15 August 2026.

---

## The open question

We place a clearly-labeled sponsored entry in a publisher's `llms.txt`. We poll answer engines. Three outcomes, all publishable:

| Observed | What it means |
|---|---|
| `surfaced_labeled` | Disclosure propagates. Honest agent advertising is viable. |
| `surfaced_unlabeled` | The model strips the label. **Ad disclosure is structurally broken in the answer layer.** |
| `absent` | `llms.txt` does not influence this engine. The premise is weaker than the industry assumes. |

We ship whichever we measure. A negative result reported honestly beats a positive result that collapses under a judge's first question.

## Disclosure is not optional

Every served block carries `[SPONSORED]` and a disclosure notice. `assertDisclosed()` throws before any write, and there is deliberately no flag that turns it off.

> Disclosed paid placement is advertising. Undisclosed content engineered to steer agents is prompt injection. We build the first and not the second.

That distinction is the product, not a footnote. See `/disclosure` on the deployed app for the public policy and the exact block format.

## Architecture

```
                       src/contract.ts
                    (one shape, written first)
                              |
        ┌─────────────────────┴─────────────────────┐
        │                                           │
   A — THE NETWORK                            B — THE BUSINESS
   src/serve/  publishers/                    src/prove/  web/
        │                                           │
   render llms.txt block                     poll answer engines
   enforce disclosure                        classify propagation
   GLiGuard compliance veto                  Terac human trust study
   3 real publisher sites                    Stripe + dashboard
        │                                           │
        └──────────────  placements[]  ─────────────┘
```

`engine/` is the working citation-capture engine ported from [CITED](https://github.com/) (c0mpiled Startup School, 24 Jul 2026). **Reuse it, do not rewrite it.**

## Docs

| File | What |
|---|---|
| `PRD.md` | Master plan, prize map, schedule, risks |
| `PRD-A-network.md` | Person A — supply, serving, compliance veto |
| `PRD-B-business.md` | Person B — demand, measurement, Terac, money |
| `GUIDEBOOK.md` | Full hackathon reference: tracks, criteria, credits, deadlines |
| `src/contract.ts` | The contract. Law. Read before writing anything. |

## Setup

```bash
npm install
cp .env.example .env     # everything degrades gracefully when unset
npm run typecheck
npm test
```

Every side effect is dry-run by default. `LIVE_SERVE`, `LIVE_MEASURE`, and `LIVE_STUDY` all default to `0`.

## The one hard deadline

**13:00 — first placement served.**

Answer engines take hours to pick anything up. Serve late and there is nothing to measure at 18:45. Ship a hand-verified block on one publisher at 13:00 even if everything else is still stubbed, then keep building.

Submissions lock **18:45**.
