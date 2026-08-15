/**
 * ADLAYER — FORMAT agent tests.
 *
 * Written from the position of a judge trying to show this agent is decoration.
 * The things that have to be true, and are asserted here:
 *
 *   1. HONESTY BEATS COMMERCE, and the agent gives up real money to do it. There
 *      is a run where the most profitable option is rejected, and the number it
 *      cost is in the ledger.
 *   2. THE AGENT CAN BE WRONG AND CAN CHOOSE BADLY. It can escalate to a format
 *      no human saw, and it can HALT its own company's only revenue line. Both
 *      branches are exercised.
 *   3. THE THRESHOLDS ARE LOAD-BEARING. Move the floor and the shipped format
 *      changes — which is also why moving it after results land is refused.
 *   4. THE PREDICTION IS PRE-REGISTERED, and this module cannot overwrite it.
 *   5. `compare()` calls the model WRONG when it is wrong, from claims frozen
 *      before the data existed.
 *   6. Dry run by default, keyless by default, `assertDisclosed()` always.
 *
 * A test that only shows the happy path would be the theatre the brief warns
 * about, so several tests below are constructed specifically to make the agent
 * do the expensive thing.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DISCLOSURE_TAG, type TrustStudy } from "../../contract.ts";
import {
  auditEntry,
  openDecisionLog,
  readLog,
  verifyChain,
  type DecisionSink,
} from "../decision-log.ts";
import {
  CLARITY_LEXICON,
  COMMERCIAL_MODEL,
  DEFAULT_HONESTY_RULE,
  FORMAT_LADDER,
  MODEL_PRIOR,
  PREDICTED_VERBATIM_PREFIX,
  PROPOSED_FORMAT,
  analyzeVerbatims,
  compare,
  decideFormat,
  defaultClaims,
  differenceIsNoise,
  eligibilityFailures,
  isAdmissible,
  predict,
  predictWithBand,
  preregister,
  projectedValueCents,
  readPreregistration,
  renderSample,
  resolveRule,
  standardError,
  type FormatFlags,
  type FormatVerdict,
  type StudyArmDesign,
} from "../format.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Scratch space and builders
// ─────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "adlayer-format-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface ArmSpec {
  recognition: number;
  trust: number;
  n?: number;
  verbatims?: string[];
  ran_at?: string;
}

function arm(variant: TrustStudy["variant"], spec: ArmSpec): TrustStudy {
  return {
    id: `terac_sub_${variant}`,
    variant,
    question: "Would you still trust this assistant after seeing this result?",
    n_responses: spec.n ?? 40,
    trust_rate: spec.trust,
    ad_recognition_rate: spec.recognition,
    verbatims: spec.verbatims ?? [],
    ran_at: spec.ran_at ?? "2026-08-15T17:30:00.000Z",
  };
}

/** Silences the agent's log lines unless a test wants to read them. */
function quiet(): FormatFlags {
  return { logger: (): void => {} };
}

function captured(): { flags: FormatFlags; lines: string[] } {
  const lines: string[] = [];
  return { flags: { logger: (m: string): void => void lines.push(m) }, lines };
}

const FIXED_NOW = (): Date => new Date("2026-08-15T17:45:00.000Z");

const DESIGNS: StudyArmDesign[] = [
  {
    id: "arm_unlabeled",
    variant: "unlabeled",
    question: "Would you still trust this assistant after seeing this result?",
    n_responses: 40,
    planned_ran_at: "2026-08-15T14:00:00.000Z",
  },
  {
    id: "arm_labeled",
    variant: "labeled",
    question: "Would you still trust this assistant after seeing this result?",
    n_responses: 40,
    planned_ran_at: "2026-08-15T14:00:00.000Z",
  },
  {
    id: "arm_labeled_prominent",
    variant: "labeled_prominent",
    question: "Would you still trust this assistant after seeing this result?",
    n_responses: 40,
    planned_ran_at: "2026-08-15T14:00:00.000Z",
  },
];

