# Terac — integration notes

**Researched 2026-08-15 ~12:15 PDT. Source: terac.com/mcp, terac.com/docs/developers, github.com/TeracAI.**

Status key: **CONFIRMED** = quoted from Terac's own pages. **ASSUMED** = inference, verify before relying on it.

---

## THE HEADLINE: latency does not fit a two-round before/after

**CONFIRMED**, quoted from terac.com/mcp: delivery is advertised at **"$84 · eta 6h"** with typical completion **"5h 12m"**.

Submissions lock at **18:45**. At 12:15 that leaves **6h30m**.

| Plan | Fits? |
|---|---|
| One study launched now | Yes, barely — returns ~17:30 |
| Two **sequential** rounds (round 1 → decide → round 2) | **No.** Round 2 returns tomorrow. |
| Multiple **parallel** arms launched together | **Yes** — one latency cycle, not two |

The PRD's 14:30 round 1 / 17:00 round 2 schedule is **dead**. It assumed panel latency in the tens of minutes. It is five to six hours.

### The fix: parallel arms, not sequential rounds

Launch `labeled`, `unlabeled`, and `labeled_prominent` **simultaneously as separate arms** of one study. This is a randomized A/B, which is *better* science than a sequential before/after — no time confound, no ordering effect.

The mandatory "clear before and after" then becomes: **model's predicted human verdict (before) vs. actual human verdict (after)**, plus the concrete product change we ship because of it. That satisfies the guidebook criterion — real human input measurably improving the project — inside one latency cycle.

**Launch as early as possible. Every minute before launch is a minute off the buffer.**

---

## Connection — MCP, not REST

**CONFIRMED.** Two surfaces exist. The MCP is the one the hackathon mandates.

### MCP (use this)

Server: `https://terac.com/api/mcp`

```
claude mcp add --transport http terac https://terac.com/api/mcp
```

**Auth is OAuth on first connection — no API key to paste.** This means connecting is *interactive* and a human has to complete it once. It cannot be scripted headlessly.

Also available for Cursor (deeplink), VS Code (deeplink), and ChatGPT (Settings → Apps & Connectors, requires a paid plan).

### REST (fallback, beta)

Base URL: `https://terac.com/api/external/v2`, authenticated with an API key.

Resources: Filters (demographics, geography, profession, participation history via typed slug filters), Screening Questions, Quotas (per-answer floors/caps and interlocked cross-question targets), Projects & Opportunities.

Terac's own warning, quoted: *"This API is in beta. Endpoints and request/response shapes may change before general availability."* Prefer the MCP.

## Tools

**CONFIRMED** from terac.com/mcp:

| Tool | Use |
|---|---|
| `terac_get_context` | Initialize context. Call first. |
| `terac_request_feasibility` | **Get a real price + ETA before committing.** |
| `terac_list_opportunities` | List studies |
| `terac_launch_draft_opportunity` | Launch |
| `terac_get_submissions` | Pull results |
| `terac_pause_opportunity` | Stop |

**CONFIRMED** from the svg-arena repo, and *not* listed on the /mcp page: `terac_create_opportunity` — creates a priced draft. So the real tool surface is larger than the marketing page shows. Enumerate the tools after connecting rather than trusting either list.

### Shapes

Quoted verbatim from terac.com/mcp:

```json
terac_request_feasibility: {
  "role": "Senior React engineer",
  "task": "review PR for race conditions",
  "count": 3
}

terac_get_feasibility_request: {
  "request_id": "fr_8f2",
  "status": "PRICED",
  "cpi_usd": 28
}
```

Note `terac_get_feasibility_request` appears in the example but not in the tool list — another sign the surface is under-documented.

## Cost

**CONFIRMED:** `cpi_usd: 28` in the worked example — $28 cost per interview, for a *specialist* role (senior React engineer). Billing is **pay on verified completion**; a quote is given before launch, and submissions failing review are not charged.

**ASSUMED:** General Population costs materially less than a vetted specialist. The guidebook's instruction — *"launch studies geared towards the General Population, so you get the fastest & best results"* — is consistent with gen-pop being both cheaper and faster.

**Budget risk:** at specialist rates, n=40 would run ~$1,120. Do not launch a large study blind. **Call `terac_request_feasibility` first, read the quote, then commit.** That tool exists precisely for this.

## Reference implementation

`github.com/TeracAI/svg-arena` — MIT, TypeScript, updated 20 Jun 2026. Terac's own forkable example of exactly our loop: *"AI generates, humans judge via the Terac MCP, you improve the model."*

Documented call order (`docs/annotation-loop-playbook.md`):

1. `terac_get_context`
2. `terac_create_opportunity` — creates a priced draft
3. `terac_launch_draft_opportunity` — launch, pointing the task URL at your deployed app

**Terac appends `?submissionId=...&taskId=...` to your task URL.** That is how responses tie back to participants. svg-arena captures it two ways: client-side in `app/page.tsx`, and server-side from the `Referer` header in `app/api/vote/route.ts`.

Judging pattern: blind pairwise comparison, reason tags, identity revealed after each vote. Results export as JSONL from `GET /api/export`, ranked with Bradley-Terry (order-independent, unlike sequential Elo).

**This is worth forking rather than rebuilding.** It solves participant attribution, the judging UI, and export — three things we would otherwise burn hours on.

## Implications for AdLayer

1. **Connect the MCP now.** It is interactive OAuth; nothing proceeds without a human completing it once.
2. **Feasibility-check before launching.** Get the real gen-pop ETA and CPI. If the ETA exceeds ~5h, the study must launch immediately or not at all.
3. **Parallel arms, one cycle.** Sequential rounds are impossible.
4. **We need a deployed task URL before launch** — participants are sent to *our* app to judge. That is a dependency the PRD never called out, and it sits on the critical path ahead of the study.
5. **Attribution must be wired** (`submissionId` / `taskId`) or results cannot be tied to participants.

## Open questions

- Actual general-population CPI and ETA. Only `terac_request_feasibility` answers this.
- Minimum viable n for a defensible result. Cost pressure says small; statistics says not too small.
- Whether draft creation is `terac_create_opportunity` (svg-arena) or something else in the current tool surface.
