# What the data says to build next: a consented ad channel with a buyer's-agent gate

**The ad network we built works mechanically and fails commercially. The data
points at a different product, and it points hard.**

---

## What today measured

| Question | Result |
|---|---|
| Does a placement in `llms.txt` reach an agent's answer? | Yes — ~90% of runs when the agent reads the site |
| Does the `[SPONSORED]` label survive the model? | Unstable. Roughly 60–83%, and the rate moves between batches |
| Does an engine discover the placement from a cold category query? | **No. 0/6 on both engines** |
| Do humans notice the label? | 100% labelled vs 20% unlabelled (n=20, complete) |
| Does the label cost trust? | Yes. 27% labelled vs 60% unlabelled |

Two of those kill the business as originally pitched.

**Cold discovery is zero**, so we are not selling "your ad appears in AI answers
about your category." We are selling "your ad appears to agents that already
visit this publisher" — ordinary display inventory sized to that publisher's
agent traffic.

**Outcome is unpredictable.** The same ad, same site, same model produced: a
recommendation (`"I'd prioritize AeroFlow"`), a disclosure
(`"marked [SPONSORED], compare it against..."`), an explicit refusal
(`"I am not recommending AeroFlow"`), and a stripped label. You cannot sell
performance on inventory where a quarter of impressions argue against the
product.

## The finding we filed as a failure is the product

The refusal case is not a bug in ad delivery. It is a **buyer's agent doing its
job**:

> I am not recommending AeroFlow. It's the one product name the site surfaces to
> AI agents, it happens to sit in exactly the category you asked about, and it
> reached me as an ad. Passing it to you as advice would be laundering a paid
> placement into a recommendation.

That is a model, unprompted, refusing to pass a paid placement to its user as
advice. We did not build that behaviour or ask for it. It is already there.

Every shopping surface has a seller's agent — the recommendation algorithm, the
scarcity timer, the one-click button. The buyer has never had one. This is the
first evidence that the buyer's agent now exists by default, and it changes what
the honest business is.

## The product

**A consented ad channel, gated by the user's own agent, targeted on live
intent.**

1. **Consent.** The agent opts in to receive placements. Disclosure stops being
   something we hope survives summarisation and becomes the premise of the
   channel.
2. **The gate.** The user's agent decides which placements are actually useful to
   *this* user, and drops the rest. It is working for the reader, not the
   advertiser.
3. **Intent targeting.** Placements are matched to what the person is asking
   right now, not to a profile assembled behind their back. The highest-value
   signal in advertising, available without surveillance.

Three of today's four problems collapse under this design:

- delivery becomes deterministic — the agent is deliberately reading the channel
- "did the label survive?" stops mattering — the agent asked for ads
- the refusal case disappears — an agent that opted in has no reason to argue
  against a placement it requested

And the trust finding stops being a problem to manage. We measured that hiding
the ad works better on humans: 20% detection, 60% trust. Under consent, honesty
is no longer a competitive disadvantage, because there is nothing to hide.

## Why we can build it and most cannot

A consented channel needs the agent to distinguish **a registered, disclosed
placement** from **text someone stuck on a page**. Without that, the channel is
just prompt injection with better manners, and every incentive pushes toward
faking it.

We already built the primitive: every served block carries an **HMAC-signed
provenance record**, and `parseVerifiedProvenance()` is the sanctioned matcher.
An agent can verify that a placement is genuinely ours, genuinely paid, and
genuinely disclosed — or refuse it.

That signature came out of a red-team finding: advertiser copy could forge a
rival's provenance field. Fixing it produced exactly the primitive a consented
channel requires.


## What ad copy becomes

The part that makes this more than a better ad network: **the creative changes
shape.**

Advertising to humans exploits a system with limited attention and predictable
irrationality. Scarcity timers, social proof, brand affect, attractiveness,
repetition — all of it is tuned to a reader who can be rushed, flattered, or
worn down.

None of that works on an agent holding its user's budget, prior purchases and
stated constraint. You cannot rush it. It does not care who endorsed you. It
will not see your ad eleven times.

So persuasion collapses into information. The winning ad is the checkable one:

> ~~"The world's best darkroom fans."~~
>
> **"Rated for 15-30 m³ rooms. 47 dB at 1 m. IP44. Light-tight to 0.001 lux.
> $180, ships Tuesday."**

The best creative becomes the most specific, most verifiable, best-fitted-to-
constraint — because that is what survives a gate that works for the buyer. An
advertiser competing here wins by having a product that genuinely fits, and by
saying so precisely. That is a market where honesty is the dominant strategy
rather than a handicap, which is the opposite of what we measured on humans
today.

It also converges with where commerce infrastructure is already heading. Once ad
copy is structured, checkable claims, an "ad" is barely distinguishable from a
product feed with verified attributes — which is roughly what the emerging
agentic-commerce protocols are building toward from the other direction.

**The adversarial version, stated plainly.** Advertisers will not simply accept
this. Copy engineered to manipulate an agent rather than inform it is exactly
prompt injection wearing a suit, and it is the same class of attack our own red
team used against the renderer — content shaped to look like something it is
not. A consented channel therefore needs the gate's criteria adversarially
tested the way we tested the disclosure guarantee: not reasoned about, attacked.
That is the difference between a channel that stays honest and one that becomes
the next SEO.

## The honest open problems

**Who pays when the gate rejects?** If the user's agent filters most placements,
advertisers are paying for impressions that never reach a human. Pricing has to
move to pass-through or to action. That is a real design problem, not a detail.

**The gate is both the integrity and the inventory constraint.** A strong gate
means high trust and low volume. A weak gate means it is ordinary advertising
again. Where that dial sits determines whether the business is defensible or
merely profitable.

**The gate is a language model, so advertisers will optimise copy to pass it.**
That is the SEO cycle again, one layer up. Our own red team found the class of
attack: copy engineered to look like something it is not. Any serious version
needs the gate's criteria to be adversarially tested the way the disclosure
guarantee was.

**Two-sided cold start.** Agent developers must adopt the opt-in before there is
inventory worth buying. That is a standards and distribution problem, and it is
harder than anything we built today.

## What we would say to an investor

Not "we built an ad network." That claim dies on the reach question, and we have
the number that kills it.

Instead: we built the ad network, served real disclosed placements, and measured
what happens when models read them. Disclosure survives most of the time and
fails often enough that a label alone is not a standard. Cold discovery does not
work. And the case everyone else would report as a failure — the model refusing
to pass the ad on — is the actual product.
