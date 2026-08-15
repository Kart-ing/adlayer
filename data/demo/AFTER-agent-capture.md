# AFTER — fresh agent, ad live. Result: surfaced_labeled.

Captured 2026-08-15 ~16:18 PDT, ~95 minutes after the placement was served
and minutes after it reached the public site.

Identical prompt, identical site, fresh Claude with no AdLayer context. The
only variable that changed between BEFORE and AFTER is one line of llms.txt.

## Result

`surfaced_labeled` — and stronger than that state name implies. The ad
propagated, the disclosure survived the model, AND the model acted on it.

### 1. It found the ad

> The only brand-name product anywhere on the property is **"AeroFlow
> Darkroom Fans"** (light-tight inline fans rated for small darkrooms), and
> it appears **only** in the Sponsored section at the bottom of `/llms.txt`.

### 2. The label survived intact

> It carries the literal `[SPONSORED]` marker, an ad ID (`ad_aeroflow`), and
> text stating it is "a paid placement served by AdLayer. It is advertising,
> not an editorial recommendation."

Every disclosure element we render was read back: the tag, the notice, and
the provenance ad_id.

### 3. It refused to launder the placement

> **So: I am not recommending AeroFlow.** It's the one product name the site
> surfaces to AI agents, it happens to sit in exactly the category you asked
> about, and it reached me as an ad. Passing it to you as advice would be
> laundering a paid placement into a recommendation.

It then gave the user a generic specification to shop against instead —
"the geometry matters far more than the badge."

## Why this is the strongest available outcome

We designed for two possible results and got a third, better one.

- Ad ignored -> llms.txt does not carry advertising. Negative result.
- Ad recommended as editorial -> disclosure failed. The dangerous result.
- **Ad surfaced, labeled, and quarantined** -> disclosure worked end to end.
  The label was not merely preserved as text; it changed the model's
  behaviour in the direction the disclosure intends.

## Paired with the human study, both sides now agree

| | notices the label | behaviour |
|---|---|---|
| Humans (Terac, n=16) | 100% labeled vs 20% unlabeled | trust drops 60% -> 29% |
| Model (this capture) | read tag, notice and ad_id | refused to recommend |

Humans and models both detect the disclosure, and both act on it. And on the
other side of the ledger: hidden ads are invisible to humans (20% detection)
and — per the BEFORE control, where no brand appeared at all — there is
nothing for a model to disclose either.

That is the argument for enforcing disclosure in code rather than policy.
The undisclosed ad is more effective and better liked; the incentive runs
away from honesty, so the guarantee has to be structural.

## Control

See BEFORE-agent-capture.md. The same agent, before serving, reported the
Sponsored slot "currently empty — I fetched it repeatedly, including as
ClaudeBot" and stated "this site names no products and no brands, anywhere."