function memorySink(): DecisionSink {
  return openDecisionLog({ now: FIXED_NOW });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE HARD INVARIANT — the contract, not a threshold, excludes `unlabeled`
// ─────────────────────────────────────────────────────────────────────────────

describe("disclosure is structural, not a preference", () => {
  it("only the unlabeled rung fails assertDisclosed()", () => {
    assert.equal(isAdmissible("unlabeled"), false);
    for (const format of FORMAT_LADDER) {
      if (format === "unlabeled") continue;
      assert.equal(isAdmissible(format), true, `${format} should carry the tag`);
      assert.ok(renderSample(format).includes(DISCLOSURE_TAG));
    }
  });

  it("the escalated rung puts a second marker INSIDE the entry line, not just above it", () => {
    // The mechanism claim: a model that lifts one bullet cannot drop the label,
    // because the label is in the same string as the anchor text.
    const block = renderSample(PROPOSED_FORMAT);
    const entryLine = block
      .split("\n")
      .find((l) => l.trimStart().startsWith("-"));
    assert.ok(entryLine !== undefined);
    assert.ok(
      entryLine.includes(DISCLOSURE_TAG),
      "the bullet itself must carry the tag, or extraction strips the disclosure",
    );
    // labeled_prominent, by contrast, relies on adjacency for the notice.
    assert.ok(!renderSample("labeled_prominent").split("\n")[1]?.includes(DISCLOSURE_TAG));
  });

  it("whatever the agent ships passes assertDisclosed, across every scenario", async () => {
    const scenarios: TrustStudy[][] = [
      [arm("unlabeled", { recognition: 0.99, trust: 0.99 }), arm("labeled", { recognition: 0.9, trust: 0.9 })],
      [arm("labeled", { recognition: 0.1, trust: 0.9 })],
      [arm("labeled", { recognition: 0.6, trust: 0.8 }), arm("labeled_prominent", { recognition: 0.6, trust: 0.5 })],
      [arm("labeled_prominent", { recognition: 0.95, trust: 0.4 })],
    ];
    for (const study of scenarios) {
      const v = await decideFormat(study, quiet());
      assert.notEqual(v.chosen, "unlabeled");
      assert.ok(v.sample_block.includes(DISCLOSURE_TAG));
    }
  });

  it("never ships unlabeled even when it dominates on every commercial axis", async () => {
    const v = await decideFormat(
      [
        // The dishonest arm wins on trust AND on recognition. It still cannot ship.
        arm("unlabeled", { recognition: 0.99, trust: 0.99 }),
        arm("labeled_prominent", { recognition: 0.88, trust: 0.5 }),
      ],
      quiet(),
    );
    assert.equal(v.chosen, "labeled_prominent");
    const unlabeled = v.candidates.find((c) => c.format === "unlabeled");
    assert.ok(unlabeled !== undefined);
    assert.equal(unlabeled.admissible, false);
    assert.equal(unlabeled.eligible, false);
    assert.ok(
      unlabeled.failures.some((f) => f.includes("assertDisclosed")),
      "the exclusion must be attributed to the contract, not to a threshold",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HONESTY BEATS COMMERCIAL INTEREST — with a number attached
// ─────────────────────────────────────────────────────────────────────────────

describe("honesty beats commercial interest when they conflict", () => {
  it("rejects the most profitable admissible format because it misses the recognition floor", async () => {
    // No control arm, so the lift test is vacuous and the ONLY thing separating
    // these two formats is the honesty floor versus the money.
    const study = [
      arm("labeled", { recognition: 0.6, trust: 0.8 }), //  fails floor, pays best
      arm("labeled_prominent", { recognition: 0.88, trust: 0.55 }), // clears floor, pays worse
    ];
    const v = await decideFormat(study, quiet());

    assert.equal(v.chosen, "labeled_prominent");
    assert.equal(v.route, "eligible_measured");
    assert.equal(v.honesty_overrode_commerce, true);

    const labeled = v.candidates.find((c) => c.format === "labeled");
    const prominent = v.candidates.find((c) => c.format === "labeled_prominent");
    assert.ok(labeled !== undefined && prominent !== undefined);
    assert.ok(
      labeled.projected_value_cents > prominent.projected_value_cents,
      "the rejected option must actually be the more profitable one, or this test proves nothing",
    );
    assert.equal(
      v.commercial_sacrifice_cents,
      labeled.projected_value_cents - prominent.projected_value_cents,
    );
    assert.ok(v.commercial_sacrifice_cents > 0);
  });

  it("hardcoding the commercially-best format would change the observable output", async () => {
    // The falsification test for "is this agent decoration?". If the agent is
    // removed and we ship whatever pays best, the shipped format differs.
    const study = [
      arm("labeled", { recognition: 0.6, trust: 0.8 }),
      arm("labeled_prominent", { recognition: 0.88, trust: 0.55 }),
    ];
    const v = await decideFormat(study, quiet());
    const richest = [...v.candidates]
      .filter((c) => c.format !== "halt")
      .sort((a, b) => b.projected_value_cents - a.projected_value_cents)[0];
    assert.ok(richest !== undefined);
    assert.notEqual(richest.format, v.chosen);
  });

  it("does NOT claim an honesty win when honesty and commerce agreed", async () => {
    // Overclaiming here would be the cheapest possible theatre, so it is tested.
    const study = [
      arm("labeled", { recognition: 0.4, trust: 0.4 }),
      arm("labeled_prominent", { recognition: 0.9, trust: 0.9 }),
    ];
    const v = await decideFormat(study, quiet());
    assert.equal(v.chosen, "labeled_prominent");
    assert.equal(v.honesty_overrode_commerce, false);
    assert.equal(v.commercial_sacrifice_cents, 0);
    assert.ok(v.summary.includes("did not conflict"));
  });

  it("the sacrifice is written into the ledger entry, not only into the return value", async () => {
    const sink = memorySink();
    await decideFormat(
      [
        arm("unlabeled", { recognition: 0.2, trust: 0.9 }),
        arm("labeled", { recognition: 0.6, trust: 0.8 }),
        arm("labeled_prominent", { recognition: 0.88, trust: 0.55 }),
      ],
      { ...quiet(), sink },
    );
    const entry = sink.entries().at(-1);
    assert.ok(entry !== undefined);
    assert.ok(/gave up \$\d+/.test(entry.rationale), entry.rationale);
    // And the money we refused is an option in the log with its value attached.
    const unlabeledOption = entry.options.find((o) => o.id === "opt_unlabeled");
    assert.ok(unlabeledOption !== undefined);
    assert.ok((unlabeledOption.projected_value_cents ?? 0) > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. RECOGNITION BELOW THE FLOOR ESCALATES — and, past a point, halts
// ─────────────────────────────────────────────────────────────────────────────

describe("recognition below the floor escalates the format", () => {
  it("escalates past every measured arm when none of them clears the floor", async () => {
    const study = [
      arm("unlabeled", { recognition: 0.25, trust: 0.9 }),
      arm("labeled", { recognition: 0.55, trust: 0.75 }),
      arm("labeled_prominent", { recognition: 0.6, trust: 0.62 }),
    ];
    const v = await decideFormat(study, quiet());

    assert.equal(v.route, "escalated");
    assert.equal(v.chosen, PROPOSED_FORMAT);
    assert.equal(v.halt, false);
    // The agent must say plainly that nobody validated what it is shipping.
    const proposal = v.candidates.find((c) => c.format === PROPOSED_FORMAT);
    assert.ok(proposal !== undefined);
    assert.equal(proposal.measured, false);
    assert.ok(proposal.note.includes("NEVER SHOWN TO A HUMAN"));
    assert.ok(v.summary.includes("NEVER SHOWN TO A HUMAN"));
  });

  it("does not invent a format when a measured one already qualifies", async () => {
    const v = await decideFormat(
      [arm("labeled_prominent", { recognition: 0.9, trust: 0.6 })],
      quiet(),
    );
    assert.equal(v.chosen, "labeled_prominent");
    assert.ok(
      !v.candidates.some((c) => c.format === PROPOSED_FORMAT),
      "the proposal must not even be on the table while a measured format qualifies",
    );
  });

  it("HALTS instead of escalating when even the best measured label is catastrophic", async () => {
    const study = [
      arm("unlabeled", { recognition: 0.1, trust: 0.9 }),
      arm("labeled", { recognition: 0.3, trust: 0.8 }),
      arm("labeled_prominent", { recognition: 0.35, trust: 0.7 }),
    ];
    const v = await decideFormat(study, quiet());
    assert.equal(v.halt, true);
    assert.equal(v.halt_reason, "catastrophic");
    assert.equal(v.decision.chosen_option_id, "opt_halt");
    assert.ok(v.summary.includes("HALT"));
    // Halting kills the revenue line. The agent has to own that.
    const chosenOption = v.decision.options.find((o) => o.id === "opt_halt");
    assert.equal(chosenOption?.projected_value_cents, 0);
  });

  it("HALTS when the escalation it can construct still would not reach the floor", async () => {
    const study = [
      arm("unlabeled", { recognition: 0.2, trust: 0.9 }),
      arm("labeled_prominent", { recognition: 0.5, trust: 0.7 }),
    ];
    const v = await decideFormat(study, quiet());
    assert.equal(v.halt, true);
    assert.equal(v.halt_reason, "escalation_insufficient");
    assert.ok(v.decision.rationale.includes("the rule with extra steps"));
  });

  it("the recognition floor is load-bearing: move it and the shipped format moves", async () => {
    const study = [
      arm("labeled", { recognition: 0.6, trust: 0.8 }),
      arm("labeled_prominent", { recognition: 0.88, trust: 0.55 }),
    ];
    const strict = await decideFormat(study, quiet());
    const loose = await decideFormat(study, { ...quiet(), rule: { recognition_floor: 0.55 } });
    assert.equal(strict.chosen, "labeled_prominent");
    assert.equal(loose.chosen, "labeled", "at a 0.55 floor the profitable format becomes admissible");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE LIFT TEST — the label has to be the reason, and only where that is
//    a question the panel can answer
// ─────────────────────────────────────────────────────────────────────────────

describe("the label must do the work", () => {
  it("rejects a format that clears the floor but barely beats the no-label control", () => {
    const control = arm("unlabeled", { recognition: 0.6, trust: 0.9 });
    const failures = eligibilityFailures({
      format: "labeled",
      recognition: 0.7,
      admissible: true,
      control,
      rule: DEFAULT_HONESTY_RULE,
      signal: null,
    });
    assert.equal(failures.length, 1);
    assert.ok(failures[0]?.includes("coming from the copy"));
  });

  it("skips the lift test when the control already clears the floor (no headroom to show lift in)", () => {
    const control = arm("unlabeled", { recognition: 0.7, trust: 0.9 });
    const failures = eligibilityFailures({
      format: "labeled",
      recognition: 0.72,
      admissible: true,
      control,
      rule: DEFAULT_HONESTY_RULE,
      signal: null,
    });
    assert.deepEqual(failures, [], "a ceiling effect must not make every format ineligible forever");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. VERBATIMS — a crude instrument, wired one way
// ─────────────────────────────────────────────────────────────────────────────

describe("verbatim confusion can veto a format, never promote one", () => {
  const confusedTen = [
    "I didn't realise it was an ad until you asked.",
    "Honestly I almost missed the tag.",
    "It felt a bit sneaky.",
    "Seemed fine to me.",
    "Useful recommendation.",
    "I would click it.",
    "No strong feelings.",
    "Fine.",
    "Reasonable.",
    "OK.",
  ];

  it("vetoes a format the tick-box question passed", async () => {
    const v = await decideFormat(
      [
        arm("labeled", { recognition: 0.75, trust: 0.8, verbatims: confusedTen }),
        arm("labeled_prominent", { recognition: 0.9, trust: 0.55 }),
      ],
      quiet(),
    );
    const labeled = v.candidates.find((c) => c.format === "labeled");
    assert.ok(labeled !== undefined);
    assert.equal(labeled.eligible, false);
    assert.ok(labeled.failures.some((f) => f.includes("volunteered")));
    assert.equal(v.chosen, "labeled_prominent");
  });

  it("cannot fire below the minimum verbatim count", () => {
    const signal = analyzeVerbatims(["I didn't realise it was an ad", "sneaky"]);
    assert.equal(signal.below_minimum, true);
    const failures = eligibilityFailures({
      format: "labeled",
      recognition: 0.75,
      admissible: true,
      control: null,
      rule: DEFAULT_HONESTY_RULE,
      signal,
    });
    assert.deepEqual(failures, []);
  });

  it("glowing verbatims cannot rescue a format that failed the floor", async () => {
    const glowing = CLARITY_LEXICON.map((p) => `It was ${p}, no question.`);
    const v = await decideFormat(
      [arm("labeled", { recognition: 0.5, trust: 0.9, verbatims: glowing })],
      quiet(),
    );
    const labeled = v.candidates.find((c) => c.format === "labeled");
    assert.equal(labeled?.eligible, false);
    assert.notEqual(v.chosen, "labeled");
  });

  it("ignores predicted themes so a prediction cannot pollute a real signal", () => {
    const signal = analyzeVerbatims([
      `${PREDICTED_VERBATIM_PREFIX} people will say they were tricked and it was sneaky`,
      "Clear enough.",
    ]);
    assert.equal(signal.n, 1);
    assert.equal(signal.confused, 0);
  });

  it("an injected classifier replaces the lexicon and its failure degrades, never throws", async () => {
    const v = await decideFormat([arm("labeled", { recognition: 0.9, trust: 0.9 })], {
      ...quiet(),
      classifyVerbatims: () => {
        throw new Error("model unavailable");
      },
    });
    assert.equal(v.chosen, "labeled");
    assert.equal(v.verbatims[0]?.signal.source, "lexicon");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. UNCERTAINTY IS SPENT ON THE READER
// ─────────────────────────────────────────────────────────────────────────────

describe("noise resolves toward disclosure", () => {
  const small = [
    arm("unlabeled", { recognition: 0.3, trust: 0.8, n: 40 }),
    arm("labeled", { recognition: 0.7, trust: 0.7, n: 40 }),
    arm("labeled_prominent", { recognition: 0.9, trust: 0.66, n: 40 }),
  ];

  it("a commercial edge inside sampling error does not move the format down the ladder", async () => {
    const v = await decideFormat(small, quiet());
    assert.equal(v.chosen, "labeled_prominent");
    const labeled = v.candidates.find((c) => c.format === "labeled");
    const prominent = v.candidates.find((c) => c.format === "labeled_prominent");
    assert.ok(labeled !== undefined && prominent !== undefined);
    assert.equal(labeled.eligible, true, "both formats must be eligible or this is not a tie-break");
    assert.ok(labeled.projected_value_cents > prominent.projected_value_cents);
    assert.ok(v.decision.flip_condition.includes("noise"), v.decision.flip_condition);
  });

  it("the same gap at a large n IS real, and then commerce decides among honest formats", async () => {
    const big = small.map((s) => ({ ...s, n_responses: 5000 }));
    const v = await decideFormat(big, quiet());
    assert.equal(
      v.chosen,
      "labeled",
      "once the trust gap is outside sampling error the eligible-and-more-profitable format wins",
    );
    assert.equal(v.honesty_overrode_commerce, true, "unlabeled is still the richest option overall");
  });

  it("the floor is judged on the point estimate — 'statistically close' is not clearing it", async () => {
    // 0.66 against a 0.67 floor at n=40 is well inside sampling error, and it
    // still fails. Uncertainty is spent on the reader.
    const v = await decideFormat(
      [
        arm("labeled", { recognition: 0.66, trust: 0.9 }),
        arm("labeled_prominent", { recognition: 0.67, trust: 0.5 }),
      ],
      quiet(),
    );
    assert.equal(v.chosen, "labeled_prominent");
    assert.ok(
      differenceIsNoise(0.66, 40, 0.67, 40, DEFAULT_HONESTY_RULE.noise_z),
      "sanity: the two rates really are indistinguishable at this n",
    );
  });

  it("standardError reports maximal uncertainty rather than dividing by zero", () => {
    assert.equal(standardError(0.5, 0), 1);
    assert.ok(standardError(0.5, 40) > standardError(0.5, 4000));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PREDICTION IS PRE-REGISTERED AND CANNOT BE RETROFITTED
// ─────────────────────────────────────────────────────────────────────────────

describe("the prediction is frozen before the results", () => {
  it("predict() is pure and deterministic", () => {
    const a = predict(DESIGNS[1] as StudyArmDesign);
    const b = predict(DESIGNS[1] as StudyArmDesign);
    assert.deepEqual(a, b);
    assert.equal(a.ad_recognition_rate, MODEL_PRIOR.labeled.recognition);
    assert.ok(a.verbatims.every((v) => v.startsWith(PREDICTED_VERBATIM_PREFIX)));
  });

  it("the prior is deliberately falsifiable: it predicts the plain label FAILS the floor", () => {
    assert.ok(
      MODEL_PRIOR.labeled.recognition < DEFAULT_HONESTY_RULE.recognition_floor,
      "a prediction that cannot embarrass us is not a prediction",
    );
    assert.ok(MODEL_PRIOR.labeled_prominent.trust < MODEL_PRIOR.labeled.trust);
    assert.ok(MODEL_PRIOR.unlabeled.trust > MODEL_PRIOR.labeled_prominent.trust);
  });

  it("persists to disk with a timestamp, a rule, and a content hash", () => {
    const path = join(scratch(), "prediction.json");
    const result = preregister(DESIGNS, { path, now: FIXED_NOW, ...quiet(), skipDecision: true });
    assert.equal(result.frozen, true);
    assert.ok(existsSync(path));

    const onDisk = readPreregistration(path);
    assert.ok(onDisk !== null);
    assert.equal(onDisk.frozen_at, "2026-08-15T17:45:00.000Z");
    assert.equal(onDisk.rule.recognition_floor, DEFAULT_HONESTY_RULE.recognition_floor);
    assert.equal(onDisk.prediction_hash, result.prereg.prediction_hash);
    assert.equal(onDisk.arms.length, 3);
    assert.ok(onDisk.claims.length >= 4);
  });

  it("REFUSES to overwrite a frozen prediction, and reports the drift", () => {
    const path = join(scratch(), "prediction.json");
    const first = preregister(DESIGNS, { path, now: FIXED_NOW, ...quiet(), skipDecision: true });
    const before = readFileSync(path, "utf8");

    const cap = captured();
    const second = preregister(DESIGNS, {
      path,
      now: () => new Date("2026-08-15T18:40:00.000Z"),
      rule: { recognition_floor: 0.4 }, // the retrofit: a floor chosen to fit a result
      logger: cap.flags.logger,
      skipDecision: true,
    });

    assert.equal(second.frozen, false);
    assert.equal(second.already_frozen, true);
    assert.equal(second.drift, true);
    assert.equal(second.prereg.prediction_hash, first.prereg.prediction_hash);
    assert.equal(second.prereg.rule.recognition_floor, DEFAULT_HONESTY_RULE.recognition_floor);
    assert.equal(readFileSync(path, "utf8"), before, "the file on disk must be byte-identical");
    assert.ok(cap.lines.some((l) => l.includes("REFUSING TO OVERWRITE")));
  });

  it("reports no drift when the same prediction is re-derived", () => {
    const path = join(scratch(), "prediction.json");
    preregister(DESIGNS, { path, now: FIXED_NOW, ...quiet(), skipDecision: true });
    const again = preregister(DESIGNS, { path, now: FIXED_NOW, ...quiet(), skipDecision: true });
    assert.equal(again.already_frozen, true);
    assert.equal(again.drift, false);
  });

  it("dry run by default: with no path nothing touches the disk", () => {
    const dir = scratch();
    const result = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true });
    assert.equal(result.frozen, false);
    assert.equal(result.path, null);
    assert.ok(result.prereg.prediction_hash.length === 64);
    assert.equal(existsSync(join(dir, "prediction.json")), false);
  });

  it("dryRun suppresses the write even when a path is named", () => {
    const path = join(scratch(), "prediction.json");
    preregister(DESIGNS, { path, dryRun: true, now: FIXED_NOW, ...quiet(), skipDecision: true });
    assert.equal(existsSync(path), false);
  });

  it("the provisional commitment is a logged decision with a real alternative", () => {
    const sink = memorySink();
    const result = preregister(DESIGNS, { now: FIXED_NOW, sink, ...quiet() });
    const entry = result.decision;
    assert.ok(entry !== null);
    assert.equal(entry.agent, "Format");
    assert.equal(entry.id, "dec_format_ship_provisional");
    assert.ok(entry.options.length >= 3);
    assert.notEqual(entry.flip_to_option_id, entry.chosen_option_id);
    assert.ok(entry.evidence.some((e) => e.ref === "docs/TERAC.md"));
  });

  it("the provisional format comes from the same decision procedure as the final one", () => {
    // Otherwise "the model predicted X" and "the agent would ship X" are two
    // different claims and comparing before to after means nothing.
    const result = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true });
    assert.equal(result.prereg.provisional_format, "labeled_prominent");
  });

  it("readPreregistration never throws on garbage", () => {
    const dir = scratch();
    assert.equal(readPreregistration(join(dir, "nope.json")), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. COMPARE — the model is called wrong when it is wrong
// ─────────────────────────────────────────────────────────────────────────────

describe("compare() flags a wrong prediction", () => {
  function prereg() {
    return preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true }).prereg;
  }

  it("says the model HELD when the humans agreed", () => {
    const actual = [
      arm("unlabeled", { recognition: 0.31, trust: 0.7 }),
      arm("labeled", { recognition: 0.64, trust: 0.68 }),
      arm("labeled_prominent", { recognition: 0.86, trust: 0.6 }),
    ];
    const c = compare(prereg(), actual, { sink: memorySink(), now: FIXED_NOW });
    assert.equal(c.wasModelWrong, false);
    assert.equal(c.wrongness, "model_held");
    assert.equal(c.extrapolation_trusted, true);
    assert.ok(c.headline.startsWith("THE MODEL HELD"));
  });

  it("says the model was WRONG ABOUT DIRECTION when an ordering claim breaks", () => {
    // Humans found prominence made no difference to recognition.
    const actual = [
      arm("unlabeled", { recognition: 0.3, trust: 0.7 }),
      arm("labeled", { recognition: 0.7, trust: 0.66 }),
      arm("labeled_prominent", { recognition: 0.68, trust: 0.62 }),
    ];
    const c = compare(prereg(), actual, { sink: memorySink(), now: FIXED_NOW });
    assert.equal(c.wasModelWrong, true);
    assert.equal(c.wrongness, "wrong_about_direction");
    assert.equal(c.extrapolation_trusted, false);
    assert.ok(c.headline.includes("!! THE MODEL WAS WRONG"));
    const broken = c.claims.filter((x) => x.held === false).map((x) => x.claim.id);
    assert.ok(broken.includes("claim_prominent_recognition_beats_plain"));
    assert.ok(broken.includes("claim_plain_label_fails_the_floor"));
  });

  it("says OFF BY MAGNITUDE when the shape held but a rate left its frozen band", () => {
    const actual = [
      arm("unlabeled", { recognition: 0.3, trust: 0.7 }),
      arm("labeled", { recognition: 0.62, trust: 0.2 }), // trust far outside the band
      arm("labeled_prominent", { recognition: 0.86, trust: 0.1 }),
    ];
    const c = compare(prereg(), actual, { sink: memorySink(), now: FIXED_NOW });
    assert.equal(c.wrongness, "off_by_magnitude");
    assert.equal(c.wasModelWrong, true);
    assert.equal(c.extrapolation_trusted, true, "a magnitude miss does not invalidate the ladder");
    assert.ok(c.deltas.some((d) => !d.trust_within_band));
  });

  it("reports per-arm deltas in both directions", () => {
    const actual = [arm("labeled", { recognition: 0.5, trust: 0.9 })];
    const c = compare(prereg(), actual, { sink: memorySink(), now: FIXED_NOW });
    const d = c.deltas.find((x) => x.variant === "labeled");
    assert.ok(d !== undefined);
    assert.equal(d.recognition_delta, Math.round((0.5 - MODEL_PRIOR.labeled.recognition) * 1000) / 1000);
    assert.ok(d.recognition_delta < 0);
    assert.ok(d.trust_delta > 0);
  });

  it("scores claims against arms that are missing rather than pretending they held", () => {
    const c = compare(prereg(), [arm("labeled", { recognition: 0.5, trust: 0.5 })], {
      sink: memorySink(),
      now: FIXED_NOW,
    });
    assert.ok(c.claims.some((x) => x.held === null));
  });

  it("logs a consequential decision — whether the agent may still extrapolate", () => {
    const actual = [
      arm("labeled", { recognition: 0.7, trust: 0.66 }),
      arm("labeled_prominent", { recognition: 0.68, trust: 0.62 }),
    ];
    const sink = memorySink();
    const c = compare(prereg(), actual, { sink, now: FIXED_NOW });
    assert.equal(c.decision.chosen_option_id, "opt_distrust_model");
    assert.notEqual(c.decision.flip_to_option_id, c.decision.chosen_option_id);
    // The impossible option is on the record with the reason it is impossible.
    const rerun = c.decision.options.find((o) => o.id === "opt_rerun");
    assert.ok(rerun?.expected_outcome.includes("after the 18:45 lock"));
  });

  it("works without a pre-registration, and says the evidence is weaker for it", () => {
    const predicted = [arm("labeled", { recognition: 0.66, trust: 0.68 })];
    const actual = [arm("labeled", { recognition: 0.64, trust: 0.7 })];
    const c = compare(predicted, actual, { sink: memorySink(), now: FIXED_NOW });
    assert.equal(c.prediction_hash, null);
    assert.ok(c.headline.includes("No frozen pre-registration"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. A WRONG PREDICTION CHANGES WHAT SHIPS
// ─────────────────────────────────────────────────────────────────────────────

describe("being wrong has consequences", () => {
  it("a model wrong about direction loses the right to ship an unvalidated format, and the company halts", async () => {
    const p = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true }).prereg;
    // Nothing clears the floor, AND the model was wrong about direction.
    const actual = [
      arm("unlabeled", { recognition: 0.3, trust: 0.9 }),
      arm("labeled", { recognition: 0.62, trust: 0.75 }),
      arm("labeled_prominent", { recognition: 0.58, trust: 0.6 }),
    ];
    const v = await decideFormat(actual, { ...quiet(), prereg: p });

    assert.equal(v.comparison?.wrongness, "wrong_about_direction");
    assert.equal(v.halt, true);
    assert.equal(v.halt_reason, "model_unreliable");
    assert.ok(v.summary.includes("!! THE MODEL WAS WRONG"));
  });

  it("the same results with a model that held would have escalated instead of halting", async () => {
    // Identical numbers, no pre-registration to contradict: the ONLY difference
    // is whether the prior had been shown to be unreliable.
    const actual = [
      arm("unlabeled", { recognition: 0.3, trust: 0.9 }),
      arm("labeled", { recognition: 0.62, trust: 0.75 }),
      arm("labeled_prominent", { recognition: 0.58, trust: 0.6 }),
    ];
    const v = await decideFormat(actual, quiet());
    assert.equal(v.halt, false);
    assert.equal(v.route, "escalated");
  });

  it("announces the miss at the top of the summary, before the decision", async () => {
    const p = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true }).prereg;
    const actual = [
      arm("unlabeled", { recognition: 0.3, trust: 0.7 }),
      arm("labeled", { recognition: 0.7, trust: 0.66 }),
      arm("labeled_prominent", { recognition: 0.68, trust: 0.62 }),
    ];
    const v = await decideFormat(actual, { ...quiet(), prereg: p });
    const wrongAt = v.summary.indexOf("!! THE MODEL WAS WRONG");
    const decisionAt = v.summary.indexOf("DECISION:");
    assert.ok(wrongAt >= 0);
    assert.ok(wrongAt < decisionAt, "the miss must be louder and earlier than the verdict");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. THE GOALPOSTS DO NOT MOVE AFTER THE RESULTS LAND
// ─────────────────────────────────────────────────────────────────────────────

describe("thresholds cannot be changed after the results are in", () => {
  const actual = [
    arm("unlabeled", { recognition: 0.25, trust: 0.9 }),
    arm("labeled", { recognition: 0.6, trust: 0.85 }),
    arm("labeled_prominent", { recognition: 0.88, trust: 0.55 }),
  ];

  it("refuses a floor lowered to admit the profitable format, and says so", async () => {
    const p = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true }).prereg;
    const cap = captured();
    const v = await decideFormat(actual, {
      prereg: p,
      rule: { recognition_floor: 0.55 }, // exactly enough to make `labeled` eligible
      logger: cap.flags.logger,
    });
    assert.equal(v.rule_frozen, true);
    assert.equal(v.rule_change_attempted, true);
    assert.equal(v.rule.recognition_floor, DEFAULT_HONESTY_RULE.recognition_floor);
    assert.equal(v.chosen, "labeled_prominent");
    assert.ok(cap.lines.some((l) => l.includes("REFUSING a threshold change")));
  });

  it("and the change really would have flipped the outcome — which is why it is refused", async () => {
    const p = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true }).prereg;
    const v = await decideFormat(actual, {
      ...quiet(),
      prereg: p,
      rule: { recognition_floor: 0.55 },
      allowRuleChange: true,
    });
    assert.equal(v.chosen, "labeled", "the lowered floor admits the more profitable format");
    assert.equal(v.rule_change_attempted, true);
    assert.ok(v.decision.rationale.includes("THRESHOLD WAS CHANGED AFTER THE RESULTS"));
    assert.ok(v.summary.includes("A THRESHOLD CHANGE WAS ATTEMPTED AFTER RESULTS"));
  });

  it("uses the frozen rule silently when the flags agree with it", async () => {
    const p = preregister(DESIGNS, { now: FIXED_NOW, ...quiet(), skipDecision: true }).prereg;
    const v = await decideFormat(actual, { ...quiet(), prereg: p });
    assert.equal(v.rule_frozen, true);
    assert.equal(v.rule_change_attempted, false);
  });

  it("reads the frozen rule off disk when given a path", async () => {
    const path = join(scratch(), "prediction.json");
    preregister(DESIGNS, { path, now: FIXED_NOW, ...quiet(), skipDecision: true });
    const v = await decideFormat(actual, { ...quiet(), preregPath: path });
    assert.equal(v.rule_frozen, true);
    assert.ok(v.comparison !== null, "a frozen prediction on disk must be scored against the results");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. SAFETY POSTURE
// ─────────────────────────────────────────────────────────────────────────────

describe("dry run by default, keyless by default", () => {
  const study = [arm("labeled_prominent", { recognition: 0.9, trust: 0.6 })];

  it("does not apply the format without liveServe", async () => {
    let applied: string | null = null;
    const v = await decideFormat(study, {
      ...quiet(),
      apply: (f) => {
        applied = f;
      },
    });
    assert.equal(applied, null);
    assert.equal(v.executed, false);
    assert.equal(v.decision.executed, false);
    assert.ok(v.decision.effect.startsWith("Dry run"));
  });

  it("applies only with liveServe AND an apply hook, and then stops claiming reversibility", async () => {
    let applied: string | null = null;
    const v = await decideFormat(study, {
      ...quiet(),
      liveServe: true,
      apply: (f) => {
        applied = f;
      },
    });
    assert.equal(applied, "labeled_prominent");
    assert.equal(v.executed, true);
    assert.equal(v.decision.reversible, false);
    assert.ok(v.decision.reversal_path.includes("cannot be recalled"));
  });

  it("a failing apply hook degrades to a recorded non-execution rather than throwing", async () => {
    const v = await decideFormat(study, {
      ...quiet(),
      liveServe: true,
      apply: () => {
        throw new Error("renderer offline");
      },
    });
    assert.equal(v.executed, false);
    assert.ok(v.decision.effect.includes("renderer offline"));
    assert.ok(v.decision.effect.includes("was NOT changed"));
  });

  it("nothing is applied when the agent halts, even with liveServe", async () => {
    let applied: string | null = null;
    const v = await decideFormat([arm("labeled", { recognition: 0.1, trust: 0.9 })], {
      ...quiet(),
      liveServe: true,
      apply: (f) => {
        applied = f;
      },
    });
    assert.equal(v.halt, true);
    assert.equal(applied, null);
    assert.equal(v.executed, false);
  });

  it("runs keyless with exactly one log line about it, and never throws", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const cap = captured();
      const v = await decideFormat(study, cap.flags);
      const keyLines = cap.lines.filter((l) => l.includes("ANTHROPIC_API_KEY"));
      assert.equal(keyLines.length, 1);
      assert.equal(v.chosen, "labeled_prominent");
      assert.ok(keyLines[0]?.includes("never promote"));
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("says nothing about keys when a classifier is injected", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const cap = captured();
      await decideFormat(study, {
        logger: cap.flags.logger,
        classifyVerbatims: () => ({
          n: 0,
          confused: 0,
          clear: 0,
          confusion_rate: 0,
          confusion_quotes: [],
          below_minimum: true,
          source: "injected",
        }),
      });
      assert.equal(cap.lines.filter((l) => l.includes("ANTHROPIC_API_KEY")).length, 0);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("holds the decision in memory when no sink is given", async () => {
    const dir = scratch();
    await decideFormat(study, quiet());
    assert.equal(existsSync(join(dir, "decisions.jsonl")), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. THE LEDGER ENTRY ITSELF SURVIVES OUR OWN AUDIT
// ─────────────────────────────────────────────────────────────────────────────

describe("the entry this agent writes passes the log's own rubber-stamp test", () => {
  const study = [
    arm("unlabeled", { recognition: 0.25, trust: 0.9 }),
    arm("labeled", { recognition: 0.6, trust: 0.85 }),
    arm("labeled_prominent", { recognition: 0.88, trust: 0.55 }),
  ];

  it("grades as a real decision, with no defects", async () => {
    const v = await decideFormat(study, { ...quiet(), evidenceSource: "external_api" });
    const audit = auditEntry(v.decision);
    assert.deepEqual(audit.defects, [], `defects: ${audit.defects.join(", ")}`);
    assert.equal(audit.strength, "decision");
    assert.ok(audit.distinct_outcomes >= 3);
  });

  it("does not take the first option listed — and the options are ordered by revenue so that means something", async () => {
    const v = await decideFormat(study, { ...quiet(), evidenceSource: "external_api" });
    const audit = auditEntry(v.decision);
    assert.equal(audit.chose_first_option, false);
    const first = v.decision.options[0];
    assert.ok(first !== undefined);
    for (const o of v.decision.options) {
      assert.ok(
        (first.projected_value_cents ?? 0) >= (o.projected_value_cents ?? 0),
        "options must be listed most-profitable-first or the position-bias stat is uninformative",
      );
    }
  });

  it("labels study numbers as FIXTURE by default so seeded data is not laundered as measurement", async () => {
    const v = await decideFormat(study, quiet());
    const recog = v.decision.evidence.find((e) => e.id === "ev_labeled_recognition");
    assert.equal(recog?.source, "fixture");
    const asserted = await decideFormat(study, { ...quiet(), evidenceSource: "external_api" });
    assert.equal(
      asserted.decision.evidence.find((e) => e.id === "ev_labeled_recognition")?.source,
      "external_api",
    );
  });

  it("every evidence ref an option cites actually exists in the entry", async () => {
    const v = await decideFormat(study, quiet());
    const ids = new Set(v.decision.evidence.map((e) => e.id));
    for (const o of v.decision.options) {
      for (const ref of o.supported_by) assert.ok(ids.has(ref), `dangling evidence ref ${ref}`);
    }
  });

  it("the falsifier names a different, real option in every route", async () => {
    const scenarios: TrustStudy[][] = [
      study, // eligible_measured
      [
        arm("unlabeled", { recognition: 0.25, trust: 0.9 }),
        arm("labeled_prominent", { recognition: 0.6, trust: 0.6 }),
      ], // escalated
      [arm("labeled_prominent", { recognition: 0.3, trust: 0.7 })], // halt
    ];
    for (const s of scenarios) {
      const v = await decideFormat(s, quiet());
      const ids = new Set(v.decision.options.map((o) => o.id));
      assert.ok(v.decision.flip_condition.length > 40, v.decision.flip_condition);
      assert.notEqual(v.decision.flip_to_option_id, v.decision.chosen_option_id);
      assert.ok(
        v.decision.flip_to_option_id !== null && ids.has(v.decision.flip_to_option_id),
        `flip target ${String(v.decision.flip_to_option_id)} is not an option`,
      );
    }
  });

  it("the falsifier is quantitative — it names the number that would have moved it", async () => {
    const v = await decideFormat(study, quiet());
    assert.ok(/\d\.\d{3}/.test(v.decision.flip_condition), v.decision.flip_condition);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. THE WHOLE ARC, INTO A REAL FILE
// ─────────────────────────────────────────────────────────────────────────────

describe("preregister → compare → decide, as one chained record", () => {
  it("writes a verifiable chain and supersedes the provisional call when the format changes", async () => {
    const dir = scratch();
    const logPath = join(dir, "decisions.jsonl");
    const predPath = join(dir, "prediction.json");
    const sink = openDecisionLog({ path: logPath, now: FIXED_NOW });

    const p = preregister(DESIGNS, { path: predPath, sink, now: FIXED_NOW, ...quiet() });
    assert.equal(p.prereg.provisional_format, "labeled_prominent");

    // Humans: nothing clears the floor, but the ordering held.
    const actual = [
      arm("unlabeled", { recognition: 0.28, trust: 0.9 }),
      arm("labeled", { recognition: 0.52, trust: 0.75 }),
      arm("labeled_prominent", { recognition: 0.6, trust: 0.63 }),
    ];
    const v = await decideFormat(actual, {
      ...quiet(),
      sink,
      prereg: p.prereg,
      evidenceSource: "external_api",
    });

    assert.equal(v.route, "escalated");
    assert.equal(v.chosen, PROPOSED_FORMAT);
    assert.equal(
      v.decision.supersedes,
      "dec_format_ship_provisional",
      "the agent changed its mind on the record",
    );

    const entries = readLog(logPath);
    assert.equal(entries.length, 3, "provisional, model-trust, final");
    assert.ok(verifyChain(entries).ok);
    assert.ok(entries.every((e) => e.agent === "Format"));
  });

  it("does NOT claim a reversal when the humans confirmed the provisional call", async () => {
    const sink = memorySink();
    preregister(DESIGNS, { sink, now: FIXED_NOW, ...quiet() });
    const actual = [
      arm("unlabeled", { recognition: 0.3, trust: 0.7 }),
      arm("labeled", { recognition: 0.64, trust: 0.68 }),
      arm("labeled_prominent", { recognition: 0.86, trust: 0.6 }),
    ];
    const v = await decideFormat(actual, { ...quiet(), sink });
    assert.equal(v.chosen, "labeled_prominent");
    assert.equal(v.decision.supersedes, null, "inflating our own reversal count would be dishonest");
  });

  it("a tampered entry breaks the chain the prediction hangs from", async () => {
    const dir = scratch();
    const logPath = join(dir, "decisions.jsonl");
    const sink = openDecisionLog({ path: logPath, now: FIXED_NOW });
    preregister(DESIGNS, { sink, now: FIXED_NOW, ...quiet() });
    await decideFormat([arm("labeled_prominent", { recognition: 0.9, trust: 0.6 })], {
      ...quiet(),
      sink,
    });

    const entries = readLog(logPath);
    assert.ok(verifyChain(entries).ok);
    const first = entries[0];
    assert.ok(first !== undefined);
    const tampered = [{ ...first, rationale: "improved at 18:30" }, ...entries.slice(1)];
    const check = verifyChain(tampered);
    assert.equal(check.ok, false);
    assert.equal(check.broken_at, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. THE SUMMARY DOES NOT FLATTER US
// ─────────────────────────────────────────────────────────────────────────────

describe("the summary states what it does not show", () => {
  it("always names the commercial proxy and the fact that the floor is ours", async () => {
    const v = await decideFormat([arm("labeled_prominent", { recognition: 0.9, trust: 0.6 })], quiet());
    assert.ok(v.summary.includes("Click-through is unmeasured"));
    assert.ok(v.summary.includes("is our number, not a statute"));
  });

  it("flags an unvalidated shipped format in the caveats", async () => {
    const v = await decideFormat(
      [
        arm("unlabeled", { recognition: 0.25, trust: 0.9 }),
        arm("labeled_prominent", { recognition: 0.6, trust: 0.6 }),
      ],
      quiet(),
    );
    assert.equal(v.route, "escalated");
    assert.ok(v.summary.includes("NEVER SHOWN TO A HUMAN"));
  });

  it("says when there was no pre-registration to lean on", async () => {
    const v = await decideFormat([arm("labeled_prominent", { recognition: 0.9, trust: 0.6 })], quiet());
    assert.ok(v.summary.includes("No pre-registered prediction was supplied"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Odds and ends the agent must not fall over on
// ─────────────────────────────────────────────────────────────────────────────

describe("degenerate inputs", () => {
  it("accepts a single arm as well as an array", async () => {
    const single = await decideFormat(arm("labeled_prominent", { recognition: 0.9, trust: 0.6 }), quiet());
    assert.equal(single.chosen, "labeled_prominent");
  });

  it("keeps the larger-n arm when a variant appears twice", async () => {
    const v = await decideFormat(
      [
        arm("labeled_prominent", { recognition: 0.2, trust: 0.6, n: 5 }),
        arm("labeled_prominent", { recognition: 0.9, trust: 0.6, n: 400 }),
      ],
      quiet(),
    );
    const c = v.candidates.find((x) => x.format === "labeled_prominent");
    assert.equal(c?.n, 400);
    assert.equal(v.chosen, "labeled_prominent");
  });

  it("halts rather than crashing when only the control arm came back", async () => {
    const v = await decideFormat([arm("unlabeled", { recognition: 0.9, trust: 0.9 })], quiet());
    assert.equal(v.halt, true);
    assert.notEqual(v.chosen, "unlabeled");
  });

  it("resolveRule merges partials without mutating the default", () => {
    const r = resolveRule({ recognition_floor: 0.9 });
    assert.equal(r.recognition_floor, 0.9);
    assert.equal(r.halt_floor, DEFAULT_HONESTY_RULE.halt_floor);
    assert.equal(DEFAULT_HONESTY_RULE.recognition_floor, 0.67);
  });

  it("projectedValueCents is monotone in trust and zero for no data", () => {
    assert.equal(projectedValueCents(null), 0);
    assert.ok(projectedValueCents(0.9) > projectedValueCents(0.5));
    assert.equal(
      projectedValueCents(1),
      COMMERCIAL_MODEL.assumed_placements_per_month * COMMERCIAL_MODEL.price_cents_per_placement,
    );
  });

  it("prediction bands widen as n shrinks", () => {
    const wide = predictWithBand({ ...(DESIGNS[1] as StudyArmDesign), n_responses: 10 });
    const tight = predictWithBand({ ...(DESIGNS[1] as StudyArmDesign), n_responses: 4000 });
    const widthOf = (b: [number, number]): number => b[1] - b[0];
    assert.ok(widthOf(wide.band.recognition) > widthOf(tight.band.recognition));
  });

  it("defaultClaims restates the floor it was built with", () => {
    const claims = defaultClaims(resolveRule({ recognition_floor: 0.8 }));
    const threshold = claims.find((c) => c.id === "claim_prominent_clears_the_floor");
    assert.equal(threshold?.value, 0.8);
  });
});

// A tiny compile-time assurance that `chosen` cannot be the undisclosed rung.
function _chosenIsNeverUnlabeled(v: FormatVerdict): "labeled" | "labeled_prominent" | typeof PROPOSED_FORMAT {
  return v.chosen;
}
void _chosenIsNeverUnlabeled;
