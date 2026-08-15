/**
 * Terac aggregation + before/after tests. These exercise the code that turns
 * real submissions into a TrustStudy and computes predicted-vs-actual deltas —
 * the parts that must be correct for an honest result. No network, no fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateSubmissions,
  buildBeforeAfter,
  decideFormatChange,
  type Submission,
} from "../terac.ts";
import type { TrustStudy } from "../../contract.ts";

const SUBS: Submission[] = [
  { submissionId: "s1", variant: "unlabeled", trust: "Yes", ad_recognition: "No", verbatim: "seemed normal" },
  { submissionId: "s2", variant: "unlabeled", trust: "No", ad_recognition: "Yes" },
  { submissionId: "s3", variant: "unlabeled", trust: "Yes", ad_recognition: "No" },
  { submissionId: "s4", variant: "unlabeled", trust: "Unsure", ad_recognition: "Unsure" },
  // Another arm — must be ignored when aggregating "unlabeled".
  { submissionId: "s5", variant: "labeled", trust: "Yes", ad_recognition: "Yes" },
];

test("aggregateSubmissions computes rates only over the matching arm", () => {
  const study = aggregateSubmissions("unlabeled", SUBS, "2026-08-15T18:30:00.000Z");
  assert.equal(study.n_responses, 4); // the labeled row is excluded
  assert.equal(study.trust_rate, 0.5); // 2 of 4 said Yes
  assert.equal(study.ad_recognition_rate, 0.25); // 1 of 4 recognized the ad
  assert.equal(study.variant, "unlabeled");
  assert.deepEqual(study.verbatims, ["seemed normal"]);
});

test("aggregateSubmissions refuses an empty arm rather than reporting 0%", () => {
  assert.throws(() => aggregateSubmissions("labeled_prominent", SUBS, "t"), /No submissions/);
});

test("buildBeforeAfter computes signed deltas", () => {
  const before: TrustStudy = {
    id: "predicted_unlabeled", variant: "unlabeled", question: "q",
    n_responses: 40, trust_rate: 0.58, ad_recognition_rate: 0.3, verbatims: [], ran_at: "t0",
  };
  const after: TrustStudy = {
    id: "study_unlabeled", variant: "unlabeled", question: "q",
    n_responses: 39, trust_rate: 0.62, ad_recognition_rate: 0.23, verbatims: [], ran_at: "t1",
  };
  const ba = buildBeforeAfter(before, after, "ship prominent");
  assert.equal(ba.trust_delta, 0.04);
  assert.equal(ba.recognition_delta, -0.07);
  assert.equal(ba.change_made, "ship prominent");
});

test("decideFormatChange adopts prominent when it lifts recognition at low trust cost", () => {
  const arms = {
    labeled: mk("labeled", 0.72, 0.66),
    unlabeled: mk("unlabeled", 0.58, 0.3),
    labeled_prominent: mk("labeled_prominent", 0.7, 0.9),
  };
  assert.match(decideFormatChange(arms), /Ship 'labeled_prominent'/);
});

function mk(variant: TrustStudy["variant"], trust: number, recog: number): TrustStudy {
  return {
    id: `x_${variant}`, variant, question: "q", n_responses: 40,
    trust_rate: trust, ad_recognition_rate: recog, verbatims: [], ran_at: "t",
  };
}
