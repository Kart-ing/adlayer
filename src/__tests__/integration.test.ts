/**
 * ADLAYER — cross-boundary integration.
 *
 * Everything else in this repo tests one module. This file tests the SEAM:
 * Person A's renderer (src/serve) against Person B's classifier (src/prove),
 * with the Pricing agent (src/company) deciding the number in between. The two
 * halves were built in parallel against src/contract.ts and never against each
 * other, so this is the only place that proves the contract actually held.
 *
 * The load-bearing assertion is the LAST one. A false positive here — counting
 * an advertiser who was already being cited organically as "our ad propagated"
 * — would inflate every figure we report. Measuring nothing is a publishable
 * result; measuring something that is not there is not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DRY_RUN, DISCLOSURE_TAG } from "../contract.ts";
import type { Creative, Publisher } from "../contract.ts";
import { servePlacement } from "../serve/index.ts";
import { GLIGUARD_MODEL, type ModerationResult } from "../serve/pioneer.ts";
import { classifyDetailed } from "../prove/classify-propagation.ts";
import { price, type PricingProspect } from "../company/pricing.ts";

const PUBLISHER: Publisher = {
  id: "pub_darkroom-commons",
  domain: "adlayer-darkroom-commons.onrender.com",
  integration: "hosted",
  categories: ["darkroom_ventilation"],
  rev_share: 0.5,
  verified_at: null,
};

const CREATIVE: Creative = {
  id: "ad_aeroflow",
  advertiser_id: "adv_aeroflow",
  title: "AeroFlow Darkroom Fans",
  body: "Light-tight inline fans rated for small darkrooms.",
  target_url: "https://aeroflow.example/darkroom",
  categories: ["darkroom_ventilation"],
  status: "pending_review",
  review: null,
};

const PROSPECT: PricingProspect = {
  id: "adv_aeroflow",
  name: "AeroFlow",
  domain: "aeroflow.example",
  categories: ["darkroom_ventilation"],
  size: "smb",
};

/** Invisible in AI answers: 2 citations across 28 queries. That is the pain. */
const SCORE = { visibility: 0.07, cited_queries: 2, total_queries: 28 };

const CITED = [
  "https://adlayer-darkroom-commons.onrender.com/ventilation-and-safety.html",
  "https://aeroflow.example/darkroom",
];

function cleanModeration(): ModerationResult {
  return {
    ran: true,
    degraded: false,
    degraded_reason: null,
    model: GLIGUARD_MODEL,
    flags: [],
    hits: [
      { task: "prompt_safety", label: "safe", score: 0.99 },
      { task: "jailbreak_detection", label: "benign", score: 0.97 },
      { task: "prompt_toxicity", label: "benign", score: 0.98 },
    ],
    latency_ms: 40,
    raw: null,
  };
}

