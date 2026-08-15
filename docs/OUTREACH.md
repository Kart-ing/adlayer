# OUTREACH — giving the Closer a transport

**BLUF.** The Closer decided three things and none of them left the process. `sent` was a
literal `false` and no transport existed, so the agent had never been wrong in a way a
prospect could settle. `src/company/outreach/` is the transport, the hard compliance gate in
front of it, and the suppression list behind it. **It ships disarmed.** A real send needs
`flags.liveSend === true` AND `LIVE_SEND=1` in the environment. There is no third way in.

Owner: outreach workstream. Scope: `src/company/outreach/**`, `site/**`, this file.

---

## 0. Arming it — the exact variables

| Variable | Required for a live send | Effect when absent |
|---|---|---|
| `LIVE_SEND` | **yes**, must be exactly `1` | Every call is a dry run. Nothing is transmitted. |
| `RESEND_API_KEY` | for network delivery | Transport degrades to `file` (writes `.eml` to the outbox). One log line. Never throws. |
| `OUTREACH_FROM` | **yes** | Transport degrades to `file`. A send with no identifiable sender is a CAN-SPAM header violation, so we will not invent one. |
| `OUTREACH_REPLY_TO` | **yes** | Compliance gate **blocks**: an opt-out that reaches nobody is not an opt-out. |
| `OUTREACH_POSTAL_ADDRESS` | **yes** | Compliance gate **blocks**: CAN-SPAM §5(a)(5)(A)(iii) requires a valid physical postal address in every commercial message. |
| `OUTREACH_UNSUBSCRIBE_URL` | **yes** | Compliance gate **blocks**: no working one-click opt-out. |
| `OUTREACH_OUTBOX` | no | Defaults to `.outbox/`. Where the `file` transport writes. |
| `OUTREACH_SUPPRESSION_PATH` | no | Defaults to `data/outreach-suppression.jsonl`. Append-only. |

Minimum viable armed configuration:

```bash
export LIVE_SEND=1
export RESEND_API_KEY=re_xxxxxxxx
export OUTREACH_FROM='AdLayer <outbound@adlayer.example>'
export OUTREACH_REPLY_TO='hello@adlayer.example'
export OUTREACH_POSTAL_ADDRESS='AdLayer, 1 Example Street, Suite 2, San Francisco, CA 94103'
export OUTREACH_UNSUBSCRIBE_URL='https://adlayer.example/unsubscribe'
```

Miss any one of the last four and the gate blocks the send rather than shipping a
non-compliant message. That is the intended failure direction.

**Do not point `OUTREACH_FROM` at a personal Gmail account.** A cold-outbound run through a
personal mailbox burns the owner's address and domain reputation permanently, and Gmail's
bulk-sender rules require DKIM/SPF/DMARC alignment on a domain you control. Dedicated sending
subdomain only.

---

## 1. Resend — CONFIRMED

