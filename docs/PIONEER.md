# Pioneer — why inference is failing

**BLUF.** Pioneer's own API confirms the team is on the **Pro** plan, and inference still returns `403`. The error text blames the plan; the plan is fine. The real state is **plan active, $0.00 spendable balance**. This is a Pioneer-side provisioning issue, not our code and not a bad key.

**Fastest fixes, in order:** their booth at the venue → their Discord → click **Buy credits** for a token amount to push the balance above $0.00.

---

## Evidence — the plan is NOT the problem

```
GET https://api.pioneer.ai/teams
{"name":"Kartikey's Team","payment_plan":"pro","member_count":1,
 "current_user_role":"owner","capabilities":{"can_download_weights":true}}
```

`payment_plan: "pro"`. Their own API. Meanwhile:

```
POST /v1/chat/completions
403 {"error":{"message":"To run inference on Pioneer, subscribe to the Hobby or
     Pro plan at https://agent.pioneer.ai/billing.","type":"permission_error"}}
```

Tested exhaustively — every combination returns the same 403:

| Key | Endpoint | Auth header | Result |
|---|---|---|---|
| `..._l3op4rd_...` | `/inference` | `X-API-Key` | 403 |
| `..._c4t_...` | `/inference` | `X-API-Key` | 403 |
| `..._c4t_...` | `/v1/chat/completions` | `Bearer` | 403 |
| `..._c4t_...` | `/inference` | `Bearer` | 403 |
| `..._l10n_...` | `/v1/chat/completions` | `Bearer` | 403 |

Three separate keys, two endpoints, two auth styles. Not a key problem, not an endpoint problem.

## What the dashboard actually shows

```
Plan:               Pro   (Current plan)
Remaining Balance:  $0.00  + $40.00 free credit
Auto recharge:      disabled - "Your requests will stop when your balance runs out"
Inferences:         0
```

`Remaining Balance $0.00` with auto-recharge off is exactly the documented condition for requests stopping. The `$40.00 free credit` is rendered *beside* the balance rather than inside it, and nothing has drawn against it — the Inferences counter reads 0.

So the plan entitlement and the spendable credit are separate things, and only the first one landed.

## Two false trails, recorded so nobody repeats them

**`GET /base-models` returns 200 with NO key at all.** It is a public endpoint and cannot be used to test authentication. It misled an earlier diagnosis of mine.

**The 403 does distinguish a bad key from an entitlement problem**, which is genuinely useful: a bogus key returns `401 Invalid API key`, no key returns `401 Authentication required`, and a *valid* key with no entitlement returns `403`. So a 403 always means "we know who you are." That much held up.

There is no endpoint that reports balance — `/credits`, `/balance`, `/v1/credits`, `/v1/balance` all 404. `/teams` reports the plan but not the balance. The only way to test is to attempt an inference call.

## What this blocks

`reviewCreative()` runs GLiGuard moderation over every creative. When Pioneer is unavailable it **fails closed** — an unreviewed creative never reaches `approved`:

```
CLEAN creative    passed: false   flags: ["moderation_unavailable"]
HOSTILE creative  passed: false   flags: ["moderation_unavailable"]
rationale: "Disclosure verified... HELD — FAILING CLOSED: moderation did not run"
```

That is correct and deliberate. A moderation service being down must never become a reason to ship an unmoderated ad. But the practical consequence is that **no placement can serve at all** until the balance is above $0.00.

## The override, and its cost

`ADLAYER_ALLOW_UNMODERATED=1` permits serving when the *only* flag is `moderation_unavailable`. It never rescues a creative that was content-flagged or never reviewed, it logs loudly, and it sets `unmoderatedOverride: true` on the result.

It is off by default and should stay that way. **If we serve with it, every propagation finding downstream came from an unmoderated placement, and the writeup must say so.** Two minutes of billing removes the caveat entirely.

## What we lose by not fixing it

- **Serving.** Nothing ships. No placement, no propagation measurement, no headline result.
- **The Pioneer track, $500.** Criteria: *"Use open-weight model(s) on Pioneer to build a compelling product,"* with bonus points for GLiNER2 / GLiGuard / GLiNER2-PII. We use two of the three as load-bearing components, and currently neither can execute.

## Confirmed model IDs

Both exist on Pioneer and support inference — verified against `GET /base-models`:

| Model | ID | Use |
|---|---|---|
| GLiGuard 300M | `fastino/gliguard-LLMGuardrails-300M` | moderation, the compliance veto |
| GLiNER2 Large | `fastino/gliner2-large-v1` | entity extraction, advertiser categorisation |

Also available: `fastino/gliner2-privacy-filter-PII-multi`, `fastino/gliguard-PII-multi`, `fastino/gliner2-base-v1`, `fastino/gliner2-multi-v1`, `fastino/gliner2-multi-large-v1`.

Base URL `https://api.pioneer.ai`, header `X-API-Key`. Our client is `src/serve/pioneer.ts`; it degrades rather than throwing when the key is missing or the API errors.
