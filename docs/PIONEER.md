# Pioneer — why inference is failing

**BLUF.** The API key is valid and authenticating correctly. Inference is refused because the account has **no billing plan attached**, not because of anything in our code. Redeem the hackathon promo and it works.

**Fix:** https://agent.pioneer.ai/billing → Get Pro → promo code `ZeroHumanHack0826` at the Stripe checkout page.

---

## The error

```
POST https://api.pioneer.ai/inference
403 {"detail":{"code":"card_required",
     "message":"To run inference on Pioneer, subscribe to the Hobby or Pro plan
                at https://agent.pioneer.ai/billing.",
     "resolution_url":"https://agent.pioneer.ai/billing"}}
```

## Proof it is the plan, not the key

Three requests to the same endpoint, differing only in credentials:

| Credential | Response |
|---|---|
| bogus key `pio_sk_totally_fake_00000` | `401 Invalid API key. Please check your credentials.` |
| no key at all | `401 Authentication required` (`invalid_credentials`) |
| **our key** | **`403 card_required`** |

A 403 with `card_required` is the server saying *"I know who you are, and you are not entitled to this."* An unrecognised key never reaches that check — it 401s first. So the key is good.

**Note on a misleading signal:** `GET /base-models` returns `200` with **no key at all**. It is a public endpoint. Do not use it to test authentication — it will pass no matter what you send.

## ⚠️ Credit is not a plan

The dashboard showing **$40 of free credit does not clear this gate.** Retested with the credit visible on the account: still `403 card_required`.

Read the error literally — it says *"subscribe to the Hobby or Pro plan"*, not "add funds." It is a **subscription check**, not a balance check. Credit is what gets *spent* once a plan exists; with no plan attached, the request is refused before any balance is consulted.

So having credit is not progress toward fixing this. You still have to complete: **Billing → Get Pro → promo `ZeroHumanHack0826` at the Stripe checkout page.** The promo is what attaches the plan; the credit then pays for the inference.

There is no API endpoint that reports plan status — `/account`, `/me`, `/billing`, `/usage` all 404. The only way to check is to attempt an inference call and see whether it 403s.

## What this blocks

`reviewCreative()` runs GLiGuard moderation over every creative. When Pioneer is unavailable it **fails closed** — an unreviewed creative never reaches `approved`:

```
CLEAN creative    passed: false   flags: ["moderation_unavailable"]
HOSTILE creative  passed: false   flags: ["moderation_unavailable"]
rationale: "Disclosure verified... HELD — FAILING CLOSED: moderation did not run"
```

That is correct and deliberate. A moderation service being down must never become a reason to ship an unmoderated ad. But the practical consequence is that **no placement can serve at all** until the plan is live.

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
