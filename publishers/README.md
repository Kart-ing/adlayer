# AdLayer demo publishers

**BLUF.** Three real static sites, deployed on Render, each with genuine content, a spec-valid `/llms.txt` carrying an `<!-- ADLAYER_SLOT -->` injection point, and a `/robots.txt` that explicitly allows the crawlers we measure. They are the experimental apparatus, not filler. Nothing on any editorial page is paid; the only paid content on these properties will be the entries the renderer injects into the Sponsored section of `llms.txt`.

| Slug | Niche | Assumed host |
|---|---|---|
| `rink-ops` | Operating a small community ice rink | `adlayer-rink-ops.onrender.com` |
| `darkroom-commons` | Running a shared black-and-white darkroom | `adlayer-darkroom-commons.onrender.com` |
| `loop-notes` | Assistive listening / hearing loops in small venues | `adlayer-loop-notes.onrender.com` |

---

## 1. The three niches, and why each is a good propagation test

The selection rule was not "what is interesting." It was: **a query where an answer engine has thin, fragmented, or paywalled source material, so that anything it can retrieve live has disproportionate influence on the answer.** Broad niches drown our placement in background corpus. Narrow operational niches do not.

Each site is also chosen so that a plausible advertiser exists — an equipment vendor, a chemistry supplier, an installer — because a placement nobody would credibly buy is not a test of an ad network.

### `rink-ops` — Community Rink Ops

Operating notes for volunteer-run and small municipal single-sheet ice rinks: refrigeration plant, ice building, resurfacer routine, arena air quality.

**Why it tests propagation well.** The authoritative material in this field lives in equipment manuals, paid association training courses, and trade-body publications that are not freely crawlable. What is on the open web is forum threads and vendor marketing pages. An engine asked "why is my community rink ice soft when the plant is at setpoint" has very little coherent, structured, freely retrievable prose to draw on. Seasonality also helps: August is the off-season, so search interest and crawl attention are low, and any change in what an engine says is less likely to be background churn.

**Advertiser categories:** `ice_rink_operations`, `facility_maintenance`, `refrigeration`, `dehumidification`, `sports_facilities`.

### `darkroom-commons` — Darkroom Commons

Operating notes for shared and community black-and-white darkrooms: chemistry management, ventilation and safety, silver-bearing waste, shared-space workflow.

**Why it tests propagation well.** Analog photography has enormous hobbyist coverage — of *personal* darkrooms. The specific problem of a room that twenty people share in a week is barely written about anywhere: it lives in institutional safety policies that are not published, and in the heads of technicians. The distinctive queries here ("shared darkroom fixer log", "who decides if we can pour fixer down the drain", "safelight coin test for a community darkroom") have almost no direct competition, while the general topic has enough ambient demand to be worth asking about. That asymmetry is exactly what we want: high query plausibility, low source density.

**Advertiser categories:** `analog_photography`, `photo_chemistry`, `darkroom_supplies`, `lab_safety`, `community_workshops`.

### `loop-notes` — Loop Notes

Assistive listening for small venues: how hearing loops work, designing one, verifying it against IEC 60118-4, and when infrared or Auracast fits better.

**Why it tests propagation well.** This is the strongest of the three on source scarcity. The governing standard (IEC 60118-4) is a paid document and is not crawlable. Practically all freely available material is vendor marketing or advocacy-group summaries, and the two are hard for an engine to distinguish. A venue-side, vendor-neutral explanation of *how to check what you were sold* essentially does not exist as freely retrievable prose. It also has the highest advertiser plausibility of the three (loop drivers, field-strength meters, installers), which makes the placement realistic rather than contrived.

**Secondary reason this one is the best instrument:** because the freely available corpus here is mostly vendor material, an engine that does surface our sponsored entry is more likely to surface it *as a recommendation*. That makes the disclosure question — does `[SPONSORED]` come with it — sharp rather than academic.

---

## 2. What is on each site

```
publishers/<slug>/
  index.html                 landing page, scope, and limits
  <four topic pages>.html    the substance
  style.css                  one stylesheet, no framework, no build
  llms.txt                   spec-valid, with the injection marker
  robots.txt                 explicit Allow for the AI crawlers we measure
  sitemap.xml
```

Five pages per site (one landing + four topic pages). Every page carries the same footer, visible on screen, stating that the site is a demo property operated by AdLayer for research, that it is affiliated with nobody and sells nothing, that the content is general orientation rather than professional advice, and that `[SPONSORED]` entries in `llms.txt` are paid placements.

