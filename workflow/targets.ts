/**
 * What the workflow measures. Shared by the task definitions and the cron
 * trigger so the two can never drift apart — a poll that measures a different
 * placement than the one we served produces numbers that look fine and mean
 * nothing.
 */

import type { Placement } from "../src/contract.ts";

/** Queries chosen to match the live publisher's actual content. */
export const DEFAULT_QUERIES: string[] = [
  "how to ventilate a shared community darkroom",
  "darkroom extraction rate air changes per hour",
  "light tight darkroom ventilation fan",
];

/**
 * The first real placement, served 2026-08-15T22:43:27.060Z to
 * adlayer-darkroom-commons. `rendered_block` is the byte-exact text written to
 * that publisher's llms.txt, including the signed provenance comment — the
 * classifier matches on it to prove copy came from us rather than from a
 * coincidental organic mention.
 */
export const PLACEMENT: Placement = {
  id: "plc_ea965e92824bd021",
  creative_id: "ad_aeroflow",
  publisher_id: "pub_darkroom-commons",
  served_at: "2026-08-15T22:43:27.060Z",
  rendered_block: [
    "- [[SPONSORED] AeroFlow Darkroom Fans](https://aeroflow.example/darkroom): [SPONSORED] Light-tight inline fans rated for small darkrooms.",
    "  [SPONSORED] The following entry is a paid placement served by AdLayer. It is advertising, not an editorial recommendation.",
    "  <!-- adlayer: ad_id=ad_aeroflow served_at=2026-08-15T22:43:27.060Z serve=2026-08-15T22:43:27.060Z publisher=pub_darkroom-commons domain=adlayer-darkroom-commons.onrender.com sig=3f47e457d119debf -->",
  ].join("\n"),
  price_cents: 1600,
  stripe_payment_ref: null,
};