Source: [Resend API reference — send email](https://resend.com/docs/api-reference/emails/send-email),
[account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits),
[add and verify a domain](https://resend.com/docs/add-a-domain).

**CONFIRMED — API shape.** One POST, no SDK, works on global `fetch`, which is why we took it
over SES or Postmark under the zero-new-deps rule.

```bash
curl -X POST 'https://api.resend.com/emails' \
     -H 'Authorization: Bearer re_xxxxxxxxx' \
     -H 'Content-Type: application/json' \
     -d $'{
  "from": "Acme <onboarding@resend.dev>",
  "to": ["delivered@resend.dev"],
  "subject": "hello world",
  "html": "<p>it works!</p>"
}'
```

- Auth: `Authorization: Bearer re_…`. No signing, no OAuth.
- Required: `from`, `to` (max 50 addresses), `subject`, and at least one of `html` / `text`.
- Optional and used by us: `reply_to`, `headers` (arbitrary — this is how `List-Unsubscribe`
  gets set), `tags`.
- Response: JSON with an email `id`. We record that id in the `DecisionLog` entry so a send
  is checkable in the Resend dashboard rather than only in our own log.
- `Idempotency-Key` request header exists (max 256 chars, 24h window). **Not yet wired** —
  see §5.

**CONFIRMED — free tier.** "100 emails/day and 3,000 emails/month" for transactional email.
Rate limit is "10 requests per second", shared per team across all API keys. Bounce rate must
stay under 4% and spam complaint rate under 0.08% or sending is paused. For a hackathon
outreach run of single-digit messages, none of these bind.

**CONFIRMED — sandbox domain.** `onboarding@resend.dev` sends without any domain setup, but
only to the account owner's own verified address. It is a smoke test, not a channel to
prospects.

**CONFIRMED — domain verification is DNS.** Add the domain, publish the DKIM `TXT` and the
`MX`/`TXT` records for the return path, Resend polls and flips the domain to verified.

**ASSUMED — timing, and this is the one that decides today.** Resend detects records
"usually within minutes to a few hours"; DNS can take up to 24h, and worst case 72h globally.
Sources disagree on the modal case and we have not measured it on our own registrar, so this
is ASSUMED, not CONFIRMED.

**The call: assume it does not verify in time.** Submissions lock at 18:45. A verification
that lands at 19:10 is worth nothing, and a run that waits on it produces neither a send nor
a working artifact. So the pipeline is built transport-agnostic and ships with the `file`
transport as the working default: it writes RFC 5322 `.eml` files to `.outbox/` that open in
any mail client and can be inspected byte for byte. If a human verifies a domain later,
setting `RESEND_API_KEY` + `OUTREACH_FROM` switches the same code path to the network with no
edit. What is proven today is the gate, the suppression list and the decision record — not
deliverability, and we do not claim deliverability.

---

## 2. CAN-SPAM — what MUST be in the message

Canonical source: [FTC, *CAN-SPAM Act: A Compliance Guide for Business*](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
and the [CAN-SPAM Rule, 16 CFR Part 316](https://www.ftc.gov/legal-library/browse/rules/can-spam-rule).
The FTC host returns 403 to our fetcher, so the wording below is CONFIRMED against
FTC-derived restatements ([FCC](https://www.fcc.gov/general/can-spam),
[Termly](https://termly.io/resources/articles/can-spam-act/),
[Usercentrics](https://usercentrics.com/knowledge-hub/can-spam-compliance/)) rather than
quoted from the FTC page directly. **A human should re-read the FTC page before arming.**

CONFIRMED requirements, and where each is enforced in code:

| # | Requirement | Enforced by |
|---|---|---|
| 1 | **Don't use false or misleading header information.** "From", "To", reply-to and routing must accurately identify the sender. | `compliance.ts` → `no_sender_identity`, `header_injection`. `OUTREACH_FROM` is never defaulted to a plausible-looking lie. |
| 2 | **Don't use deceptive subject lines.** The subject must accurately reflect the content. | `compliance.ts` → `deceptive_subject`, reusing the Closer's `BANNED_URGENCY` / `BANNED_CLAIMS` blocklists plus fake-reply (`Re:`/`Fwd:`), shouting, and exclamation checks. |
| 3 | **Identify the message as an ad.** Must be disclosed "clearly and conspicuously". | `compliance.ts` → `no_advertisement_disclosure`. The footer carries a literal sentence and it is string-matched, in the same spirit as `assertDisclosed()` in `src/contract.ts`. |
| 4 | **Tell recipients where you're located.** A **valid physical postal address** — a street address, a USPS-registered PO box, or a private mailbox with a commercial mail receiving agency. | `compliance.ts` → `no_postal_address`. Reads `OUTREACH_POSTAL_ADDRESS`; absent or placeholder-shaped ⇒ **blocked**. |
| 5 | **Tell recipients how to opt out**, in a way "easy for an ordinary person to recognize, read, and understand". | `compliance.ts` → `no_unsubscribe`. Requires an `https://` opt-out URL present in the body **and** a `List-Unsubscribe` header, plus the Closer's reply-based opt-out sentence. |
| 6 | **Honor opt-out requests promptly** — within **10 business days**. The mechanism must work for at least 30 days after sending, and you may not charge a fee, demand any PII beyond an email address, or require more than a reply or a single web page. | `suppression.ts`. `unsubscribe(email)` appends to an append-only list; `isSuppressed()` is checked by the gate before every send. Ten business days is the legal ceiling; the list takes effect on the next send. |
| 7 | **Monitor what others do on your behalf.** Both the company whose product is promoted and the company that sends can be held legally responsible. | Stated, not automated. We are the only sender. If a reseller is ever added, this row becomes a task. |

**Penalties.** Each separate email in violation is subject to a civil penalty of
up to **$53,088** (the FTC's inflation-adjusted figure). That number is the reason the
gate blocks rather than warns.

**Not covered by any of this:** GDPR/PECR for EU/UK recipients (consent, not opt-out, for
most B2C; legitimate-interest arguments for B2B are narrower than people assume), CASL in
Canada (express or implied consent required *before* sending), and US state laws. The
Closer's `decideChannel()` already routes on consent basis rather than convenience, which is
stricter than CAN-SPAM requires — CAN-SPAM is opt-out, not opt-in. **We have not built
jurisdiction detection.** A human must confirm the recipient list is US before arming.

---

## 3. What is in `src/company/outreach/`

```
transport.ts    pluggable sender: resend | file | null. Config from env. Degrades, never throws.
compliance.ts   the HARD GATE. Runs on every message. Can BLOCK, and blocking stops the send.
suppression.ts  append-only opt-out list on disk + unsubscribe(email). Checked before every send.
send.ts         sendPitch(). Dry run by default. Logs every attempt to the DecisionLog.
index.ts        re-exports.
```

**The gate is the point.** `gateMessage()` returns `{ allowed, violations }` and `sendPitch()`
does not call the transport when `allowed` is false. The violations it can raise:

| Code | Blocks because |
|---|---|
| `suppressed` | Recipient is on the suppression list. Terminal. |
| `no_postal_address` | CAN-SPAM #4. Absent, placeholder, or not present in the body. |
| `no_unsubscribe` | CAN-SPAM #5. No `https://` opt-out URL in the body, or no `List-Unsubscribe` header. |
| `no_reply_route` | The opt-out reply would reach nobody. |
| `no_advertisement_disclosure` | CAN-SPAM #3. |
| `deceptive_subject` | CAN-SPAM #2. Empty, fake reply, shouting, invented urgency, unsupported claim. |
| `no_sender_identity` | CAN-SPAM #1. `from` missing or unparseable. |
| `header_injection` | A CR/LF in any header value. This is a security check, not a legal one: a newline in a recipient address forges headers. |
| `invalid_recipient` | Not a parseable address. |
| `unmeasured_metric` | The body asserts a number the measurement does not support. |

`unmeasured_metric` is the one that is ours rather than the law's. It reuses the Closer's
`allowedNumbersFor()` / `findFabricatedNumbers()`: every numeric token in the composed
message must be derivable from the `InvisibilityScore` we actually measured, or be a masked
literal (the postal address, the opt-out URL, the addresses, the year). **When no evidence is
supplied at all, every number in the body is unverifiable and the gate blocks.** Asserting a
measured fact about a stranger that we did not measure is fraud, not marketing, and the fail
direction is closed rather than open.

---

## 4. How to run it

```bash
# Dry run. Default. No network, and no file unless you name an outbox.
node --experimental-strip-types -e 'import("./src/company/outreach/index.ts")'

npm test                      # includes src/company/__tests__/outreach.test.ts
npx tsc --noEmit
```

The tests prove, mechanically: the gate blocks each violation class; a suppressed address is
never sent to; a dry run makes zero calls to `fetch` (the injected `fetchImpl` throws if
touched); and a missing `RESEND_API_KEY` degrades to the file transport without throwing.

---

## 5. What is still stubbed, stated rather than hidden

1. **Nothing has been sent.** Not once. `LIVE_SEND` is `0`, no domain is verified, and no
   `RESEND_API_KEY` is set. The transport is written and tested against an injected fetch; it
   has never made a real HTTPS request. A human arms it.
2. **No bounce, complaint or delivery webhooks.** Resend reports these and we do not consume
   them, so the suppression list only grows from an explicit `unsubscribe()` call. A hard
   bounce would be re-sent to on a later run.
3. **No inbound reply handling.** The Closer's copy says `Reply "no" and we will not contact
   you again.` Honouring that is currently a human reading the inbox and calling
   `unsubscribe()`. Within the 10-business-day window, but manual.
4. **No `Idempotency-Key`.** Two runs against the same prospect inside the frequency cap are
   already refused by the Closer's gate, but a crash between the transport call and the log
   append could double-send.
5. **No List-Unsubscribe-Post one-click endpoint behind the URL.** The header is set and the
   URL is required, but the page it points at is part of the advertiser site and does not yet
   record the opt-out automatically — `unsubscribe()` has to be called.
6. **No jurisdiction check.** See §2.

---

## 6. The single biggest risk

The gate is a **blocklist against a language model**, and blocklists are incomplete by
construction. `deceptive_subject` catches the phrases an LLM reaches for unprompted; it does
not catch a subject that is deceptive in a way we did not enumerate. The number guard is
stronger — it is an allow-list, so an invented statistic fails closed — but a fabricated
*qualitative* claim ("your competitors are all moving to this") passes every check in this
directory. The mitigation is that the copy path is the Closer's deterministic template by
default and the model draft is discarded on any violation, not that the gate is complete.