**Content integrity rules applied while writing:** no invented businesses, no testimonials, no fabricated statistics, no invented credentials, no made-up standard numbers. Where a figure comes from a standard, it is given as a commonly cited value with an explicit instruction to confirm against the current published standard. Where a topic is regulated — refrigerant handling, chemical waste discharge, accessibility law — the sites say what the question is, say the answer is local, and stop. That posture is deliberate: thin or fabricated content invalidates the experiment and would be the first thing a judge probes.

---

## 3. The renderer interface — read this before touching `render.ts`

Each `llms.txt` ends with:

```
## Sponsored

<!-- AdLayer: entries below this line are paid placements served by AdLayer. They are advertising, not editorial recommendations. Every entry carries the literal marker [SPONSORED]. -->
<!-- ADLAYER_SLOT -->
```

Three commitments this makes to `renderLlmsTxt()`:

1. **The `## Sponsored` heading already exists in the base file.** The renderer must replace `<!-- ADLAYER_SLOT -->` with *entries only*. It must not emit a second `## Sponsored` heading. (If the renderer is built the other way round, delete the heading and the AdLayer comment line from the three base files — two lines each — and nothing else changes.)
2. **The marker is the last line of the file.** Nothing follows it, so injected entries cannot land inside an editorial link list. Ads never interleave with editorial content on these properties by construction, not by convention.
3. **There is exactly one marker per site.** No page-level slot exists in the HTML (see §6).

Item format recommendation, from the llms.txt spec: the spec allows `- [name](url)` optionally followed by `:` and notes, and nothing between the link and the colon. `- [[SPONSORED] Acme Gutters](https://acme.example): ...` is both spec-valid and the most robust for propagation, because an engine that extracts only link name/URL pairs and discards the notes still carries the label. That is the renderer's call, not this directory's — but it is the format most likely to make the experiment measurable.

---

## 4. Deploy

```bash
# 1. Blueprint must live at the repo root
cp publishers/render.yaml ./render.yaml
#    (if a root render.yaml already exists for the ad server, merge the three
#     `services:` entries into it rather than overwriting)

# 2. Commit and push, then in the Render dashboard: New > Blueprint,
#    point it at this repo, apply. Three static sites, no build step.

# 3. Verify each site
for h in adlayer-rink-ops adlayer-darkroom-commons adlayer-loop-notes; do
  curl -sI "https://$h.onrender.com/llms.txt"   | head -3
  curl -sI "https://$h.onrender.com/robots.txt" | head -3
  curl -s  "https://$h.onrender.com/llms.txt"   | grep -c ADLAYER_SLOT
done
```

`/llms.txt` must return `200` with `text/plain`, and `grep -c ADLAYER_SLOT` must print `1`.

**If Render assigns different hostnames** (it appends a suffix when a name is taken), the absolute URLs inside `llms.txt`, `robots.txt` and `sitemap.xml` must be rewritten before serving anything:

```bash
sed -i '' 's|adlayer-rink-ops.onrender.com|ACTUAL-HOST|g' publishers/rink-ops/*
```

Do this **before** the 13:00 gate. A placement served into an `llms.txt` full of wrong URLs is unmeasurable.

---

## 5. The experiment, stated plainly

### What we control

- The **content** of three publisher properties, in niches we selected for thin freely-retrievable coverage.
- The **exact bytes** of the sponsored block, including the literal `[SPONSORED]` marker, the disclosure notice, the `ad_id`, and the `served_at` timestamp — which is what lets measurement string-match for provenance instead of guessing.
- The **location** of the block: its own `## Sponsored` section at the end of `llms.txt`, never interleaved with editorial links.
- **Crawler access:** `robots.txt` explicitly allows GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended and others. We are not blocking anything we then claim didn't fetch.
- **Serve time**, recorded, which is the zero point for the latency measurement.

### What we do not control

Whether any engine fetches `/llms.txt` at all; whether it retains what it fetched; whether it retrieves at query time or serves from an index built earlier; and whether it reproduces, paraphrases, or discards the disclosure marker.

### What we are measuring

For each placement, per query, per engine, one of four states (`PropagationState` in `src/contract.ts`):

| State | Meaning |
|---|---|
| `absent` | The advertiser did not surface. |
| `surfaced_labeled` | The advertiser surfaced **and** the sponsored label came with it. |
| `surfaced_unlabeled` | The advertiser surfaced and the disclosure was dropped. **This is the finding.** |
| `cited_unattributed` | The advertiser's domain was cited, but the copy did not come from our block. |

