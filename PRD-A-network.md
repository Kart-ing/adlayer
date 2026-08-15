# PRD-A — THE NETWORK

**Own supply, serving, and the veto. Ship a disclosed sponsored block into a real llms.txt on a real domain by 13:00.**

Read `src/contract.ts` first. It is law. Emit those shapes exactly.

You do not block on Person B after 12:00. They read your `placements[]`; you never read theirs.

---

## 1. What you own

```
src/serve/render.ts        llms.txt rendering + disclosure enforcement
src/serve/registry.ts      publisher registry
src/serve/compliance.ts    the veto
src/serve/pioneer.ts       GLiGuard + GLiNER2 client
src/serve/index.ts         ad server entrypoint
publishers/                3 real demo sites + render.yaml
```

Do not touch `src/prove/`, `web/`, or `engine/`.

## 2. Deliverables

### 2.1 Renderer — `render.ts`

`renderBlock(creative, publisher): string`

Renders one sponsored entry. Must embed `DISCLOSURE_TAG` and `DISCLOSURE_NOTICE`. Must call `assertDisclosed()` on its own output before returning. Include `ad_id` and ISO `served_at` inside the block — Person B string-matches those to prove provenance.

`renderLlmsTxt(publisher, creatives, baseContent): string`

Merges a `## Sponsored` section into an existing llms.txt body at the `<!-- ADLAYER_SLOT -->` marker. **Never interleave ads into editorial link lists.** Sponsored content sits in its own delimited section or it does not ship.

Target format:

```markdown
## Sponsored

<!-- AdLayer: the entries below are paid placements, not editorial recommendations. -->

- [Acme Gutters](https://acme.example) [SPONSORED]: Gutter installation in Baton Rouge.
  <!-- adlayer: ad_id=ad_01H8X serve=2026-08-15T13:02:11Z -->
```

### 2.2 Registry — `registry.ts`

Load/save `Publisher[]` from `publishers/registry.json`. Lookup by domain and by category. Category match is what pairs a creative to a publisher.

### 2.3 Compliance — `compliance.ts` + `pioneer.ts`

`reviewCreative(creative): Promise<ComplianceVerdict>`

1. GLiGuard moderation over title + body + target_url.
2. Independently verify the *rendered* block carries the disclosure.
3. `passed = false` if moderation flags fire **or** disclosure is absent.

**Disclosure failure is a hard fail no moderation score can override.** This function is the Band veto and the Pioneer track in one.

Pioneer: base `https://api.pioneer.ai`, header `X-API-Key`. Confirm the encoder-inference request shape against docs before coding — GLiGuard's response format is not documented in the pages read so far. Missing key must degrade, never crash.

### 2.4 Demo publishers — `publishers/`

Three static sites we own, deployed on Render. Each needs:

- A narrow niche with genuinely thin existing coverage. Narrow is better — it makes propagation detectable above noise.
- 4–6 pages of **real, useful content**. Thin or fake content invalidates the experiment.
- Valid `/llms.txt` per llmstxt.org, with the `<!-- ADLAYER_SLOT -->` marker.
- `/robots.txt` **allowing** GPTBot, ClaudeBot, PerplexityBot, Google-Extended. Blocking the crawlers we are measuring kills the experiment.
- A visible note that the site is a demo property. No invented businesses presented as real.

### 2.5 Superserve

Publisher crawls and verification run in Superserve sandboxes, paused between publishers. That is the $1,000 track and it is genuinely the right tool — you are running untrusted fetches against arbitrary domains.

## 3. Acceptance

- [ ] `npx tsc --noEmit` clean
- [ ] Test proving `assertDisclosed()` throws when the tag is stripped
- [ ] Fuzz test: `renderBlock` output contains the tag across randomized inputs
- [ ] Test: clean creative passes; flagged creative blocks; **missing disclosure blocks even when moderation is clean**
- [ ] Test: absent `PIONEER_API_KEY` degrades without throwing
- [ ] 3 publisher sites live on public Render URLs with valid llms.txt
- [ ] **13:00 — first real placement served, `served_at` recorded**

## 4. Rules

- Zero new runtime deps in `src/serve/`. Node stdlib and global fetch.
- Everything runs keyless in development.
- `LIVE_SERVE=0` by default. Writing to a real publisher llms.txt requires the flag.
- There is deliberately no code path that emits an undisclosed block. Do not add one.
- Do not run `codex exec`. Disabled globally.

## 5. The 13:00 gate

Answer engines take hours to pick anything up. If nothing is served by 13:00, Person B has nothing to measure and the project has no result.

Serve at 13:00 even if compliance is still stubbed and only one publisher is live. Hand-verify that one block, ship it, then keep building. Same lesson as firing the IndexNow ping at minute 10 on CITED.
