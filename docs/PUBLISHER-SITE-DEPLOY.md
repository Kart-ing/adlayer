# Publisher site deploy — runbook

**BLUF.** Deploy three static sites to Render, verify each serves `/llms.txt` as `text/plain` with the injection slot intact, then fix hostnames everywhere if Render renames them. Until this is done there is nothing for the propagation measurement to observe, and the headline result cannot exist.

**Owner:** Parth. **Blocks:** baseline capture → first placement → every propagation number.

Everything below is committed and ready. No code needs writing.

---

## 0. What you are deploying, and why it matters

Three real static sites under `publishers/`. They are the experimental apparatus: we inject a disclosed sponsored entry into their `llms.txt`, then poll answer engines to see whether the entry propagates and whether the `[SPONSORED]` label survives.

| Slug | Niche | Assumed host |
|---|---|---|
| `rink-ops` | Community ice rink operations | `adlayer-rink-ops.onrender.com` |
| `darkroom-commons` | Shared black-and-white darkrooms | `adlayer-darkroom-commons.onrender.com` |
| `loop-notes` | Assistive listening / hearing loops | `adlayer-loop-notes.onrender.com` |

No build step, no dependencies, no framework. Each directory publishes as-is.

## 1. Deploy

```bash
# Render reads Blueprints from the REPOSITORY ROOT, not from publishers/.
cp publishers/render.yaml ./render.yaml
git add render.yaml && git commit -m "render: publisher blueprint at repo root" && git push
```

> If a root `render.yaml` already exists for the ad server, **merge** the three `services:` entries into it. Do not overwrite.

Then in the Render dashboard: **New → Blueprint →** point at `Kart-ing/adlayer` → **Apply**. Three static sites appear. There is no build command, so they go live in under a minute.

Claim hackathon credits first if you have not: https://credits-portal-mmdm.onrender.com/claim/terac-hackathon

## 2. Verify — all three must pass

```bash
for h in adlayer-rink-ops adlayer-darkroom-commons adlayer-loop-notes; do
  echo "── $h"
  curl -sI "https://$h.onrender.com/llms.txt"   | head -3
  curl -s  "https://$h.onrender.com/llms.txt"   | grep -c ADLAYER_SLOT
  curl -s  "https://$h.onrender.com/robots.txt" | grep -iE "GPTBot|ClaudeBot|PerplexityBot|Google-Extended"
done
```

Required:

- `/llms.txt` → **HTTP 200**, `Content-Type: text/plain`
- `grep -c ADLAYER_SLOT` → **exactly 1**
- `/robots.txt` names all four AI crawlers as **Allow**

If `robots.txt` blocks the crawlers we are measuring, the experiment measures nothing. Check it rather than assuming.

## 3. ⚠️ If Render assigns different hostnames

Render appends a suffix when a service name is taken. If any host differs from the table above, **three** things must change or serving breaks:

```bash
# 1. Site files (absolute URLs in llms.txt, robots.txt, sitemap.xml)
sed -i '' 's|adlayer-rink-ops.onrender.com|ACTUAL-HOST|g' publishers/rink-ops/*

# 2. The registry — this one is easy to miss
#    publishers/registry.json carries `domain` per publisher.
```

**Why the registry matters:** `domain` is written into the signed provenance comment of every served block. If the registry says one host and the site lives at another, the provenance record points at a domain that does not exist, and `parseVerifiedProvenance` will attribute the placement to the wrong property. The measurement then cannot prove the ad came from us.

```bash
# 3. Re-run the suite — registry tests assert the real slugs and hosts
npm test
```

## 4. Then, in this order — order is not negotiable

**a. Capture pre-serve baselines FIRST.**

```bash
npm run poll          # see src/prove/poll.ts for the baseline entrypoint
```

This records what answer engines say about our target queries *before* any ad exists. Without it we cannot tell "the advertiser appeared because of our placement" from "the advertiser was already there." The classifier has a `cited_unattributed` state specifically for that case, and it needs a baseline to reach it.

**This is the one step that cannot be reconstructed afterwards.** Once an ad is live, the pre-serve state is gone forever.

**b. Serve the first placement.**

```bash
LIVE_SERVE=1 npm run serve
```

Note the exact `served_at`. Propagation latency is measured from it.

**c. Poll on a schedule.** Target `perplexity/sonar` first — it does live retrieval at query time, so it can surface a page in minutes. Ingestion-based engines are the slow control arm and get reported separately, never averaged together.

## 5. Blocker you will hit at step 4b

**Serving currently refuses everything.** Pioneer inference returns `403 card_required`, so the compliance agent fails closed and no placement ships. That is correct behaviour, not a bug.

Fix: redeem the plan at https://agent.pioneer.ai/billing with promo `ZeroHumanHack0826`. See `docs/PIONEER.md`.

There is an `ADLAYER_ALLOW_UNMODERATED=1` override, but if you serve with it, **every propagation finding downstream came from an unmoderated placement and the writeup has to say so.** Redeem the plan instead.

## 6. Render prize track — hosting alone does not qualify

The guidebook is explicit: *"Projects must use Render Workflows to qualify for the winner prizes."* Deploying three static sites is necessary for the experiment but earns nothing on that track.

To qualify, the scheduled propagation poll (step 4c) must run as a **Render Workflow**: https://render.com/workflows

That is a separate piece of work from this runbook, and it is the cheapest remaining $500 on the board.

## 7. Definition of done

- [ ] Three sites live, `/llms.txt` returns 200 `text/plain` on each
- [ ] `ADLAYER_SLOT` present exactly once per site
- [ ] `robots.txt` allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended
- [ ] Hostnames match `publishers/registry.json`, or both were rewritten together
- [ ] `npm test` still green after any host rewrite
- [ ] **Pre-serve baselines captured and committed**
- [ ] First placement served, `served_at` recorded
- [ ] Poll loop running as a Render Workflow