async function serve(priceCentsOverride?: number | null) {
  return servePlacement("ad_aeroflow", "pub_darkroom-commons", DRY_RUN, {
    publishers: [PUBLISHER],
    creatives: [CREATIVE],
    servedAt: "2026-08-15T13:00:00.000Z",
    logger: () => {},
    review: { moderateFn: async () => cleanModeration() },
    priceQuote:
      priceCentsOverride === undefined
        ? undefined
        : { outcome: "sell", price_cents: priceCentsOverride },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam: A renders, B reads it back
// ─────────────────────────────────────────────────────────────────────────────

test("a served block carries the disclosure and one signed provenance record", async () => {
  const result = await serve(1600);

  assert.equal(result.outcome, "dry_run");
  assert.ok(result.placement, "a clean creative must produce a placement");
  assert.ok(result.placement!.rendered_block.includes(DISCLOSURE_TAG));
  assert.ok(result.placement!.rendered_block.includes("ad_aeroflow"));
  assert.equal(result.placement!.price_cents, 1600);
});

test("the classifier reads back the four states off a REAL rendered block", async () => {
  const placement = (await serve(1600)).placement!;

  const labeled = classifyDetailed(
    "For a home darkroom, aim for 8-10 air changes per hour. Sources include " +
      "Darkroom Commons. One listing, AeroFlow Darkroom Fans [SPONSORED], offers " +
      "light-tight inline fans rated for small darkrooms.",
    CITED,
    placement,
  );
  assert.equal(labeled.state, "surfaced_labeled");

  const unlabeled = classifyDetailed(
    "For a home darkroom, aim for 8-10 air changes per hour. AeroFlow Darkroom " +
      "Fans offers light-tight inline fans rated for small darkrooms, which " +
      "suits most home setups.",
    CITED,
    placement,
  );
  assert.equal(
    unlabeled.state,
    "surfaced_unlabeled",
    "the headline finding: the ad surfaced but the label did not",
  );

  const absent = classifyDetailed(
    "For a home darkroom, aim for 8-10 air changes per hour. Put intake low and " +
      "extraction high on the opposite wall.",
    [CITED[0]!],
    placement,
  );
  assert.equal(absent.state, "absent");
});

test("an advertiser cited BEFORE the serve is never counted as propagation", async () => {
  // The one that protects the integrity of every number we report. AeroFlow was
  // already being recommended organically; our ad changed nothing, and the
  // classifier has to say so even though the domain is cited and the brand is
  // named.
  const placement = (await serve(1600)).placement!;
  const organic =
    "AeroFlow Darkroom Fans is a well known maker of darkroom extraction " +
    "equipment and is often recommended.";

  const result = classifyDetailed(organic, ["https://aeroflow.example/darkroom"], placement, {
    present: true,
    answer_excerpt: organic,
    cited_urls: ["https://aeroflow.example/darkroom"],
  });

  assert.equal(result.state, "cited_unattributed");
  assert.notEqual(result.state, "surfaced_labeled");
  assert.notEqual(result.state, "surfaced_unlabeled");
});

// ─────────────────────────────────────────────────────────────────────────────
// The money seam: Pricing decides, serving enforces
// ─────────────────────────────────────────────────────────────────────────────

test("Pricing sells to a viable publisher and the number reaches the placement", async () => {
  const result = await price(PROSPECT, SCORE, PUBLISHER, DRY_RUN, { logger: () => {} });
  const quote = (result as { quote?: unknown }).quote ?? result;
  const { price_cents } = quote as { price_cents: number | null };

  assert.ok(price_cents !== null, "a 50/50 publisher must be sellable");
  assert.ok(price_cents! > 0);

  const served = await serve(price_cents);
  assert.equal(served.placement?.price_cents, price_cents);
});

test("Pricing refuses a publisher whose cut destroys the margin, and nothing serves", async () => {
  // Refusing revenue is the clearest evidence the decision is real. At a 98%
  // revenue share there is no price that clears our minimum net, so the floor
  // is Infinity and the agent declines.
  const greedy: Publisher = { ...PUBLISHER, rev_share: 0.98 };
  const result = await price(PROSPECT, SCORE, greedy, DRY_RUN, { logger: () => {} });
  const quote = (result as { quote?: unknown }).quote ?? result;
  const { price_cents, outcome } = quote as { price_cents: number | null; outcome: string };

  assert.equal(price_cents, null, "a 98% publisher must be refused");
  assert.match(outcome, /refus/);

  const served = await servePlacement("ad_aeroflow", "pub_darkroom-commons", DRY_RUN, {
    publishers: [PUBLISHER],
    creatives: [CREATIVE],
    logger: () => {},
    review: { moderateFn: async () => cleanModeration() },
    priceQuote: { outcome, price_cents: null },
  });

  assert.equal(served.outcome, "refused");
  assert.ok(!served.placement, "a refused sale must not produce a placement");
});

test("the publisher's rev_share is what makes a publisher unsellable", async () => {
  // Same prospect, same everything, only the kickback changes. If this ever
  // stops mattering, the revenue split has quietly stopped being modelled.
  const results = await Promise.all(
    [0.5, 0.98].map(async (rev_share) => {
      const r = await price(PROSPECT, SCORE, { ...PUBLISHER, rev_share }, DRY_RUN, {
        logger: () => {},
      });
      const q = (r as { quote?: unknown }).quote ?? r;
      return (q as { price_cents: number | null }).price_cents;
    }),
  );

  assert.ok(results[0] !== null, "50% share: sellable");
  assert.equal(results[1], null, "98% share: refused");
});
