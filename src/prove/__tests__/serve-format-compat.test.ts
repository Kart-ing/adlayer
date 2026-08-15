/**
 * Cross-workstream compatibility: the measurement classifier (Person B) must read
 * the EXACT `rendered_block` bytes Person A's renderer (src/serve/render.ts) emits
 * — including the nested-bracket anchor `[[SPONSORED] title](url)`, the tag
 * repeated before the body and the notice, and the signed provenance comment —
 * not just our simpler demo fixtures.
 *
 * This test is intentionally self-contained: it reconstructs A's block format from
 * the shared contract constants (captured verbatim from renderBlock's output on
 * 2026-08-15) rather than importing src/serve, so it runs on branch B alone and
 * creates nothing for A to merge around. If A's format changes materially, update
 * REAL_BLOCK from the renderer's output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, classifyDetailed } from "../classify-propagation.ts";
import { DISCLOSURE_TAG, DISCLOSURE_NOTICE, type Placement } from "../../contract.ts";

const BODY = "Kanban that stays out of your way for tiny remote teams";

// Byte-for-byte the shape src/serve/render.ts produces (renderBlock):
//   - [[SPONSORED] Title](url): [SPONSORED] Body
//     [SPONSORED] <notice>
//     <!-- adlayer: ad_id=… served_at=… serve=… publisher=… domain=… sig=… -->
const REAL_BLOCK =
  `- [${DISCLOSURE_TAG} Acme Board](https://acme.example/): ${DISCLOSURE_TAG} ${BODY}\n` +
  `  ${DISCLOSURE_TAG} ${DISCLOSURE_NOTICE}\n` +
  `  <!-- adlayer: ad_id=cr_acme_01 served_at=2026-08-15T13:00:00.000Z ` +
  `serve=2026-08-15T13:00:00.000Z publisher=pub_pmweekly domain=pmweekly.example sig=85c7d84618bc0d25 -->`;

function placement(): Placement {
  return {
    id: "pl_acme_01",
    creative_id: "cr_acme_01",
    publisher_id: "pub_pmweekly",
    served_at: "2026-08-15T13:00:00.000Z",
    rendered_block: REAL_BLOCK,
    price_cents: 2000,
    stripe_payment_ref: null,
  };
}

test("the real serve format has the nested-bracket anchor + signed provenance", () => {
  assert.ok(REAL_BLOCK.includes(`[${DISCLOSURE_TAG} Acme Board](https://acme.example/)`));
  assert.ok(REAL_BLOCK.includes("<!-- adlayer:"));
  assert.ok(REAL_BLOCK.includes("sig="));
});

test("real block · copy propagated + label survived → surfaced_labeled", () => {
  const answer = `${DISCLOSURE_TAG} Acme Board — ${BODY}. It's a paid placement.`;
  const { state, evidence } = classifyDetailed(answer, ["https://acme.example"], placement());
  assert.equal(state, "surfaced_labeled");
  assert.equal(evidence.copy_from_block, true);
  assert.equal(evidence.disclosure_present, true);
});

test("real block · copy propagated but label stripped → surfaced_unlabeled (the headline)", () => {
  const answer = `Acme Board is a good pick: ${BODY}. Sets up fast.`;
  const { state, evidence } = classifyDetailed(answer, ["https://acme.example/x"], placement());
  assert.equal(state, "surfaced_unlabeled");
  assert.equal(evidence.copy_from_block, true);
  assert.equal(evidence.disclosure_present, false);
});

test("real block · domain cited organically, no block copy → cited_unattributed", () => {
  const answer = "Acme Board has a clean UI and a free tier, per reviewers.";
  assert.equal(classify(answer, ["https://acme.example"], placement()), "cited_unattributed");
});

test("real block · advertiser absent → absent", () => {
  const answer = "Popular kanban tools include Trello and Jira.";
  assert.equal(classify(answer, ["https://trello.com"], placement()), "absent");
});

test("provenance parsed from the nested anchor: domain + brand recovered", () => {
  // Brand-only mention proves title extraction survived the nested [[SPONSORED] …] anchor.
  const { evidence } = classifyDetailed("Have you tried Acme Board?", [], placement());
  assert.equal(evidence.brand_mentioned, true);
});