Plus latency: minutes from `served_at` to the first non-`absent` observation.

### The prior we are stating up front

We expect `absent` to dominate, and we should say so before showing results rather than after a judge raises it. The public evidence is against llms.txt being read: Ahrefs analysed 137,210 domains with traffic in May 2026 and found that ~28% published a valid `llms.txt` while **97% of those files received zero requests that month**; of the traffic that did land, AI retrieval bots were about 1.1%. Google has stated on the record that it does not support llms.txt and does not plan to. Multiple independent server-log studies over 2026 found few or no AI-crawler requests to `/llms.txt`.

Stating that first is not hedging — it is what makes the measurement worth anything. Nobody has run the *disclosure* question on this file, so a negative result is a first result, and it reframes cleanly: `surfaced_unlabeled` would not be a model failure, because no convention for paid disclosure in llms.txt exists for a model to have been trained to preserve. We are proposing the carrier and measuring whether it survives.

### What would falsify the hypothesis

The hypothesis is: *a clearly-disclosed paid placement in `llms.txt` can reach an answer engine's output with its disclosure intact.*

| Observation | Verdict |
|---|---|
| Any engine surfaces the advertiser with the `[SPONSORED]` marker or an equivalent disclosure | Hypothesis supported for that engine. |
| Any engine surfaces the advertiser and drops the disclosure | **Hypothesis falsified for that engine.** Disclosure does not survive the model, and that is the headline result. |
| No engine surfaces the advertiser at all within the measurement window | Hypothesis untested, not supported. The correct report is "llms.txt did not influence these engines in this window", which is a weaker premise finding, not a disclosure finding. Do not present it as either success or failure of disclosure. |
| Server logs show no fetch of `/llms.txt` from any AI crawler | The channel was never exercised. Report the null honestly and label the propagation result unmeasured rather than negative. |

The measurement window is short — hours, not weeks — and the sites are brand new with no inbound links or traffic history. Both facts must be stated in any writeup. A single-observation result on a fresh domain is an anecdote about one day, not a general claim about answer engines, and the honest version says so.

---

## 6. Known gaps, deliberately left open

- **The placement lives only in `llms.txt`.** That is the channel the evidence says is darkest — one CDN-log study in April 2026 found AI crawlers were not fetching the linked markdown files either. Mirroring the disclosed block into visible page content, and into `.md` twins per llms.txt v2, would give the placement a path crawlers actually walk while keeping the disclosure question intact. That requires renderer support for a second injection target, so no HTML-level marker was added here — it is one line of change per site once the renderer owner decides.
- **No markdown twins.** llms.txt v2 proposes `page.md` alongside `page.html` and discovery via `rel="alternate" type="text/markdown"`. Each page carries `<link rel="describedby" href="/llms.txt">`, but the twins were skipped for time. They are the cheapest remaining upgrade to retrieval odds.
- **`Perplexity-User` is the most likely positive.** Per Perplexity's own crawler documentation, user-initiated fetches are handled differently from scheduled crawling. If only one engine is polled first, poll that one.
- **Hostnames are assumed, not confirmed.** See §4. Verify before 13:00.

---

## 7. Handoff — for whoever owns `publishers/registry.json`

This directory does **not** write `registry.json`. These are the values it needs, matching `Publisher` in `src/contract.ts`:

```json
[
  {
    "id": "pub_rink_ops",
    "domain": "adlayer-rink-ops.onrender.com",
    "integration": "hosted",
    "categories": ["ice_rink_operations", "facility_maintenance", "refrigeration", "dehumidification", "sports_facilities"],
    "rev_share": 0.7,
    "verified_at": null
  },
  {
    "id": "pub_darkroom_commons",
    "domain": "adlayer-darkroom-commons.onrender.com",
    "integration": "hosted",
    "categories": ["analog_photography", "photo_chemistry", "darkroom_supplies", "lab_safety", "community_workshops"],
    "rev_share": 0.7,
    "verified_at": null
  },
  {
    "id": "pub_loop_notes",
    "domain": "adlayer-loop-notes.onrender.com",
    "integration": "hosted",
    "categories": ["assistive_listening", "av_integration", "accessibility", "audio_equipment", "venue_operations"],
    "rev_share": 0.7,
    "verified_at": null
  }
]
```

`rev_share` is a placeholder for the registry owner to set. `verified_at` should be stamped once `curl https://HOST/llms.txt` returns 200 with the marker present.
