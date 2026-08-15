/**
 * Classifier tests — the four PropagationStates plus the false-positive case the
 * acceptance checklist calls out: an advertiser cited organically BEFORE serve
 * must classify `cited_unattributed`, never `surfaced_*`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, classifyDetailed, type BaselineObservation } from "../classify-propagation.ts";
import { DISCLOSURE_TAG, DISCLOSURE_NOTICE, type Placement } from "../../contract.ts";

// A distinctive one-line body — long and specific enough that an organic
// collision is implausible, which is exactly what makes it a propagation
// fingerprint.
const BODY = "Kanban that stays out of your way for tiny remote teams";

const RENDERED_BLOCK = [
  DISCLOSURE_TAG,
  DISCLOSURE_NOTICE,
  `- [Acme Board](https://acme.example): ${BODY}. ad_id: cr_acme_01`,
].join("\n");

function placement(): Placement {
  return {
    id: "pl_acme_01",
    creative_id: "cr_acme_01",
    publisher_id: "pub_pmweekly",
    served_at: "2026-08-15T13:00:00.000Z",
    rendered_block: RENDERED_BLOCK,
    price_cents: 2000,
    stripe_payment_ref: null,
  };
}

test("absent — advertiser not present at all", () => {
  const answer =
    "For small teams, popular kanban tools include Trello and a few open-source boards. " +
    "See the comparisons on the usual review sites.";
  const cited = ["https://trello.com", "https://www.reddit.com/r/kanban"];
  const { state, evidence } = classifyDetailed(answer, cited, placement());
  assert.equal(state, "absent");
  assert.equal(evidence.present, false);
});

test("surfaced_labeled — our copy propagated AND the disclosure survived", () => {
  const answer =
    `${DISCLOSURE_TAG} Acme Board — ${BODY}. It's a paid placement, so weigh it accordingly.`;
  const cited = ["https://acme.example"];
  const { state, evidence } = classifyDetailed(answer, cited, placement());
  assert.equal(state, "surfaced_labeled");
  assert.equal(evidence.copy_from_block, true);
  assert.equal(evidence.disclosure_present, true);
  assert.equal(evidence.confidence, "strong");
});

test("surfaced_unlabeled — our copy propagated but the label was stripped (the headline)", () => {
  const answer =
    `One tool worth a look is Acme Board: ${BODY}. It integrates with the usual suspects.`;
  const cited = ["https://acme.example/features"];
  const { state, evidence } = classifyDetailed(answer, cited, placement());
  assert.equal(state, "surfaced_unlabeled");
  assert.equal(evidence.copy_from_block, true);
  assert.equal(evidence.disclosure_present, false);
});

test("cited_unattributed — domain cited but text did not come from our block", () => {
  const answer =
    "Several teams like Acme Board for its clean UI and generous free tier. " +
    "Reviewers rate it well against larger suites.";
  const cited = ["https://acme.example", "https://g2.com/acme-board"];
  const { state, evidence } = classifyDetailed(answer, cited, placement());
  assert.equal(state, "cited_unattributed");
  assert.equal(evidence.copy_from_block, false);
  assert.equal(evidence.domain_cited, true);
});

test("false positive — advertiser cited organically BEFORE serve → cited_unattributed", () => {
  // Pre-serve baseline already had the advertiser surfacing for this query,
  // organically (no AdLayer copy). A later organic citation must NOT be read as
  // propagation caused by us.
  const baseline: BaselineObservation = {
    present: true,
    answer_excerpt: "Acme Board is a well-known kanban option teams already use.",
    cited_urls: ["https://acme.example"],
  };
  const answer = "Acme Board remains a solid pick for teams that want something simple.";
  const cited = ["https://acme.example"];
  const state = classify(answer, cited, placement(), baseline);
  assert.equal(state, "cited_unattributed");
});

test("false positive — copy fingerprint already in the baseline is not propagation", () => {
  // Even if our body phrase shows up post-serve, if it ALSO appeared pre-serve
  // it is not evidence we caused it — subtract it.
  const baseline: BaselineObservation = {
    present: true,
    answer_excerpt: `Acme Board: ${BODY}. Long a favorite in this space.`,
    cited_urls: ["https://acme.example"],
  };
  const answer = `Acme Board: ${BODY}.`;
  const cited = ["https://acme.example"];
  const { state, evidence } = classifyDetailed(answer, cited, placement(), baseline);
  assert.equal(state, "cited_unattributed");
  assert.equal(evidence.copy_from_block, false);
  assert.ok(evidence.notes.some((n) => n.includes("baseline")));
});

test("unicode-bracket counterfeit label still registers the disclosure (red-team)", () => {
  // A model (or hostile creative) emitting a look-alike bracket must not let us
  // silently miscount a labeled answer as unlabeled.
  const answer = `［SPONSORED］ Acme Board — ${BODY}.`;
  const cited = ["https://acme.example"];
  const { state, evidence } = classifyDetailed(answer, cited, placement());
  assert.equal(evidence.disclosure_present, true);
  assert.equal(state, "surfaced_labeled");
});

test("brand mention without domain or copy is a weak organic signal", () => {
  const answer = "You might also consider Acme Board among the smaller players.";
  const { state, evidence } = classifyDetailed(answer, [], placement());
  assert.equal(state, "cited_unattributed");
  assert.equal(evidence.brand_mentioned, true);
  assert.equal(evidence.domain_cited, false);
  assert.equal(evidence.confidence, "weak");
});
