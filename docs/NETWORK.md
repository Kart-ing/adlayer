# NETWORK — PRD-A handoff

**Read this before you touch `src/serve/`.** The disclosure guarantee holds at five independent points. Twenty red-team findings were reproduced and fixed. Three real weaknesses remain, listed at the bottom. Owner: Person A.

---

## 1. What exists

| File | Does |
|---|---|
| `src/serve/render.ts` | Renders the sponsored block and merges it into an llms.txt. The disclosure chokepoint. |
| `src/serve/compliance.ts` | The veto. `reviewCreative()` returns a `ComplianceVerdict` and can say no. |
| `src/serve/pioneer.ts` | Pioneer client. GLiGuard moderation, GLiNER2 extraction. Degrades, never throws. |
| `src/serve/registry.ts` | Loads and validates `publishers/registry.json`. Pairs creatives to publishers by category. |
| `src/serve/index.ts` | `servePlacement()`. The only thing that writes bytes to a publisher. |
| `publishers/registry.json` | The three live properties. |
| `publishers/{rink-ops,darkroom-commons,loop-notes}/` | Real static sites, real content, spec-valid `llms.txt`. |

Zero runtime dependencies in `src/serve/`. Node stdlib and global `fetch` only.

## 2. How to run it

```bash
npm install
npx tsc --noEmit                                     # src/ is clean
node --test --experimental-strip-types "src/**/__tests__/*.test.ts"

npm run serve                                        # lists publishers and creatives
npm run serve -- ad_rinkpro pub_rink-ops             # dry run: computes, writes nothing
LIVE_SERVE=1 npm run serve -- ad_rinkpro pub_rink-ops   # writes the publisher's llms.txt
```

Everything runs keyless. A missing `PIONEER_API_KEY` logs one line and holds the creative. It never approves one.

Creatives come from `creatives.json` at the repo root — a JSON array of `Creative` (see `src/contract.ts`), written by Person B's intake. A missing file logs one line and returns an empty list.

Environment:

| Variable | Default | Effect |
|---|---|---|
| `LIVE_SERVE` | `0` | Writes to a publisher's llms.txt. |
| `PIONEER_API_KEY` | unset | Enables GLiGuard. Unset holds every creative at `pending_review`. |
| `ADLAYER_SECRET` | dev secret | HMAC key for provenance signatures. Unset signs with a public value. |
| `ADLAYER_ALLOW_UNMODERATED` | `0` | Serves creatives held only because Pioneer was unreachable. Read §5. |

## 3. The disclosure guarantee, and exactly where it is enforced

Every served block carries `[SPONSORED]` three times and the full `DISCLOSURE_NOTICE`. There is no flag that turns this off.

Five checks enforce it. They are independent — removing any one leaves the other four standing.

| # | Where | Check |
|---|---|---|
| 1 | `render.ts` `sanitizeCreativeText` | Advertiser copy cannot contain the tag, a lookalike, or the word "sponsor". NFKC first, then the whole `\p{Ps}`/`\p{Pe}` categories fold to parentheses. |
| 2 | `render.ts` `assertBlockIntegrity` | The block is exactly 3 lines, carries exactly 3 tags, 1 HTML comment, and 1 signed provenance record. A forged fourth tag moves the count and the render refuses. |
| 3 | `render.ts` `renderBlock` | `assertDisclosed()` on its own output, last statement before return. |
| 4 | `render.ts` `renderLlmsTxt` | `assertDisclosed()` on the whole merged file. |
| 5 | `index.ts` `servePlacement` | `assertDisclosed()` on `rendered_block` and on the file, immediately before returning and before any write. Independent of the renderer. |

The compliance veto adds a sixth, upstream: `checkDisclosure()` renders the creative and string-matches the output rather than trusting that `renderBlock` did its job. A missing disclosure is a hard fail no moderation score overrides.

**The serving gate is an allowlist.** `servabilityReason()` in `render.ts` is the single definition, used by both `renderLlmsTxt` and `servePlacement`, so the two cannot drift. A creative serves only when all of this holds:

- `review !== null` — a creative that was never reviewed never serves, at any status.
- `review.passed === true` and `review.disclosure_present === true` and `review.flags` is empty.
- `status` is `approved` or `live`.
- `creative.id` matches `/^[A-Za-z0-9._:-]{1,64}$/`.

## 4. What red team tried, and what held

Twenty findings. All twenty reproduce as fixed. Each has a regression test that fails without the fix.

**Disclosure and label integrity**

| Attack | Now |
|---|---|
| `【NOT SPONSORED】` counter-label inside a disclosed block | Lenticular, white-square and flower brackets fold to parens. The word "sponsor…" is redacted from copy. Compliance blocks the creative outright. |
| Fullwidth `［ＳＰＯＮＳＯＲＥＤ］`, zero-width inside the token | Compliance and render now share one NFKC + invisible-strip prelude, so both see the same codepoints. Blocked. |
| Heading hidden behind U+0085 / U+2028 | Copy is split on every line-break form before the heading test. Flagged. |

**The veto**

