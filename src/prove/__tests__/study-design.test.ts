/**
 * Study-wording tests — acceptance requires that the wording passes a
 * banned-leading-phrase assertion (PRD-B §3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STUDY_QUESTIONS,
  VARIANT_NAMES,
  assertNeutralWording,
  findBannedPhrase,
  stimulusFor,
} from "../study-design.ts";
import { DISCLOSURE_TAG } from "../../contract.ts";

test("study wording passes the neutral-wording assertion", () => {
  assert.doesNotThrow(() => assertNeutralWording());
});

test("no question prompt contains a leading phrase", () => {
  for (const q of Object.values(STUDY_QUESTIONS)) {
    assert.equal(findBannedPhrase(q.prompt), null, `leading phrase in "${q.prompt}"`);
  }
});

test("the guard actually catches a planted leading phrase", () => {
  assert.equal(findBannedPhrase("Don't you think this ad is deceptive?"), "don't you");
  assert.equal(findBannedPhrase("Isn't it obviously an ad?"), "isn't it");
});

test("labeled and prominent stimuli carry the disclosure; unlabeled does not", () => {
  assert.ok(stimulusFor("labeled").includes(DISCLOSURE_TAG));
  assert.ok(stimulusFor("labeled_prominent").includes(DISCLOSURE_TAG));
  assert.ok(!stimulusFor("unlabeled").includes(DISCLOSURE_TAG));
});

test("all three variants produce a distinct stimulus", () => {
  const seen = new Set(VARIANT_NAMES.map((v) => stimulusFor(v)));
  assert.equal(seen.size, 3);
});
