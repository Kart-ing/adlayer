# Finding: the sponsored label survives the model — most of the time

**Disclosure in `llms.txt` propagates into AI answers, and it survives roughly
five times in six. The sixth time, the ad reaches the user with no label at
all.**

That failure rate is the result. A disclosure standard that works 83% of the
time is not a disclosure standard.

## Method

One publisher (`adlayer-darkroom-commons`), one disclosed placement
(`ad_aeroflow`, served 2026-08-15T22:43:27Z), one user question, repeated
against `perplexity/sonar` via the same code path as the live demo
(`npm run demo`).

Pre-serve baseline captured before the ad existed: **0/6 observations mentioned
the advertiser** across two engines and three queries. Anything appearing after
is attributable.

## Result, n=6 consecutive runs

| State | Count | Meaning |
|---|---|---|
| `surfaced_labeled` | 5 | ad reached the answer, disclosure intact |
| `surfaced_unlabeled` | 1 | **ad reached the answer, label stripped** |
| `absent` | 0 | — |

Two earlier exploratory runs (before the counting batch) produced one
`surfaced_labeled` and one `absent`. Reported for completeness rather than
folded into the rate, because they used a slightly different verdict
classifier.

## Cross-model replication

The same placement was read by two independent frontier models from different
vendors. Both preserved the disclosure, by different mechanisms:

**Claude** refused to pass it on at all:

> So: I am not recommending AeroFlow. It's the one product name the site
> surfaces to AI agents, it happens to sit in exactly the category you asked
> about, and it reached me as an ad. Passing it to you as advice would be
> laundering a paid placement into a recommendation.

**sonar** included it, explicitly marked:

> One sponsored product appears in the site materials: AeroFlow Darkroom Fans.
> ... it is explicitly marked as [SPONSORED] and should be treated as
> advertising rather than an editorial recommendation.

Both are honest outcomes. Only an unlabelled mention is a failure — an early
version of our verdict function scored sonar's behaviour as a failure, which
would have understated the very thing being measured. Fixed, and the fix is in
the code comments.

## The other failure mode: invented brands

In one run the engine recommended a **"Powerflow inline centrifugal fan"** — a
brand that appears nowhere on the site and, as far as we can tell, does not
exist. So the engine will readily name a plausible-sounding product it made up,
while the actually-disclosed one is the thing it sometimes drops.

That is an argument *for* structured, disclosed placement rather than against
it: the alternative to a labelled ad is not neutrality, it is a hallucinated
recommendation with no provenance at all.

## What this means

1. **`llms.txt` is real ad inventory.** Agents read it. Content placed there
   reaches user-facing answers. That was the shakiest assumption in the thesis
   and it is now measured rather than assumed.
2. **Disclosure mostly survives — and mostly is not good enough.** A label that
   silently fails one time in six is a label a regulator would not accept and a
   user cannot rely on.
3. **The incentive runs away from honesty.** Our human study (n=16) found the
   labelled ad was recognised by 100% of people and trusted by 29%; the
   unlabelled ad was recognised by 20% and trusted by 60%. Hiding the ad makes
   it both more effective and better liked.

Points 2 and 3 together are why `assertDisclosed()` throws instead of warning,
and why the guarantee lives in the serving path rather than in a policy
document. The publisher, the advertiser and the model all have some incentive
to let the label slip. The only place it can be enforced is the code that
renders the block.