| Attack | Now |
|---|---|
| Unreviewed creative renders (`status: "pending_review"`, `review: null`) | Allowlist. Refused at every status. This was the critical one — the veto never had to be removed, only skipped. |
| `passed: true` with flags and `disclosure_present: false` | `verdictStatus()` derives instead of trusting the boolean. Corrupted verdict means blocked. |
| `threshold: NaN` (an unset env var) nullifies every flag | Bad thresholds fall back to the default. Valid ones clamp to it. Callers can only tighten. |
| GLiGuard answers 1 of 3 tasks and reads as clean | `ran` now means every requested task answered. `jailbreak_detection` cannot silently skip. |
| A queued-request ack (`{"status":"safe"}`) counts as a review | Hits attributed to tasks we did not ask about are dropped. |
| Malformed creative crashes the reviewer | `checkStructure` coerces. Empty copy raises `emptyCopy` and blocks. |
| Moderation client resolves to `undefined` | Shape-checked after the await. Degrades to `pending_review`. |

**Provenance and measurement**

| Attack | Now |
|---|---|
| Copy emits a rival's `ad_id=` so Person B logs a false propagation | Provenance vocabulary is redacted from copy and percent-escaped in URLs. `assertBlockIntegrity` asserts each token appears exactly once, inside our comment. |
| `target_url` fragment carries `#ad_id=ad_victim` | Same. `=` becomes `%3D` after those keys. |
| Anyone who can write a file mints a provenance record | Records carry `sig=` — HMAC-SHA256 over `ad_id|served_at|publisher|domain`, 16 hex. `parseProvenance` returns `verified`. Use `parseVerifiedProvenance`. |
| Foreign provenance comment in the base file survives | Every `<!-- adlayer:` comment is stripped from base before merge. |
| `sanitizeId` collisions: `ad@01H8X` and `ad_01H8X` share one record | Ids are validated, never coerced. A non-conforming id is a `RenderRefusal`. |

**The publisher's file**

| Attack | Now |
|---|---|
| Stray or prose `ADLAYER_SECTION_BEGIN` deletes editorial content on re-render | The region regex is line-anchored and refuses to span a nested opener. Unbalanced fences throw `RenderRefusal` rather than rewriting. |
| Editorial links after the slot inherit the `## Sponsored` scope | The enclosing heading is re-emitted after `SECTION_END`. If none exists, the render refuses. |
| Two identical `## Sponsored` headings | Suppressed when the publisher's file already supplies one above the slot. |
| Whitespace tidy rewrote publisher bytes | Removed. Only the AdLayer region and its two seams are touched. Hard line breaks and code fences survive. |
| IPv6 host `[::1]` as fallback anchor text breaks link extraction | The hostname fallback runs through the structure fold. |

Registry: three publishers on unresolvable `*.example` domains, none matching a built site. Replaced with the three live properties. `assertPublisherAssets()` fails loudly if any registry id stops resolving to a `publishers/<slug>/llms.txt` containing the slot marker.

**Suite: 344 tests, 0 failures.** `npx tsc --noEmit` reports nothing in `src/serve/`.

## 5. What is still weak

Read this section before you cite anything in a writeup.

**`ADLAYER_ALLOW_UNMODERATED` can serve an unmoderated creative.** Keyless development produces `pending_review` for everything, so nothing would serve and the 13:00 gate would fail. The override is off by default, permits only creatives whose sole flag is `moderation_unavailable`, never rescues an unreviewed or content-flagged creative, logs a loud line, and sets `unmoderatedOverride: true` on the serve result. It is still a hole. Any placement served this way carries the disclosure but not a completed moderation pass. Say so.

**Provenance signatures prove nothing in public.** `ADLAYER_SECRET` defaults to a value in the source. Until someone sets a real secret, a signature only proves the record came from a copy of this repo. It stops an outside forgery from counting; it does not stop us forging our own.

**We rewrite copy silently.** Redacting "sponsor…" and `ad_id=` changes what the advertiser wrote without telling them. Compliance blocks that copy first, so it should never reach the renderer — but if it does, we publish mangled text under their name. A rejection queue would be better.

**We percent-escape `?ad_id=` in destination URLs.** Advertisers really do use that parameter for their own tracking. Their landing page still resolves; their attribution breaks. This is a deliberate trade against provenance forgery and it will surprise someone.

**`assertBlockIntegrity` refuses on `sig=`, `serve=`, `publisher=` in a URL.** Same class of problem. A legitimate destination carrying `?publisher=acme` gets escaped rather than served as typed.

**The heading-scope refusal is new and untested against real publisher files.** All three shipped sites put the slot last, so the path never fires in production. If a publisher moves their marker mid-document with non-heading content after it, `renderLlmsTxt` throws instead of serving.

**`npx tsc --noEmit` fails on 39 pre-existing errors in `engine/`.** Those predate this work and PRD-A forbids touching that directory. `tsconfig.json` includes `engine/**`. Whoever owns the build should either fix the port or drop `engine/**` from `include`.

**One creative per publisher, one publisher per call.** `servePlacement` serves a single pairing. Multiple concurrent placements on one publisher would need a batch path; `renderLlmsTxt` already accepts an array, `servePlacement` does not use it.

**Nothing verifies the deployed sites.** `assertPublisherAssets` checks the repo, not the live host. `verified_at` is `null` on all three. Confirm `curl https://HOST/llms.txt` returns 200 with the marker before serving.
