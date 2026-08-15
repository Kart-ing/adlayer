/**
 * ADLAYER — the FORMAT agent.
 *
 * PRD §2 assigns this agent the brief's "hard decisions" function: it reads what
 * real humans said in the Terac panel and decides **which disclosure format we
 * ship**. It is the agent most exposed to judging, so it is written to be read
 * by someone looking for theatre.
 *
 * ── WHY THIS IS A DECISION AND NOT A FORMATTER ───────────────────────────────
 *
 * The bar we set ourselves: remove the agent, hardcode its output, and if
 * nothing observable changes it was decoration. Here is what changes.
 *
 * The agent faces a genuine conflict of interest with a genuine cost either way:
 *
 *   · Prominent disclosure RAISES ad recognition. That is the honest outcome and
 *     it is the entire ethical claim of this company.
 *   · Prominent disclosure LOWERS trust in the assistant, and trust is what the
 *     advertiser is buying. Our own revenue moves the other way.
 *
 * A formatter picks the prettier string. This agent has to pick a side, and the
 * two sides point at different formats with different revenue attached. In the
 * default commercial model an undisclosed placement is worth ~$20,000/month and
 * the most disclosed one ~$12,200/month. The agent gives up the difference,
 * every time, on purpose, and writes the number it gave up into the ledger.
 *
 * It can also be WRONG in three ways that reality will settle:
 *
 *   1. It can ship a format whose recognition rate humans then fail to reach.
 *   2. It can HALT the company's only revenue line — refuse to serve any ad at
 *      all — when no measured format clears the honesty floor. If it halts on a
 *      panel that a better agent would have shipped, it destroyed the business
 *      for nothing.
 *   3. It can ship `labeled_prominent_isolated`, a format **no human in the
 *      panel ever saw**, on the strength of its own extrapolation.
 *
 * Any of those is a defensible call that a competent reviewer could take the
 * other side of. That is the definition we are working to.
 *
 * ── HOW THE HONESTY PRIORITY IS ENCODED ──────────────────────────────────────
 *
 * The brief requires that honesty beat commercial interest when they conflict.
 * The tempting way to do that is a weighted score with a big honesty weight.
 * We deliberately did NOT do that, because a weighted score is a price: make the
 * commercial term large enough and honesty is bought out. Instead:
 *
 *   **Honesty is a CONSTRAINT. Revenue is the objective under the constraint.**
 *
 *   Step 1. Every candidate format must clear the honesty rule (`HonestyRule`).
 *           A format below the recognition floor is INELIGIBLE at any price.
 *   Step 2. Among formats that clear it, maximise projected revenue.
 *   Step 3. If the constraint set is empty, ESCALATE the format or HALT serving.
 *           We never relax the constraint to admit a profitable format.
 *
 * There is no coefficient anywhere in this file that trades recognition against
 * revenue, and that absence is the design.
 *
 * A second principle, applied twice and named because it is load-bearing:
 *
 *   **UNCERTAINTY IS SPENT ON THE READER, NOT ON US.** n=40 makes every rate
 *   noisy. Where noise touches the honesty test we resolve it against ourselves
 *   (the point estimate must clear the floor — "close enough" is not enough).
 *   Where noise touches the commercial test we also resolve it against ourselves
 *   (a revenue advantage inside sampling error does not count, so the more
 *   disclosed format wins the tie). Same uncertainty, both directions, always
 *   toward the reader.
 *
 * ── THE TERAC CONSTRAINT, AND WHY PREDICTION IS PRE-REGISTERED ───────────────
 *
 * docs/TERAC.md: panel latency is 5–6 hours and submissions lock at 18:45. There
 * is exactly ONE study cycle. A sequential before/after is arithmetically
 * impossible, so the before/after is:
 *
 *      BEFORE = the model's predicted human verdict, frozen to disk
 *      AFTER  = the actual human verdict
 *
 * That only means something if the prediction genuinely predates the results.
 * Four mechanisms, in increasing strength:
 *
 *   1. `preregister()` writes with `flag: "wx"` — this module has no code path
 *      that can overwrite a prediction file. Retrofitting requires deleting the
 *      file by hand, outside this code.
 *   2. The file carries `frozen_at` and a `prediction_hash` over its canonical
 *      contents, so a quoted hash pins the whole prediction.
 *   3. **The frozen file contains the DECISION RULE, not just the numbers.** The
 *      floors are committed before anyone knows which arm wins, so we cannot
 *      move a threshold to select the commercially convenient format afterwards.
 *      `decideFormat()` uses the frozen rule and refuses a silent change.
 *   4. The prediction hash is appended to the DecisionLog, which is a SHA-256
 *      chain. Every later entry extends it. Editing the prediction after results
 *      land breaks every entry written since.
 *
 *   What none of this proves, stated plainly: the clock is ours. The external
 *   anchors are the git commit that contains the prediction file and the Terac
 *   submission timestamps on the results. Believe the ordering because forging
 *   it means forging those too, not because a JSON file says a time.
 *
 * `compare()` then scores the prediction against pre-registered, checkable
 * claims — not against a vibe. When the model was wrong it says so loudly, and
 * being publicly wrong is the point: it is far stronger evidence that real
 * humans changed this product than a prediction that happened to be right.
 *
 * ── HONEST LIMITS ────────────────────────────────────────────────────────────
 *
 *   · `TrustStudy` carries no click-through rate, so "commercial interest" is
 *     proxied by `trust_rate` under a stated monotone assumption. That proxy is
 *     the weakest link in this file and it is named in `COMMERCIAL_MODEL`.
 *   · The verbatim reader is a keyword lexicon. It is crude, so it is wired
 *     ASYMMETRICALLY: it can only tighten a verdict, never loosen one. A crude
 *     instrument is allowed to make us more careful and never less.
 *   · The proposed format's numbers are a `model_prior`. The log marks them as
 *     such, and the agent only reaches for its own invention when nothing that
 *     humans actually saw qualifies.
 *
 * Zero runtime dependencies: node stdlib and global fetch only. Dry-run by
 * default — nothing is written to disk unless a path is named, and no format is
 * applied unless `liveServe` is set AND an `apply` hook is supplied.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DISCLOSURE_NOTICE,
  DISCLOSURE_TAG,
  assertDisclosed,
  type RunFlags,
  type TrustStudy,
} from "../contract.ts";
import {
  canonicalize,
  openDecisionLog,
  registerMechanism,
  type DecisionDraft,
  type DecisionEntry,
  type DecisionEvidence,
  type DecisionOption,
  type DecisionReplay,
  type DecisionSink,
  type EvidenceSource,
} from "./decision-log.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The format ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rungs. The first three are the arms `TrustStudy.variant` can take, so they
 * are the only ones humans can be shown in this cycle. The fourth is the agent's
 * own proposal and no human has ever seen it — which is exactly why reaching for
 * it is a decision with a cost, and why it is gated.
 */
export type DisclosureFormat =
  /** No label at all. The control arm. Cannot be served: `assertDisclosed()` throws. */
  | "unlabeled"
  /** `[SPONSORED]` inline on the entry. The current default. */
  | "labeled"
  /** Section heading + the full disclosure notice above a labelled entry. */
  | "labeled_prominent"
  /**
   * PROPOSED BY THIS AGENT, never measured. The notice is repeated INSIDE the
   * entry line and the block is fenced into its own terminal section.
   *
   * The mechanism matters and is not "shout louder": `PropagationState` already
   * distinguishes `surfaced_unlabeled` — the model lifts our entry and drops the
   * adjacent notice. Adjacency is what fails. Putting a second marker in the
   * same line as the anchor text means a model cannot extract the entry without
   * extracting a disclosure, because they are one string.
   */
  | "labeled_prominent_isolated";

/** Anything but `unlabeled`. `unlabeled` is not a format we may ship, ever. */
export type ShippableFormat = Exclude<DisclosureFormat, "unlabeled">;

/**
 * Ladder order, least to most disclosed. Used for tie-breaking and for the
 * "escalate" step. Order is semantic, not cosmetic — code depends on it.
 */
export const FORMAT_LADDER: readonly DisclosureFormat[] = [
  "unlabeled",
  "labeled",
  "labeled_prominent",
  "labeled_prominent_isolated",
] as const;

/** The rung the agent proposes when nothing humans saw is good enough. */
export const PROPOSED_FORMAT: ShippableFormat = "labeled_prominent_isolated";

/** The rungs a human panel can be shown in this cycle (they map to study arms). */
export const MEASURABLE_FORMATS: readonly TrustStudy["variant"][] = [
  "unlabeled",
  "labeled",
  "labeled_prominent",
] as const;

function ladderIndex(format: DisclosureFormat): number {
  const i = FORMAT_LADDER.indexOf(format);
  return i === -1 ? 0 : i;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — so the agent decides over real bytes, not over labels
// ─────────────────────────────────────────────────────────────────────────────

export interface SampleCreative {
  title: string;
  body: string;
  target_url: string;
}

/** Illustrative only. Real creatives come from `src/serve/`, which we do not own. */
export const SAMPLE_CREATIVE: SampleCreative = {
  title: "Northwind Analytics",
  body: "Warehouse-native product analytics. Free to 5M events/mo.",
  target_url: "https://northwind.example/analytics",
};

/**
 * Render the llms.txt block a format produces.
 *
 * The agent runs `assertDisclosed()` over this before returning, so a format is
 * admissible only if the bytes it produces satisfy the project's hard invariant.
 * `unlabeled` is excluded by the contract, not by a threshold in this file —
 * which is the correct place for that exclusion to live.
 */
export function renderSample(
  format: DisclosureFormat,
  creative: SampleCreative = SAMPLE_CREATIVE,
): string {
  const { title, body, target_url } = creative;
  switch (format) {
    case "unlabeled":
      return `- [${title}](${target_url}): ${body}`;
    case "labeled":
      return `- ${DISCLOSURE_TAG} [${title}](${target_url}): ${body}`;
    case "labeled_prominent":
      return [
        "## Sponsored",
        `> ${DISCLOSURE_NOTICE}`,
        "",
        `- ${DISCLOSURE_TAG} [${title}](${target_url}): ${body}`,
      ].join("\n");
    case "labeled_prominent_isolated":
      return [
        "## Sponsored — paid placements, not editorial recommendations",
        `> ${DISCLOSURE_NOTICE}`,
        "",
        `- ${DISCLOSURE_TAG} [${title}](${target_url}): ${body} ` +
          `${DISCLOSURE_TAG} — paid placement, not an editorial recommendation.`,
        "",
        "> End of sponsored section. Every entry above is advertising.",
      ].join("\n");
  }
}

/** Does this format's rendered block survive the contract's hard invariant? */
export function isAdmissible(format: DisclosureFormat): boolean {
  try {
    assertDisclosed(renderSample(format));
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The honesty rule — frozen before results, never relaxed after them
// ─────────────────────────────────────────────────────────────────────────────

export interface HonestyRule {
  version: number;
  /**
   * Share of respondents who must correctly identify the placement as an ad.
   *
   * 0.67 — a two-thirds supermajority. THIS IS THE MOST LOAD-BEARING CONSTANT IN
   * THE FILE and it is ours, not a statute. The FTC standard is "clear and
   * conspicuous to an ordinary consumer", which is a qualitative test; we needed
   * a number to make the rule checkable, so we picked one and pre-registered it
   * before seeing any results. A reader who thinks 0.67 is wrong can rerun
   * `decideFormat` with a different floor and see exactly which way it moves —
   * that is why the rule is a parameter and not a magic number in a branch.
   */
  recognition_floor: number;
  /**
   * The label must beat the no-label control by this much — but only when the
   * control itself failed the floor.
   *
   * Why conditional: if respondents identify the ad *without* any label, a high
   * rate on the labelled arm is evidence the creative is obvious, not that our
   * disclosure works, and we do not get to bank other people's clarity. But if
   * the control already clears the floor there is no headroom to show lift in,
   * and demanding it would make every format ineligible forever — an absurd
   * result from a ceiling effect. So the lift test only fires where it can mean
   * something.
   */
  lift_floor: number;
  /**
   * Below this, the best label we measured is not merely insufficient — a
   * majority cannot tell it is an ad at all. The failure is then in the medium,
   * not in the typography, and no rearrangement of characters is a credible fix.
   * We stop serving instead of escalating.
   */
  halt_floor: number;
  /** z for "is this difference real". 1.96 ≈ 95%. */
  noise_z: number;
  /**
   * Share of free-text verbatims volunteering confusion ("I didn't realise it
   * was an ad") that vetoes a format the tick-box question passed. One-way: it
   * can veto, never promote. See `analyzeVerbatims`.
   */
  confusion_veto: number;
  /** Below this many verbatims the veto cannot fire — too few to mean anything. */
  min_verbatims_for_veto: number;
  /**
   * `model_prior`. How much recognition we expect the proposed rung to add over
   * the best measured one. Used ONLY to decide whether escalating is even worth
   * attempting; if the estimate does not clear the floor we halt instead of
   * shipping something we do not believe reaches it.
   */
  escalation_recognition_lift: number;
}

export const DEFAULT_HONESTY_RULE: HonestyRule = {
  version: 1,
  recognition_floor: 0.67,
  lift_floor: 0.15,
  halt_floor: 0.4,
  noise_z: 1.96,
  confusion_veto: 0.25,
  min_verbatims_for_veto: 8,
  escalation_recognition_lift: 0.1,
};

const RULE_KEYS: readonly (keyof HonestyRule)[] = [
  "version",
  "recognition_floor",
  "lift_floor",
  "halt_floor",
  "noise_z",
  "confusion_veto",
  "min_verbatims_for_veto",
  "escalation_recognition_lift",
];

export function resolveRule(overrides?: Partial<HonestyRule> | null): HonestyRule {
  return { ...DEFAULT_HONESTY_RULE, ...(overrides ?? {}) };
}

/** Which rule fields differ. Used to catch a threshold moved after results land. */
export function ruleDiff(a: HonestyRule, b: HonestyRule): (keyof HonestyRule)[] {
  return RULE_KEYS.filter((k) => a[k] !== b[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The commercial model — the side of the conflict we are supposed to lose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE WEAKEST LINK IN THIS FILE, named so no one has to find it.
 *
 * `TrustStudy` measures trust and recognition. It does not measure click-through
 * or advertiser willingness-to-pay, so we cannot price a format directly. We
 * assume advertiser value moves with retained trust: a placement inside an
 * assistant whose readers have stopped believing it is worth less than the same
 * placement inside one they still believe. That assumption is monotone,
 * plausible, and unmeasured.
 *
 * It is used for ONE thing: ranking eligible formats against each other. It
 * never decides eligibility, so an error here cannot make a dishonest format
 * shippable — it can only pick the wrong honest one. That containment is
 * deliberate.
 *
 * The volume and price are stated assumptions, not observations. $20 per
 * placement is the PRD's transaction price.
 */
export const COMMERCIAL_MODEL = {
  assumed_placements_per_month: 1000,
  price_cents_per_placement: 2000,
  proxy: "trust_rate",
  caveat:
    "Click-through is unmeasured; advertiser value is proxied by retained trust " +
    "under a monotone assumption. Ranking only — never eligibility.",
} as const;

export function projectedValueCents(trustRate: number | null): number {
  if (trustRate === null || !Number.isFinite(trustRate)) return 0;
  return Math.round(
    COMMERCIAL_MODEL.assumed_placements_per_month *
      COMMERCIAL_MODEL.price_cents_per_placement *
      clamp01(trustRate),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small statistics. n=40 is small; pretending otherwise is the easiest way to
// launder noise into a decision.
// ─────────────────────────────────────────────────────────────────────────────

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Standard error of a proportion. n<=0 means no information: maximal error. */
export function standardError(p: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const q = clamp01(p);
  return Math.sqrt((q * (1 - q)) / n);
}

/**
 * Is the gap between two measured proportions inside sampling noise?
 *
 * Used only on the COMMERCIAL side of the comparison. A revenue advantage that
 * cannot be distinguished from noise does not get to move the format down the
 * ladder — the uncertainty is spent on the reader.
 */
export function differenceIsNoise(
  a: number,
  nA: number,
  b: number,
  nB: number,
  z: number,
): boolean {
  const se = Math.sqrt(standardError(a, nA) ** 2 + standardError(b, nB) ** 2);
  return Math.abs(a - b) < z * se;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verbatims — the signal no threshold captures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A respondent can tick "yes, that was an ad" on a forced-choice question and
 * still write "honestly I only noticed once you asked." The tick-box measures
 * recognition-on-prompting; the verbatim measures recognition-in-the-wild, and
 * those are different quantities. This reads the second one.
 *
 * The instrument is a keyword lexicon and it is crude — it will miss sarcasm and
 * it will trip on a quoted phrase. So it is wired one-way: it can VETO a format
 * that passed, and it can never promote one that failed. A crude instrument may
 * make us more careful. It may not make us less.
 */
export const CONFUSION_LEXICON: readonly string[] = [
  "didn't realise",
  "didnt realise",
  "didn't realize",
  "didnt realize",
  "did not realise",
  "did not realize",
  "no idea it was",
  "not obvious",
  "wasn't obvious",
  "wasnt obvious",
  "almost missed",
  "nearly missed",
  "i missed",
  "only noticed",
  "had to look",
  "sneaky",
  "tricked",
  "misleading",
  "deceptive",
  "disguised",
  "blends in",
  "blended in",
  "buried",
  "hidden",
  "fooled",
  "too subtle",
  "easy to miss",
  "slipped past",
  "thought it was a recommendation",
  "looked like editorial",
] as const;

export const CLARITY_LEXICON: readonly string[] = [
  "obvious",
  "clearly marked",
  "clearly labelled",
  "clearly labeled",
  "very clear",
  "upfront",
  "up front",
  "easy to spot",
  "stood out",
  "stands out",
  "transparent",
  "couldn't miss",
  "couldnt miss",
  "unmissable",
  "right there",
  "no doubt it was an ad",
] as const;

export interface VerbatimSignal {
  n: number;
  confused: number;
  clear: number;
  /** confused / n. Denominator is ALL verbatims, not just matched ones. */
  confusion_rate: number;
  /** The actual sentences that tripped it, so a reader can check the call. */
  confusion_quotes: string[];
  /** True when there are too few verbatims for the veto to be allowed to fire. */
  below_minimum: boolean;
  source: "lexicon" | "injected";
}

/**
 * Deterministic, keyless, auditable.
 *
 * Two denominator choices worth stating. (1) The denominator is every verbatim,
 * not every matched verbatim — matched-only would read 1-of-2 as a 50% confusion
 * rate and veto on nothing. (2) Any confusion phrase marks the response as
 * confused even if a clarity phrase also matched, because "it was obvious once I
 * looked, but I nearly missed it" is a report of confusion.
 */
export function analyzeVerbatims(
  verbatims: readonly string[],
  rule: HonestyRule = DEFAULT_HONESTY_RULE,
): VerbatimSignal {
  const list = Array.isArray(verbatims) ? verbatims : [];
  const real = list.filter(
    (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith(PREDICTED_VERBATIM_PREFIX),
  );
  const quotes: string[] = [];
  let confused = 0;
  let clear = 0;
  for (const v of real) {
    const hay = v.toLowerCase();
    const isConfused = CONFUSION_LEXICON.some((phrase) => hay.includes(phrase));
    if (isConfused) {
      confused += 1;
      quotes.push(v.length > 140 ? `${v.slice(0, 139)}…` : v);
      continue;
    }
    if (CLARITY_LEXICON.some((phrase) => hay.includes(phrase))) clear += 1;
  }
  const n = real.length;
  return {
    n,
    confused,
    clear,
    confusion_rate: n === 0 ? 0 : Math.round((confused / n) * 1000) / 1000,
    confusion_quotes: quotes.slice(0, 5),
    below_minimum: n < rule.min_verbatims_for_veto,
    source: "lexicon",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PREDICT — the "before" half of the mandatory Terac before/after
// ─────────────────────────────────────────────────────────────────────────────

export const PREDICTED_VERBATIM_PREFIX = "PREDICTED THEME:";

export interface StudyArmDesign {
  /** Our id for the arm. Becomes the predicted study's id, prefixed. */
  id: string;
  variant: TrustStudy["variant"];
  question: string;
  /** Planned n for this arm. Drives the width of the prediction band. */
  n_responses: number;
  /** Free text — "general population, US" etc. Recorded, not used in the model. */
  audience?: string;
  /** ISO. When we expect it to run. */
  planned_ran_at?: string;
}

export interface PredictionBand {
  trust: [number, number];
  recognition: [number, number];
}

export interface PredictedArm {
  design: StudyArmDesign;
  study: TrustStudy;
  band: PredictionBand;
  reasoning: string;
}

/**
 * The model's prior, stated as numbers with the reasoning attached, because a
 * prediction whose reasoning is hidden cannot be wrong in an interesting way.
 *
 * The shape of the prior is the whole commercial tension in three rows: the
 * arm with the HIGHEST trust is the one with the LOWEST recognition. If humans
 * confirm that, honest disclosure costs us money and the agent has to pay it.
 */
export const MODEL_PRIOR: Record<
  TrustStudy["variant"],
  { trust: number; recognition: number; why: string }
> = {
  unlabeled: {
    trust: 0.72,
    recognition: 0.3,
    why:
      "Nothing looks wrong, so trust stays near baseline — this is the arm that " +
      "pays best. About three in ten spot a placement from the copy alone.",
  },
  labeled: {
    trust: 0.68,
    recognition: 0.66,
    why:
      "An inline [SPONSORED] tag is read by most but not all — it sits inside a " +
      "dense list and competes with the anchor text. Deliberately predicted just " +
      "BELOW the 0.67 floor: we expect the plain label to fail, narrowly.",
  },
  labeled_prominent: {
    trust: 0.61,
    recognition: 0.85,
    why:
      "A heading plus the full notice is hard to miss, and the reminder that this " +
      "is advertising costs roughly seven points of trust versus the plain label.",
  },
};

/**
 * A minimum band half-width on top of sampling error. Sampling error alone at
 * n=40 is already ±0.15, so this rarely binds; it exists so a huge n cannot
 * produce a band so tight that being "wrong" is guaranteed and meaningless.
 */
export const MIN_BAND_HALF_WIDTH = 0.08;

function bandFor(p: number, n: number, z: number): [number, number] {
  const half = Math.max(MIN_BAND_HALF_WIDTH, z * standardError(p, n));
  return [clamp01(p - half), clamp01(p + half)];
}

/**
 * The model's guess for one arm. Pure and deterministic — no clock, no disk, no
 * network — so a reader can rerun it and get the same numbers.
 *
 * Returns a `TrustStudy` exactly, so a predicted arm is the same shape as a real
 * one and `compare()` does not need a special case. `ran_at` on a prediction is
 * the planned run time (or the freeze time), and the verbatims are predicted
 * THEMES, marked with `PREDICTED_VERBATIM_PREFIX` and excluded from comparison —
 * predicting the exact sentences a stranger will type is not a falsifiable claim
 * and pretending otherwise would be padding.
 */
export function predict(design: StudyArmDesign, opts: { now?: () => Date } = {}): TrustStudy {
  const now = opts.now ?? ((): Date => new Date());
  const prior = MODEL_PRIOR[design.variant];
  const n = Number.isFinite(design.n_responses) && design.n_responses > 0 ? design.n_responses : 0;
  return {
    id: `predicted_${design.id}`,
    variant: design.variant,
    question: design.question,
    n_responses: n,
    trust_rate: prior.trust,
    ad_recognition_rate: prior.recognition,
    verbatims: [
      `${PREDICTED_VERBATIM_PREFIX} ${prior.why}`,
      `${PREDICTED_VERBATIM_PREFIX} excluded from compare() — predicted prose is not a falsifiable claim.`,
    ],
    ran_at: design.planned_ran_at ?? now().toISOString(),
  };
}

/** `predict()` plus the pre-registered band the actual must land inside. */
export function predictWithBand(
  design: StudyArmDesign,
  rule: HonestyRule = DEFAULT_HONESTY_RULE,
  opts: { now?: () => Date } = {},
): PredictedArm {
  const study = predict(design, opts);
  const prior = MODEL_PRIOR[design.variant];
  return {
    design,
    study,
    band: {
      trust: bandFor(study.trust_rate, study.n_responses, rule.noise_z),
      recognition: bandFor(study.ad_recognition_rate, study.n_responses, rule.noise_z),
    },
    reasoning: prior.why,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-registered claims — sharper than a band, and able to fail
// ─────────────────────────────────────────────────────────────────────────────

export type ClaimMetric = "trust_rate" | "ad_recognition_rate";

/**
 * A claim in a tiny declarative language, so it serialises to the frozen file
 * and is evaluated by code rather than by us reading our own prediction
 * charitably afterwards.
 *
 * Bands are wide at n=40 and easy to land inside. ORDERING claims are not — they
 * are the claims the decision actually rests on ("prominent beats plain on
 * recognition"; "prominence costs trust"), and they can be flatly wrong.
 */
export interface PreregisteredClaim {
  id: string;
  /** The claim in a sentence, for the summary a human reads. */
  statement: string;
  metric: ClaimMetric;
  left: TrustStudy["variant"];
  /** Ordering claim when set; threshold claim against `value` when null. */
  right: TrustStudy["variant"] | null;
  op: ">" | "<" | ">=" | "<=";
  /** Threshold claims only. */
  value: number | null;
  /** Ordering claims only: the gap must reach this to count as a real ordering. */
  margin: number;
}

export interface ClaimResult {
  claim: PreregisteredClaim;
  /** null when an arm named by the claim is missing from the actual results. */
  held: boolean | null;
  detail: string;
}

/** The default claim set. Several of these can, and should, be able to fail. */
export function defaultClaims(rule: HonestyRule): PreregisteredClaim[] {
  return [
    {
      id: "claim_prominent_recognition_beats_plain",
      statement:
        "Prominent disclosure raises ad recognition over the plain inline label by at least 5 points.",
      metric: "ad_recognition_rate",
      left: "labeled_prominent",
      right: "labeled",
      op: ">",
      value: null,
      margin: 0.05,
    },
    {
      id: "claim_prominence_costs_trust",
      statement:
        "Prominence costs trust: the prominent arm trusts the assistant less than the plain-label arm.",
      metric: "trust_rate",
      left: "labeled_prominent",
      right: "labeled",
      op: "<",
      value: null,
      margin: 0.02,
    },
    {
      id: "claim_plain_label_fails_the_floor",
      statement: `The plain inline label FAILS our recognition floor of ${rule.recognition_floor}.`,
      metric: "ad_recognition_rate",
      left: "labeled",
      right: null,
      op: "<",
      value: rule.recognition_floor,
      margin: 0,
    },
    {
      id: "claim_prominent_clears_the_floor",
      statement: `Prominent disclosure CLEARS the recognition floor of ${rule.recognition_floor}.`,
      metric: "ad_recognition_rate",
      left: "labeled_prominent",
      right: null,
      op: ">=",
      value: rule.recognition_floor,
      margin: 0,
    },
    {
      id: "claim_dishonest_arm_pays_best",
      statement:
        "The undisclosed arm is the commercially best one — it retains more trust than the prominent arm.",
      metric: "trust_rate",
      left: "unlabeled",
      right: "labeled_prominent",
      op: ">",
      value: null,
      margin: 0.05,
    },
  ];
}

function metricOf(study: TrustStudy, metric: ClaimMetric): number {
  return metric === "trust_rate" ? study.trust_rate : study.ad_recognition_rate;
}

export function evaluateClaim(
  claim: PreregisteredClaim,
  arms: ReadonlyMap<string, TrustStudy>,
): ClaimResult {
  const left = arms.get(claim.left);
  if (left === undefined) {
    return { claim, held: null, detail: `arm "${claim.left}" was not in the results` };
  }
  const l = metricOf(left, claim.metric);

  if (claim.right === null) {
    const v = claim.value ?? 0;
    const held =
      claim.op === ">"
        ? l > v
        : claim.op === ">="
          ? l >= v
          : claim.op === "<"
            ? l < v
            : l <= v;
    return {
      claim,
      held,
      detail: `${claim.left}.${claim.metric} = ${fmt(l)} ${claim.op} ${fmt(v)} → ${held ? "held" : "BROKE"}`,
    };
  }

  const right = arms.get(claim.right);
  if (right === undefined) {
    return { claim, held: null, detail: `arm "${claim.right}" was not in the results` };
  }
  const r = metricOf(right, claim.metric);
  const gap = claim.op === "<" || claim.op === "<=" ? r - l : l - r;
  const held = gap >= claim.margin;
  return {
    claim,
    held,
    detail:
      `${claim.left}.${claim.metric} = ${fmt(l)} vs ${claim.right} = ${fmt(r)} ` +
      `(gap ${fmt(gap)}, needed ${fmt(claim.margin)}) → ${held ? "held" : "BROKE"}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-REGISTRATION — freeze the prediction AND the rule, before results
// ─────────────────────────────────────────────────────────────────────────────

export const PREREGISTRATION_SCHEMA_VERSION = 1;

export interface Preregistration {
  schema_version: number;
  /** ISO. When this was frozen. See the header for what this does and does not prove. */
  frozen_at: string;
  study_label: string;
  /** THE DECISION RULE, frozen before anyone knows which arm wins. */
  rule: HonestyRule;
  arms: PredictedArm[];
  claims: PreregisteredClaim[];
  /**
   * What we would ship if the results never came back — a live contingency given
   * a 5–6h panel against an 18:45 lock, not a hypothetical.
   */
  provisional_format: ShippableFormat;
  /** SHA-256 over `{rule, arms, claims, provisional_format}` in canonical form. */
  prediction_hash: string;
  note: string;
}

export function preregistrationHash(
  parts: Pick<Preregistration, "rule" | "arms" | "claims" | "provisional_format">,
): string {
  return createHash("sha256")
    .update(
      canonicalize({
        rule: parts.rule,
        arms: parts.arms,
        claims: parts.claims,
        provisional_format: parts.provisional_format,
      }),
    )
    .digest("hex");
}

export interface PreregisterOptions {
  studyLabel?: string;
  rule?: Partial<HonestyRule>;
  claims?: PreregisteredClaim[];
  /** Omit and NOTHING is written to disk. Naming a path is the opt-in. */
  path?: string | null;
  /** Force memory-only even with a path. */
  dryRun?: boolean;
  /** Decision sink. Defaults to a memory-only log. */
  sink?: DecisionSink;
  now?: () => Date;
  logger?: (message: string) => void;
  /** Skip appending the provisional decision. Used by tests. */
  skipDecision?: boolean;
}

export interface PreregisterResult {
  prereg: Preregistration;
  /** True when this call is what put the prediction on disk. */
  frozen: boolean;
  /** True when a prediction already existed at `path` and was left alone. */
  already_frozen: boolean;
  /**
   * True when a prediction already existed AND its hash differs from what we
   * would predict now. That is a retrofit attempt, whether or not it was
   * intended, and it is reported rather than resolved.
   */
  drift: boolean;
  path: string | null;
  /** The provisional shipping decision, stamped into the chain. */
  decision: DecisionEntry | null;
}

/**
 * Freeze the model's verdict before the humans answer.
 *
 * The anti-retrofit mechanism is `flag: "wx"` — there is deliberately no code
 * path in this module that overwrites an existing prediction. If the file is
 * there we read it, return it, and report drift; we do not "update" it. Undoing
 * that requires deleting the file by hand, which leaves a hole in git history
 * where the original used to be.
 */
export function preregister(
  designs: readonly StudyArmDesign[],
  options: PreregisterOptions = {},
): PreregisterResult {
  const now = options.now ?? ((): Date => new Date());
  const log = options.logger ?? ((m: string): void => console.log(m));
  const rule = resolveRule(options.rule);
  const memoryOnly =
    options.dryRun === true || options.path === undefined || options.path === null;
  const path = memoryOnly ? null : String(options.path);

  const arms = designs.map((d) => predictWithBand(d, rule, { now }));
  const claims = options.claims ?? defaultClaims(rule);
  const provisional = provisionalFormatFromPrior(arms, rule);
  const body = { rule, arms, claims, provisional_format: provisional };
  const fresh: Preregistration = {
    schema_version: PREREGISTRATION_SCHEMA_VERSION,
    frozen_at: now().toISOString(),
    study_label: options.studyLabel ?? "adlayer-disclosure-trust-study",
    ...body,
    prediction_hash: preregistrationHash(body),
    note:
      "Frozen BEFORE the panel returned. The hash chain in decisions.jsonl and the " +
      "git commit containing this file are the external anchors; a timestamp we " +
      "wrote ourselves proves nothing on its own.",
  };

  let prereg = fresh;
  let frozen = false;
  let alreadyFrozen = false;
  let drift = false;

  if (path === null) {
    if (options.path !== undefined && options.path !== null) {
      log(`[adlayer:format] dry run — prediction held in memory, ${String(options.path)} untouched`);
    }
  } else {
    const existing = readPreregistration(path);
    if (existing !== null) {
      alreadyFrozen = true;
      prereg = existing;
      drift = existing.prediction_hash !== fresh.prediction_hash;
      log(
        drift
          ? `[adlayer:format] REFUSING TO OVERWRITE ${path}: a prediction was already frozen at ` +
            `${existing.frozen_at} (hash ${existing.prediction_hash.slice(0, 12)}…) and the model now ` +
            `predicts something different (hash ${fresh.prediction_hash.slice(0, 12)}…). The frozen one stands.`
          : `[adlayer:format] prediction already frozen at ${existing.frozen_at} (hash ` +
            `${existing.prediction_hash.slice(0, 12)}…) — unchanged, left alone`,
      );
    } else {
      try {
        const dir = dirname(path);
        if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        // "wx": create, or fail if it exists. This module cannot overwrite a
        // prediction. That is the point of the whole exercise.
        writeFileSync(path, `${JSON.stringify(fresh, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        frozen = true;
        log(
          `[adlayer:format] prediction FROZEN at ${fresh.frozen_at} → ${path} ` +
            `(hash ${fresh.prediction_hash.slice(0, 12)}…)`,
        );
      } catch (err) {
        // Lost a race, or the disk said no. Either way: report, never throw.
        const again = readPreregistration(path);
        if (again !== null) {
          prereg = again;
          alreadyFrozen = true;
          drift = again.prediction_hash !== fresh.prediction_hash;
          log(`[adlayer:format] prediction was frozen by another writer at ${again.frozen_at}`);
        } else {
          log(
            `[adlayer:format] could not freeze prediction to ${path}: ` +
              `${err instanceof Error ? err.message : String(err)} — continuing in memory`,
          );
        }
      }
    }
  }

  let decision: DecisionEntry | null = null;
  if (options.skipDecision !== true) {
    const sink = options.sink ?? openDecisionLog({ now });
    decision = appendProvisionalDecision(sink, prereg, { frozen, alreadyFrozen, drift, path });
  }

  return { prereg, frozen, already_frozen: alreadyFrozen, drift, path, decision };
}

/** Read a frozen prediction. Never throws — a missing or broken file is `null`. */
export function readPreregistration(path: string): Preregistration | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p["prediction_hash"] !== "string" || !Array.isArray(p["arms"])) return null;
    return parsed as Preregistration;
  } catch {
    return null;
  }
}

/**
 * What we would ship on the prior alone. Runs the real decision procedure over
 * the PREDICTED arms, so the provisional call and the final call are produced by
 * the same code — otherwise "the model predicted X" and "the agent chose X" are
 * two different claims and comparing them means nothing.
 */
function provisionalFormatFromPrior(arms: readonly PredictedArm[], rule: HonestyRule): ShippableFormat {
  const studies = arms.map((a) => a.study);
  const candidates = buildCandidates(toArmMap(studies), rule, null, new Map());
  // `true` for extrapolation: at freeze time no prediction has been tested yet,
  // so there is no evidence against the prior. The provisional call is allowed
  // to reach for the escalated rung; the post-results call may not be.
  const choice = chooseFrom(candidates, rule, true);
  return choice.candidate.format === "halt"
    ? fallbackShippable(candidates, rule)
    : (choice.candidate.format as ShippableFormat);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE — the "after" half, scored against the frozen claims
// ─────────────────────────────────────────────────────────────────────────────

export interface ArmDelta {
  variant: TrustStudy["variant"];
  predicted_trust: number;
  actual_trust: number;
  trust_delta: number;
  trust_within_band: boolean;
  predicted_recognition: number;
  actual_recognition: number;
  recognition_delta: number;
  recognition_within_band: boolean;
  n_predicted: number;
  n_actual: number;
}

export type Wrongness =
  /** Every ordering claim held and every arm landed inside its band. */
  | "model_held"
  /** Orderings held; at least one rate landed outside its pre-registered band. */
  | "off_by_magnitude"
  /** An ordering claim broke. The model was wrong about the SHAPE of the world. */
  | "wrong_about_direction";

export interface FormatComparison {
  deltas: ArmDelta[];
  claims: ClaimResult[];
  wasModelWrong: boolean;
  wrongness: Wrongness;
  /**
   * Whether the agent may still ship a format no human evaluated. False when the
   * model was wrong about direction — a ladder extrapolation is exactly a
   * directional claim, and we just watched a directional claim fail.
   */
  extrapolation_trusted: boolean;
  /** The loud line. Printed at the top of the summary when the model was wrong. */
  headline: string;
  prediction_hash: string | null;
  frozen_at: string | null;
  decision: DecisionEntry;
}

export interface CompareOptions {
  rule?: Partial<HonestyRule>;
  sink?: DecisionSink;
  now?: () => Date;
  decisionId?: string;
  evidenceSource?: EvidenceSource;
}

/**
 * Score the frozen prediction against what the humans actually said.
 *
 * Note what is NOT a decision here: "was the model wrong" is arithmetic against
 * a band and a claim set that were both frozen before the data existed. If we
 * chose the tolerance now, we would choose one that flattered us, so we did not
 * get to choose it now. Saying that plainly is better than dressing arithmetic
 * up as judgement.
 *
 * The decision this function DOES make is the consequential one that follows:
 * **now that we know how reliable our prior was, may we still ship a format no
 * human has evaluated?** That is a real fork with real cost — refusing means the
 * only way out of a failing panel is to stop serving ads.
 */
export function compare(
  predicted: Preregistration | TrustStudy | readonly TrustStudy[],
  actual: TrustStudy | readonly TrustStudy[],
  options: CompareOptions = {},
): FormatComparison {
  const now = options.now ?? ((): Date => new Date());
  const prereg = isPreregistration(predicted) ? predicted : null;
  const rule = resolveRule(options.rule ?? prereg?.rule);

  const predictedArms: PredictedArm[] =
    prereg !== null
      ? prereg.arms
      : toStudyList(predicted as TrustStudy | readonly TrustStudy[]).map((study) => ({
          design: {
            id: study.id,
            variant: study.variant,
            question: study.question,
            n_responses: study.n_responses,
          },
          study,
          band: {
            trust: bandFor(study.trust_rate, study.n_responses, rule.noise_z),
            recognition: bandFor(study.ad_recognition_rate, study.n_responses, rule.noise_z),
          },
          reasoning: "band derived on read — this prediction carried no frozen band",
        }));

  const actualArms = toArmMap(toStudyList(actual));
  const claims = (prereg?.claims ?? defaultClaims(rule)).map((c) => evaluateClaim(c, actualArms));

  const deltas: ArmDelta[] = [];
  for (const arm of predictedArms) {
    const got = actualArms.get(arm.study.variant);
    if (got === undefined) continue;
    const tLo = arm.band.trust[0];
    const tHi = arm.band.trust[1];
    const rLo = arm.band.recognition[0];
    const rHi = arm.band.recognition[1];
    deltas.push({
      variant: arm.study.variant,
      predicted_trust: arm.study.trust_rate,
      actual_trust: got.trust_rate,
      trust_delta: round3(got.trust_rate - arm.study.trust_rate),
      trust_within_band: got.trust_rate >= tLo && got.trust_rate <= tHi,
      predicted_recognition: arm.study.ad_recognition_rate,
      actual_recognition: got.ad_recognition_rate,
      recognition_delta: round3(got.ad_recognition_rate - arm.study.ad_recognition_rate),
      recognition_within_band: got.ad_recognition_rate >= rLo && got.ad_recognition_rate <= rHi,
      n_predicted: arm.study.n_responses,
      n_actual: got.n_responses,
    });
  }

  const brokenClaims = claims.filter((c) => c.held === false);
  const brokenOrdering = brokenClaims.filter((c) => c.claim.right !== null);
  const outOfBand = deltas.filter((d) => !d.trust_within_band || !d.recognition_within_band);

  const wrongness: Wrongness =
    brokenOrdering.length > 0
      ? "wrong_about_direction"
      : brokenClaims.length > 0 || outOfBand.length > 0
        ? "off_by_magnitude"
        : "model_held";
  const wasModelWrong = wrongness !== "model_held";
  const extrapolationTrusted = wrongness !== "wrong_about_direction";

  const headline = buildComparisonHeadline(wrongness, brokenClaims, outOfBand, prereg);

  const sink = options.sink ?? openDecisionLog({ now });
  const decision = appendModelTrustDecision({
    sink,
    now,
    decisionId: options.decisionId ?? "dec_format_model_trust",
    wrongness,
    extrapolationTrusted,
    claims,
    deltas,
    prereg,
    evidenceSource: options.evidenceSource ?? "fixture",
  });

  return {
    deltas,
    claims,
    wasModelWrong,
    wrongness,
    extrapolation_trusted: extrapolationTrusted,
    headline,
    prediction_hash: prereg?.prediction_hash ?? null,
    frozen_at: prereg?.frozen_at ?? null,
    decision,
  };
}

function buildComparisonHeadline(
  wrongness: Wrongness,
  broken: readonly ClaimResult[],
  outOfBand: readonly ArmDelta[],
  prereg: Preregistration | null,
): string {
  const anchor =
    prereg !== null
      ? `Pre-registered ${prereg.frozen_at} (hash ${prereg.prediction_hash.slice(0, 12)}…).`
      : "No frozen pre-registration supplied — bands derived on read, which is weaker.";
  if (wrongness === "model_held") {
    return (
      `THE MODEL HELD. ${anchor} Every pre-registered claim survived contact with ` +
      `real respondents. That is the weaker of the two good outcomes: a prior that ` +
      `was already right did not need humans to correct it.`
    );
  }
  if (wrongness === "off_by_magnitude") {
    const which = outOfBand.map((d) => d.variant).join(", ");
    return (
      `!! THE MODEL WAS WRONG ABOUT MAGNITUDE. ${anchor} ` +
      `${outOfBand.length} arm(s) landed outside their frozen band (${which || "—"})` +
      `${broken.length > 0 ? `, and ${broken.length} threshold claim(s) broke` : ""}. ` +
      `The direction of every ordering held, so the ladder still points the way we thought.`
    );
  }
  const worst = broken[0];
  return (
    `!! THE MODEL WAS WRONG, AND WRONG ABOUT DIRECTION. ${anchor} ` +
    `${broken.length} pre-registered claim(s) broke. First: "${worst?.claim.statement ?? "—"}" — ` +
    `${worst?.detail ?? "—"}. We predicted the shape of human judgement and humans ` +
    `disagreed. Every extrapolation downstream of that prior is now suspect, which is ` +
    `why the agent will not ship a format no human in this panel actually saw.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The candidates the agent chooses between
// ─────────────────────────────────────────────────────────────────────────────

export interface FormatCandidate {
  /** Option id used in the DecisionLog entry. */
  id: string;
  format: DisclosureFormat | "halt";
  /** Did a human panel actually see this? */
  measured: boolean;
  trust: number | null;
  recognition: number | null;
  n: number;
  /** Does the rendered block pass `assertDisclosed()`? */
  admissible: boolean;
  /** Does it clear the honesty rule? */
  eligible: boolean;
  /** Why not, in the rule's own units. */
  failures: string[];
  projected_value_cents: number;
  confusion_rate: number | null;
  verbatims: VerbatimSignal | null;
  /** Evidence ids in the log entry that bear on this candidate. */
  evidence_ids: string[];
  sample_block: string;
  note: string;
}

function toStudyList(input: TrustStudy | readonly TrustStudy[]): TrustStudy[] {
  return Array.isArray(input) ? [...(input as readonly TrustStudy[])] : [input as TrustStudy];
}

/** Largest-n wins when a variant appears twice — more respondents, less noise. */
function toArmMap(studies: readonly TrustStudy[]): Map<TrustStudy["variant"], TrustStudy> {
  const map = new Map<TrustStudy["variant"], TrustStudy>();
  for (const s of studies) {
    if (s === undefined || s === null) continue;
    const prior = map.get(s.variant);
    if (prior === undefined || s.n_responses > prior.n_responses) map.set(s.variant, s);
  }
  return map;
}

/**
 * Build every option on the table.
 *
 * The proposed rung is included ONLY when nothing humans actually saw qualifies.
 * An agent that always lists its own invention alongside the measured options
 * will eventually pick it, and "we invented a format" is not a finding — it is
 * the agent preferring its own imagination to the panel it commissioned.
 */
export function buildCandidates(
  arms: ReadonlyMap<TrustStudy["variant"], TrustStudy>,
  rule: HonestyRule,
  control: TrustStudy | null,
  signals: ReadonlyMap<TrustStudy["variant"], VerbatimSignal>,
): FormatCandidate[] {
  const controlArm = control ?? arms.get("unlabeled") ?? null;
  const candidates: FormatCandidate[] = [];

  for (const variant of MEASURABLE_FORMATS) {
    const arm = arms.get(variant);
    if (arm === undefined) continue;
    const signal = signals.get(variant) ?? null;
    const admissible = isAdmissible(variant);
    const failures = eligibilityFailures({
      format: variant,
      recognition: arm.ad_recognition_rate,
      admissible,
      control: controlArm,
      rule,
      signal,
    });
    candidates.push({
      id: `opt_${variant}`,
      format: variant,
      measured: true,
      trust: arm.trust_rate,
      recognition: arm.ad_recognition_rate,
      n: arm.n_responses,
      admissible,
      eligible: failures.length === 0,
      failures,
      projected_value_cents: projectedValueCents(arm.trust_rate),
      confusion_rate: signal?.confusion_rate ?? null,
      verbatims: signal,
      evidence_ids: [`ev_${variant}_recognition`, `ev_${variant}_trust`, `ev_${variant}_n`],
      sample_block: renderSample(variant),
      note: `measured on n=${arm.n_responses} real respondents (${arm.id})`,
    });
  }

  const nothingMeasuredQualifies = !candidates.some((c) => c.eligible && c.admissible);
  if (nothingMeasuredQualifies) {
    const bestMeasured = bestBy(
      candidates.filter((c) => c.admissible),
      (c) => c.recognition ?? -1,
    );
    const base = bestMeasured?.recognition ?? 0;
    // model_prior, and labelled as such everywhere it surfaces.
    const estimate = Math.min(0.97, base + rule.escalation_recognition_lift);
    // Monotone assumption: more disclosure never buys more trust. So the proposal
    // is assumed no better on trust than the most disclosed thing we measured.
    const mostDisclosed = candidates
      .filter((c) => c.admissible && c.trust !== null)
      .sort((a, b) => ladderIndex(b.format as DisclosureFormat) - ladderIndex(a.format as DisclosureFormat))[0];
    const trustEstimate = mostDisclosed?.trust ?? null;
    const failures: string[] = [];
    if (estimate < rule.recognition_floor) {
      failures.push(
        `estimated recognition ${fmt(estimate)} still short of the floor ${fmt(rule.recognition_floor)} ` +
          `(best measured ${fmt(base)} + assumed lift ${fmt(rule.escalation_recognition_lift)})`,
      );
    }
    candidates.push({
      id: `opt_${PROPOSED_FORMAT}`,
      format: PROPOSED_FORMAT,
      measured: false,
      trust: trustEstimate,
      recognition: estimate,
      n: 0,
      admissible: isAdmissible(PROPOSED_FORMAT),
      eligible: failures.length === 0,
      failures,
      projected_value_cents: projectedValueCents(trustEstimate),
      confusion_rate: null,
      verbatims: null,
      evidence_ids: ["ev_escalation_prior", "ev_propagation_mechanism"],
      sample_block: renderSample(PROPOSED_FORMAT),
      note:
        "NEVER SHOWN TO A HUMAN. Recognition is a model_prior extrapolation from the " +
        "best measured arm; trust is assumed no better than the most disclosed arm.",
    });
  }

  candidates.push({
    id: "opt_halt",
    format: "halt",
    measured: false,
    trust: null,
    recognition: null,
    n: 0,
    admissible: true,
    eligible: true,
    failures: [],
    projected_value_cents: 0,
    confusion_rate: null,
    verbatims: null,
    evidence_ids: ["ev_terac_latency"],
    sample_block: "(nothing is served)",
    note: "Serve no sponsored blocks at all until a stronger format is validated.",
  });

  return candidates;
}

interface EligibilityInput {
  format: DisclosureFormat;
  recognition: number;
  admissible: boolean;
  control: TrustStudy | null;
  rule: HonestyRule;
  signal: VerbatimSignal | null;
}

/**
 * The honesty constraint, in one place, in the rule's own units.
 *
 * Nothing in here looks at revenue. That is not an oversight — a constraint that
 * consults the objective is not a constraint.
 */
export function eligibilityFailures(input: EligibilityInput): string[] {
  const { format, recognition, admissible, control, rule, signal } = input;
  const failures: string[] = [];

  if (!admissible) {
    failures.push(
      `the rendered block does not contain ${DISCLOSURE_TAG}, so assertDisclosed() throws — ` +
        `this format cannot reach a publisher through any code path`,
    );
  }

  // The absolute floor, on the POINT ESTIMATE. "Statistically indistinguishable
  // from the floor" is not clearing the floor: uncertainty is spent on the reader.
  if (recognition < rule.recognition_floor) {
    failures.push(
      `ad recognition ${fmt(recognition)} is below the floor ${fmt(rule.recognition_floor)} ` +
        `(short by ${fmt(rule.recognition_floor - recognition)})`,
    );
  }

  // The lift test, and only where it can mean anything.
  if (control !== null && format !== "unlabeled") {
    if (control.ad_recognition_rate < rule.recognition_floor) {
      const lift = recognition - control.ad_recognition_rate;
      if (lift < rule.lift_floor) {
        failures.push(
          `the label adds only ${fmt(lift)} over the unlabeled control ` +
            `(${fmt(control.ad_recognition_rate)}), below the ${fmt(rule.lift_floor)} we require — ` +
            `recognition at this level is coming from the copy, not from our disclosure`,
        );
      }
    }
  }

  // The one-way verbatim veto.
  if (
    signal !== null &&
    !signal.below_minimum &&
    signal.confusion_rate > rule.confusion_veto
  ) {
    failures.push(
      `${Math.round(signal.confusion_rate * 100)}% of ${signal.n} free-text answers volunteered ` +
        `confusion about it being an ad (veto above ${Math.round(rule.confusion_veto * 100)}%), ` +
        `e.g. "${signal.confusion_quotes[0] ?? ""}" — the tick-box says recognised, the prose says otherwise`,
    );
  }

  return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
// The choice
// ─────────────────────────────────────────────────────────────────────────────

export type ChoiceRoute =
  /** A format humans saw cleared the honesty rule. Revenue picked among them. */
  | "eligible_measured"
  /** Nothing measured cleared it; the agent proposes a stronger, unvalidated rung. */
  | "escalated"
  /** Nothing measured cleared it and escalation is not available or not credible. */
  | "halt";

export interface ChoiceResult {
  candidate: FormatCandidate;
  route: ChoiceRoute;
  reason: string;
  /** Set when the route is halt. */
  halt_reason: "catastrophic" | "escalation_insufficient" | "model_unreliable" | null;
  /** True when a strictly more profitable option was rejected on honesty grounds. */
  honesty_overrode_commerce: boolean;
  commercial_sacrifice_cents: number;
  /** Which option we gave up, and why we could not take it. */
  sacrificed: FormatCandidate | null;
  /** Set when the commercial gap between the top two eligible formats was noise. */
  noise_broke_the_tie: boolean;
}

/**
 * Step 1 filter by honesty, step 2 maximise revenue, step 3 escalate or halt.
 *
 * `extrapolationTrusted === false` means `compare()` caught the model being wrong
 * about direction. In that case the agent refuses to ship its own unvalidated
 * proposal and halts instead. It is the more expensive branch and it is the one
 * a proven-unreliable prior earns: the error should fall on the side of not
 * serving, not on the side of serving something we guessed at.
 */
export function chooseFrom(
  candidates: readonly FormatCandidate[],
  rule: HonestyRule,
  extrapolationTrusted: boolean,
): ChoiceResult {
  const halt = candidates.find((c) => c.format === "halt");
  const haltCandidate: FormatCandidate =
    halt ??
    ({
      id: "opt_halt",
      format: "halt",
      measured: false,
      trust: null,
      recognition: null,
      n: 0,
      admissible: true,
      eligible: true,
      failures: [],
      projected_value_cents: 0,
      confusion_rate: null,
      verbatims: null,
      evidence_ids: [],
      sample_block: "(nothing is served)",
      note: "serve nothing",
    } satisfies FormatCandidate);

  const shippable = candidates.filter((c) => c.format !== "halt");
  const eligibleMeasured = shippable.filter((c) => c.measured && c.eligible && c.admissible);
  const bestOverallByValue = bestBy(shippable, (c) => c.projected_value_cents);

  const sacrificeAgainst = (chosen: FormatCandidate): Pick<
    ChoiceResult,
    "honesty_overrode_commerce" | "commercial_sacrifice_cents" | "sacrificed"
  > => {
    if (
      bestOverallByValue !== null &&
      bestOverallByValue.id !== chosen.id &&
      bestOverallByValue.projected_value_cents > chosen.projected_value_cents
    ) {
      return {
        honesty_overrode_commerce: true,
        commercial_sacrifice_cents:
          bestOverallByValue.projected_value_cents - chosen.projected_value_cents,
        sacrificed: bestOverallByValue,
      };
    }
    return { honesty_overrode_commerce: false, commercial_sacrifice_cents: 0, sacrificed: null };
  };

  if (eligibleMeasured.length > 0) {
    const topValue = bestBy(eligibleMeasured, (c) => c.projected_value_cents);
    // Contenders: everything whose commercial edge over the leader is inside
    // sampling noise. A revenue advantage we cannot distinguish from noise does
    // not get to pick the less disclosed format.
    const contenders = eligibleMeasured.filter((c) => {
      if (topValue === null) return true;
      if (c.id === topValue.id) return true;
      return differenceIsNoise(
        c.trust ?? 0,
        c.n,
        topValue.trust ?? 0,
        topValue.n,
        rule.noise_z,
      );
    });
    // Among statistically tied contenders, the most disclosed wins the tie.
    const winner =
      bestBy(contenders, (c) => (c.recognition ?? 0) * 1000 + ladderIndex(c.format as DisclosureFormat)) ??
      topValue ??
      haltCandidate;
    const noiseBrokeTie = topValue !== null && winner.id !== topValue.id;
    return {
      candidate: winner,
      route: "eligible_measured",
      reason: noiseBrokeTie
        ? `${winner.format} and ${topValue?.format ?? "?"} both clear the honesty rule and their trust ` +
          `rates are inside sampling noise at n=${winner.n}, so the commercial gap is not real and the ` +
          `more disclosed format takes the tie`
        : `${winner.format} clears the honesty rule and is the best of the eligible formats on the ` +
          `commercial proxy`,
      halt_reason: null,
      noise_broke_the_tie: noiseBrokeTie,
      ...sacrificeAgainst(winner),
    };
  }

  // Nothing humans saw is good enough.
  const measuredAdmissible = shippable.filter((c) => c.measured && c.admissible);
  const bestMeasured = bestBy(measuredAdmissible, (c) => c.recognition ?? -1);
  const proposal = shippable.find((c) => !c.measured);

  if (bestMeasured !== null && (bestMeasured.recognition ?? 0) < rule.halt_floor) {
    return {
      candidate: haltCandidate,
      route: "halt",
      reason:
        `the best format a human actually saw reached only ${fmt(bestMeasured.recognition ?? 0)} ` +
        `recognition, below the ${fmt(rule.halt_floor)} catastrophe line. A majority cannot tell it is ` +
        `an ad even with our strongest measured label, so the failure is in the medium and not in the ` +
        `typography — no rearrangement of characters is a credible fix. We stop serving.`,
      halt_reason: "catastrophic",
      noise_broke_the_tie: false,
      ...sacrificeAgainst(haltCandidate),
    };
  }

  if (!extrapolationTrusted) {
    return {
      candidate: haltCandidate,
      route: "halt",
      reason:
        `no measured format clears the honesty rule, and compare() found the model wrong about the ` +
        `DIRECTION of human judgement. Escalating the ladder is itself a directional claim from the ` +
        `same prior that just failed. We will not ship a format no human evaluated on the strength of ` +
        `a prior we have just watched break. Serving stops until a panel validates a stronger format.`,
      halt_reason: "model_unreliable",
      noise_broke_the_tie: false,
      ...sacrificeAgainst(haltCandidate),
    };
  }

  if (proposal !== undefined && proposal.eligible && proposal.admissible) {
    return {
      candidate: proposal,
      route: "escalated",
      reason:
        `no format the panel saw clears the honesty rule — the best measured ` +
        `${bestMeasured?.format ?? "arm"} reached ${fmt(bestMeasured?.recognition ?? 0)} against a floor ` +
        `of ${fmt(rule.recognition_floor)}. We escalate to ${PROPOSED_FORMAT}, which repeats the ` +
        `disclosure inside the entry line so a model cannot lift the anchor text without it. NO HUMAN ` +
        `HAS SEEN THIS FORMAT; its recognition estimate is a model_prior and it is the first thing a ` +
        `second panel should test.`,
      halt_reason: null,
      noise_broke_the_tie: false,
      ...sacrificeAgainst(proposal),
    };
  }

  return {
    candidate: haltCandidate,
    route: "halt",
    reason:
      `no measured format clears the honesty rule and the escalation we can construct does not ` +
      `credibly reach it either (${proposal?.failures[0] ?? "no escalation available"}). Shipping a ` +
      `format we do not believe reaches the floor would be the rule with extra steps. We stop serving.`,
    halt_reason: "escalation_insufficient",
    noise_broke_the_tie: false,
    ...sacrificeAgainst(haltCandidate),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// decideFormat — the agent
// ─────────────────────────────────────────────────────────────────────────────

export interface FormatFlags extends Partial<RunFlags> {
  /** Threshold overrides. Ignored (loudly) when a frozen rule disagrees. */
  rule?: Partial<HonestyRule>;
  /**
   * Permit thresholds to differ from the frozen ones. Recorded in the entry as
   * an admission that the goalposts moved after the results landed.
   */
  allowRuleChange?: boolean;
  prereg?: Preregistration | null;
  /** Read the frozen prediction from disk. Ignored when `prereg` is supplied. */
  preregPath?: string | null;
  /** Supply a comparison, or let `decideFormat` run one against `prereg`. */
  comparison?: FormatComparison | null;
  sink?: DecisionSink;
  /**
   * Provenance of the study numbers. Defaults to `"fixture"` ON PURPOSE: until
   * Terac results actually land we are running on seeded data, and defaulting to
   * `external_api` would launder fixtures as real observations in the audit.
   * The caller has to assert that the numbers are real.
   */
  evidenceSource?: EvidenceSource;
  /** Applied only when `liveServe` is true. Absent means nothing is applied. */
  apply?: (format: ShippableFormat) => void;
  /** Swap the lexicon for a model. See the keyless note in `decideFormat`. */
  classifyVerbatims?: (verbatims: readonly string[]) => VerbatimSignal;
  logger?: (message: string) => void;
  now?: () => Date;
  decisionId?: string;
}

export interface FormatVerdict {
  /** The format we ship. When `halt` is true this is what we WOULD ship. */
  chosen: ShippableFormat;
  /** True when the agent chose to serve no sponsored blocks at all. */
  halt: boolean;
  halt_reason: ChoiceResult["halt_reason"];
  route: ChoiceRoute;
  /** The stamped ledger entry. Always present; memory-only unless a sink is given. */
  decision: DecisionEntry;
  candidates: FormatCandidate[];
  rule: HonestyRule;
  /** True when the rule came from a pre-registration rather than from flags. */
  rule_frozen: boolean;
  /** True when flags tried to move a frozen threshold. */
  rule_change_attempted: boolean;
  honesty_overrode_commerce: boolean;
  commercial_sacrifice_cents: number;
  comparison: FormatComparison | null;
  verbatims: { variant: TrustStudy["variant"]; signal: VerbatimSignal }[];
  executed: boolean;
  /** The rendered bytes the choice implies. Passed `assertDisclosed()`. */
  sample_block: string;
  summary: string;
}

/**
 * Read the panel. Decide the format. Log it.
 *
 * Async because the signature is the contract other modules build against and a
 * later version may fetch results itself; nothing here awaits today, and saying
 * that is better than a fake await.
 */
export async function decideFormat(
  study: TrustStudy | readonly TrustStudy[],
  flags: FormatFlags = {},
): Promise<FormatVerdict> {
  const now = flags.now ?? ((): Date => new Date());
  const log = flags.logger ?? ((m: string): void => console.log(m));
  const sink = flags.sink ?? openDecisionLog({ now });

  // ── The rule. Frozen wins. ────────────────────────────────────────────────
  const prereg =
    flags.prereg ??
    (typeof flags.preregPath === "string" ? readPreregistration(flags.preregPath) : null);
  const requested = resolveRule(flags.rule);
  const frozenRule = prereg?.rule ?? null;
  let rule = requested;
  let ruleFrozen = false;
  let ruleChangeAttempted = false;
  if (frozenRule !== null) {
    const diff = ruleDiff(frozenRule, requested);
    ruleChangeAttempted = diff.length > 0;
    if (ruleChangeAttempted && flags.allowRuleChange !== true) {
      rule = frozenRule;
      ruleFrozen = true;
      log(
        `[adlayer:format] REFUSING a threshold change after results: ${diff.join(", ")} differ from ` +
          `the rule frozen at ${prereg?.frozen_at ?? "?"}. Using the frozen rule. Pass ` +
          `allowRuleChange to override, and it will be written into the ledger.`,
      );
    } else if (ruleChangeAttempted) {
      log(
        `[adlayer:format] threshold CHANGED after results with allowRuleChange: ${diff.join(", ")}. ` +
          `Recorded in the decision entry — a reader should discount this decision accordingly.`,
      );
    } else {
      rule = frozenRule;
      ruleFrozen = true;
    }
  }

  // ── The arms. ─────────────────────────────────────────────────────────────
  const studies = toStudyList(study);
  const arms = toArmMap(studies);
  const control = arms.get("unlabeled") ?? null;

  // ── Verbatims. Keyless degrade lives here, and logs exactly one line. ─────
  const classifier = flags.classifyVerbatims;
  const hasKey =
    typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
    process.env["ANTHROPIC_API_KEY"].trim() !== "";
  if (classifier === undefined && !hasKey) {
    log(
      "[adlayer:format] no ANTHROPIC_API_KEY — free-text verbatims read with the built-in lexicon " +
        "instead of a model. It is crude, so it is wired one-way: it can veto a format, never promote one.",
    );
  }
  const signals = new Map<TrustStudy["variant"], VerbatimSignal>();
  const verbatimList: FormatVerdict["verbatims"] = [];
  for (const [variant, arm] of arms) {
    let signal: VerbatimSignal;
    if (classifier !== undefined) {
      try {
        signal = classifier(arm.verbatims ?? []);
      } catch (err) {
        log(
          `[adlayer:format] verbatim classifier failed (${err instanceof Error ? err.message : String(err)}) ` +
            `— falling back to the lexicon`,
        );
        signal = analyzeVerbatims(arm.verbatims ?? [], rule);
      }
    } else {
      signal = analyzeVerbatims(arm.verbatims ?? [], rule);
    }
    signals.set(variant, signal);
    verbatimList.push({ variant, signal });
  }

  // ── The prediction check, which gates extrapolation. ─────────────────────
  let comparison = flags.comparison ?? null;
  if (comparison === null && prereg !== null) {
    comparison = compare(prereg, studies, {
      rule,
      sink,
      now,
      evidenceSource: flags.evidenceSource ?? "fixture",
    });
  }
  const extrapolationTrusted = comparison?.extrapolation_trusted ?? true;

  // ── The decision. ────────────────────────────────────────────────────────
  const candidates = buildCandidates(arms, rule, control, signals);
  const choice = chooseFrom(candidates, rule, extrapolationTrusted);
  const halt = choice.candidate.format === "halt";
  const chosen: ShippableFormat = halt
    ? fallbackShippable(candidates, rule)
    : (choice.candidate.format as ShippableFormat);

  // The hard invariant, run over the actual bytes, on the way out.
  const sampleBlock = renderSample(chosen);
  assertDisclosed(sampleBlock);

  // ── The side effect, if and only if it was asked for. ────────────────────
  let executed = false;
  let effect: string;
  if (halt) {
    effect =
      `No format is applied. Serving is HALTED (${choice.halt_reason ?? "unspecified"}); ` +
      `projected revenue for the period goes to $0.`;
    if (flags.liveServe === true && flags.apply !== undefined) {
      log("[adlayer:format] HALT — no format applied, and nothing new will be served.");
    }
  } else if (flags.liveServe === true && flags.apply !== undefined) {
    try {
      flags.apply(chosen);
      executed = true;
      effect = `Applied ${chosen} to the renderer. Every block served from now on uses it.`;
    } catch (err) {
      effect =
        `Tried to apply ${chosen} and the apply hook failed: ` +
        `${err instanceof Error ? err.message : String(err)}. The format was NOT changed.`;
      log(`[adlayer:format] apply hook failed — format not changed. ${effect}`);
    }
  } else {
    effect =
      `Dry run: ${chosen} was chosen but not applied. With liveServe and an apply hook this would ` +
      `change the disclosure format on every subsequent placement.`;
  }

  const entry = appendShipDecision({
    sink,
    now,
    decisionId: flags.decisionId ?? "dec_format_ship_final",
    studies,
    arms,
    signals,
    candidates,
    choice,
    extrapolationTrusted,
    chosen,
    rule,
    ruleFrozen,
    ruleChangeAttempted,
    allowedRuleChange: flags.allowRuleChange === true,
    prereg,
    comparison,
    evidenceSource: flags.evidenceSource ?? "fixture",
    executed,
    effect,
  });

  const verdict: FormatVerdict = {
    chosen,
    halt,
    halt_reason: choice.halt_reason,
    route: choice.route,
    decision: entry,
    candidates,
    rule,
    rule_frozen: ruleFrozen,
    rule_change_attempted: ruleChangeAttempted,
    honesty_overrode_commerce: choice.honesty_overrode_commerce,
    commercial_sacrifice_cents: choice.commercial_sacrifice_cents,
    comparison,
    verbatims: verbatimList,
    executed,
    sample_block: sampleBlock,
    summary: "",
  };
  verdict.summary = formatSummary(verdict, choice);
  return verdict;
}

/**
 * When we halt, `chosen` still has to name something — a halt is "serve nothing
 * YET", and the reader needs to know what would go out the day a panel clears
 * it. We name the most disclosed admissible option on the table, because that is
 * the direction a halt points in.
 */
function fallbackShippable(candidates: readonly FormatCandidate[], rule: HonestyRule): ShippableFormat {
  void rule;
  const shippable = candidates
    .filter((c) => c.format !== "halt" && c.format !== "unlabeled" && c.admissible)
    .map((c) => c.format as ShippableFormat);
  if (shippable.length === 0) return PROPOSED_FORMAT;
  return shippable.sort((a, b) => ladderIndex(b) - ladderIndex(a))[0] ?? PROPOSED_FORMAT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger entries
// ─────────────────────────────────────────────────────────────────────────────

const SHIP_DECISION_PREFIX = "dec_format_ship";

function lastShipDecision(sink: DecisionSink): DecisionEntry | null {
  const entries = sink.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e !== undefined && e.agent === "Format" && e.id.startsWith(SHIP_DECISION_PREFIX)) return e;
  }
  return null;
}

/** The format a previous ship entry chose, read back off its option id. */
function chosenFormatOf(entry: DecisionEntry): string {
  return entry.chosen_option_id.replace(/^opt_/, "");
}

function appendProvisionalDecision(
  sink: DecisionSink,
  prereg: Preregistration,
  state: { frozen: boolean; alreadyFrozen: boolean; drift: boolean; path: string | null },
): DecisionEntry {
  const rule = prereg.rule;
  const evidence: DecisionEvidence[] = [
    {
      id: "ev_prediction_hash",
      claim:
        `The model's predicted verdict for all arms, plus the honesty rule, frozen before any human ` +
        `answered. Hash pins the contents.`,
      source: "model_prior",
      ref: state.path ?? prereg.prediction_hash,
      value: prereg.prediction_hash,
      observed_at: prereg.frozen_at,
    },
    {
      id: "ev_terac_latency",
      claim:
        "Terac panel latency is 5-6h (advertised eta 6h, typical 5h 12m) against an 18:45 submission " +
        "lock, so there is exactly one study cycle and no second chance to ask.",
      source: "external_api",
      ref: "docs/TERAC.md",
      value: "5h12m typical",
      observed_at: prereg.frozen_at,
    },
    ...prereg.arms.map(
      (arm): DecisionEvidence => ({
        id: `ev_pred_${arm.study.variant}`,
        claim:
          `Predicted ${arm.study.variant}: recognition ${fmt(arm.study.ad_recognition_rate)} ` +
          `(band ${fmt(arm.band.recognition[0])}–${fmt(arm.band.recognition[1])}), trust ` +
          `${fmt(arm.study.trust_rate)} (band ${fmt(arm.band.trust[0])}–${fmt(arm.band.trust[1])}). ` +
          arm.reasoning,
        source: "model_prior",
        ref: arm.study.id,
        value: arm.study.ad_recognition_rate,
        observed_at: prereg.frozen_at,
      }),
    ),
  ];

  const options: DecisionOption[] = [
    {
      id: `opt_${prereg.provisional_format}`,
      summary: `Commit now to ${prereg.provisional_format} as the fallback if results never land`,
      expected_outcome:
        `If the panel misses the 18:45 lock we still ship a disclosure format the model believes ` +
        `clears ${fmt(rule.recognition_floor)} recognition, and we can say what we would have done ` +
        `before we knew.`,
      supported_by: ["ev_prediction_hash", "ev_terac_latency"],
      projected_value_cents: null,
    },
    {
      id: "opt_wait_for_humans",
      summary: "Commit to nothing until the panel returns",
      expected_outcome:
        `If the panel misses the lock we ship no considered format at all and the "hard decisions" ` +
        `function has no artifact. If it returns in time, this costs nothing.`,
      supported_by: ["ev_terac_latency"],
      projected_value_cents: null,
    },
    {
      id: "opt_no_prediction",
      summary: "Run the study without pre-registering a prediction or a rule",
      expected_outcome:
        `We keep the freedom to pick thresholds after seeing which arm won, and no reader can tell ` +
        `whether the rule was chosen to fit the result. Cheapest now, worthless as evidence later.`,
      supported_by: ["ev_prediction_hash"],
      projected_value_cents: null,
    },
  ];

  const draft: DecisionDraft = {
    id: `${SHIP_DECISION_PREFIX}_provisional`,
    agent: "Format",
    decided_at: prereg.frozen_at,
    question:
      "Before the panel returns: what disclosure format do we commit to, and what rule will decide it?",
    context: "src/company/format.ts → preregister()",
    options,
    chosen_option_id: `opt_${prereg.provisional_format}`,
    rationale:
      `Panel latency is 5-6h against an 18:45 lock, so results may not arrive and there is no second ` +
      `round. Freezing a predicted verdict AND the honesty rule now costs nothing and buys two things: ` +
      `a fallback if the humans are late, and a rule we cannot bend afterwards to select whichever arm ` +
      `turns out to pay best. The prediction is deliberately falsifiable — it says the plain label FAILS ` +
      `the ${fmt(rule.recognition_floor)} floor and that prominence costs trust.`,
    evidence,
    flip_condition:
      `If Terac's feasibility quote had returned an ETA comfortably inside the window with room for a ` +
      `second round, pre-committing would have been unnecessary and we would have waited for real data ` +
      `rather than freezing a prior. The quoted ETA was 6h against 6h30m remaining.`,
    flip_to_option_id: "opt_wait_for_humans",
    reversible: true,
    reversal_path:
      "Superseded by the post-results decision, which is written as a separate entry in this chain. " +
      "The prediction file itself is never rewritten — this module has no code path that overwrites it.",
    executed: state.frozen,
    effect: state.frozen
      ? `Prediction and rule frozen to ${state.path ?? "(memory)"} with flag wx; this module can no ` +
        `longer overwrite them.`
      : state.alreadyFrozen
        ? `A prediction was already frozen${state.drift ? " and the model now predicts something DIFFERENT — the frozen one stands and the drift is on the record" : " and is unchanged"}.`
        : "Dry run: prediction held in memory, nothing written.",
    supersedes: null,
  };

  return sink.append(draft);
}

interface ModelTrustInput {
  sink: DecisionSink;
  now: () => Date;
  decisionId: string;
  wrongness: Wrongness;
  extrapolationTrusted: boolean;
  claims: readonly ClaimResult[];
  deltas: readonly ArmDelta[];
  prereg: Preregistration | null;
  evidenceSource: EvidenceSource;
}

function appendModelTrustDecision(input: ModelTrustInput): DecisionEntry {
  const { sink, now, wrongness, extrapolationTrusted, claims, deltas, prereg } = input;
  const broken = claims.filter((c) => c.held === false);

  const evidence: DecisionEvidence[] = [
    ...deltas.map(
      (d): DecisionEvidence => ({
        id: `ev_delta_${d.variant}`,
        claim:
          `${d.variant}: predicted recognition ${fmt(d.predicted_recognition)} → actual ` +
          `${fmt(d.actual_recognition)} (${signed(d.recognition_delta)}, ` +
          `${d.recognition_within_band ? "inside" : "OUTSIDE"} the frozen band); trust ` +
          `${fmt(d.predicted_trust)} → ${fmt(d.actual_trust)} (${signed(d.trust_delta)}, ` +
          `${d.trust_within_band ? "inside" : "OUTSIDE"} band). n=${d.n_actual}.`,
        source: input.evidenceSource,
        ref: prereg?.prediction_hash ?? null,
        value: d.recognition_delta,
        observed_at: now().toISOString(),
      }),
    ),
    ...claims.map(
      (c): DecisionEvidence => ({
        id: `ev_claim_${c.claim.id}`,
        claim: `${c.claim.statement} → ${c.detail}`,
        source: input.evidenceSource,
        ref: prereg?.prediction_hash ?? null,
        value: c.held,
        observed_at: now().toISOString(),
      }),
    ),
  ];
  if (evidence.length === 0) {
    evidence.push({
      id: "ev_no_overlap",
      claim: "No predicted arm matched an actual arm — there was nothing to score.",
      source: input.evidenceSource,
      ref: prereg?.prediction_hash ?? null,
      value: 0,
      observed_at: now().toISOString(),
    });
  }
  const evidenceIds = evidence.map((e) => e.id);

  const options: DecisionOption[] = [
    {
      id: "opt_trust_model",
      summary: "Keep extrapolation privileges: the agent may ship a format no human evaluated",
      expected_outcome:
        "If no measured arm clears the honesty floor, the agent ships labeled_prominent_isolated. " +
        "Readers get a stronger disclosure than any arm tested, and we carry the risk that our " +
        "estimate of how much stronger is wrong. Revenue continues.",
      supported_by: evidenceIds.slice(0, 3),
      projected_value_cents: null,
    },
    {
      id: "opt_distrust_model",
      summary: "Withdraw extrapolation privileges: only formats humans saw may ship",
      expected_outcome:
        "If no measured arm clears the floor, serving HALTS instead of escalating. No reader sees a " +
        "placement we cannot show a human validated, and the revenue line goes to zero until a second " +
        "panel runs.",
      supported_by: evidenceIds.slice(0, 3),
      projected_value_cents: 0,
    },
    {
      id: "opt_rerun",
      summary: "Run a second panel to validate the escalated format before shipping anything",
      expected_outcome:
        "Results arrive ~5h12m after launch, which is after the 18:45 lock. There is no verdict before " +
        "the deadline, so this option delivers neither a shipped format nor a measured one.",
      supported_by: evidenceIds.slice(0, 1),
      projected_value_cents: 0,
    },
  ];

  const chosenId = extrapolationTrusted ? "opt_trust_model" : "opt_distrust_model";
  const rationale =
    wrongness === "wrong_about_direction"
      ? `The prior was wrong about DIRECTION: ${broken.length} pre-registered ordering or threshold ` +
        `claim(s) broke (first: ${broken[0]?.detail ?? "—"}). Escalating the ladder is itself a ` +
        `directional claim produced by that same prior, so the honest response to watching it fail is ` +
        `to stop extrapolating from it, not to extrapolate more carefully. We would rather serve nothing ` +
        `than serve a format whose only evidence is a model we have just seen be wrong.`
      : wrongness === "off_by_magnitude"
        ? `The prior missed on magnitude — at least one arm landed outside its frozen band — but every ` +
          `ordering claim held, so the ladder still points the way we thought it did. Magnitude error ` +
          `argues for a wider estimate on the escalated rung, not for abandoning the ladder, so ` +
          `extrapolation privileges survive with the error stated on the record.`
        : `Every pre-registered claim held and every arm landed inside its frozen band. That is the ` +
          `weaker of the two good outcomes: the humans confirmed the prior rather than correcting it, ` +
          `so the model keeps extrapolation privileges but the panel taught us less than a miss would have.`;

  const draft: DecisionDraft = {
    id: input.decisionId,
    agent: "Format",
    decided_at: now().toISOString(),
    question:
      "Now that we know how wrong the pre-registered prediction was, may the agent still ship a " +
      "disclosure format that no human in the panel evaluated?",
    context: "src/company/format.ts → compare()",
    options,
    chosen_option_id: chosenId,
    rationale,
    evidence,
    flip_condition:
      wrongness === "wrong_about_direction"
        ? `If the broken ordering claim had held — ${broken[0]?.claim.statement ?? "the directional claim"} ` +
          `(${broken[0]?.detail ?? "—"}) — the prior would have survived contact with humans and ` +
          `extrapolation privileges would have been kept.`
        : `If any pre-registered ORDERING claim had broken (they are listed in the frozen file at hash ` +
          `${prereg?.prediction_hash.slice(0, 12) ?? "—"}…), extrapolation privileges would have been ` +
          `withdrawn and the agent would halt rather than ship an unvalidated format. None did.`,
    flip_to_option_id: extrapolationTrusted ? "opt_distrust_model" : "opt_trust_model",
    reversible: true,
    reversal_path:
      "A later panel that validates the escalated format restores extrapolation privileges; write a " +
      "new entry superseding this one.",
    executed: false,
    effect:
      `${extrapolationTrusted ? "Extrapolation permitted" : "Extrapolation FORBIDDEN"} for the shipping ` +
      `decision that follows in this chain. This entry changes nothing outside the log by itself — it ` +
      `constrains the next entry.`,
    supersedes: null,
  };

  return sink.append(draft);
}

interface ShipDecisionInput {
  sink: DecisionSink;
  now: () => Date;
  decisionId: string;
  studies: readonly TrustStudy[];
  arms: ReadonlyMap<TrustStudy["variant"], TrustStudy>;
  signals: ReadonlyMap<TrustStudy["variant"], VerbatimSignal>;
  candidates: readonly FormatCandidate[];
  choice: ChoiceResult;
  /** Passed through so the mechanism replay re-runs `chooseFrom` with the same third argument. */
  extrapolationTrusted: boolean;
  chosen: ShippableFormat;
  rule: HonestyRule;
  ruleFrozen: boolean;
  ruleChangeAttempted: boolean;
  allowedRuleChange: boolean;
  prereg: Preregistration | null;
  comparison: FormatComparison | null;
  evidenceSource: EvidenceSource;
  executed: boolean;
  effect: string;
}

function appendShipDecision(input: ShipDecisionInput): DecisionEntry {
  const { sink, now, arms, signals, candidates, choice, rule, prereg, comparison } = input;
  const extrapolationTrusted = input.extrapolationTrusted;

  // ── Evidence ──────────────────────────────────────────────────────────────
  const evidence: DecisionEvidence[] = [];
  for (const [variant, arm] of arms) {
    evidence.push({
      id: `ev_${variant}_recognition`,
      claim: `${variant}: ${Math.round(arm.ad_recognition_rate * 100)}% of respondents correctly identified the entry as an ad.`,
      source: input.evidenceSource,
      ref: arm.id,
      value: arm.ad_recognition_rate,
      observed_at: arm.ran_at,
    });
    evidence.push({
      id: `ev_${variant}_trust`,
      claim: `${variant}: ${Math.round(arm.trust_rate * 100)}% said they would still trust the assistant. This is our commercial proxy.`,
      source: input.evidenceSource,
      ref: arm.id,
      value: arm.trust_rate,
      observed_at: arm.ran_at,
    });
    evidence.push({
      id: `ev_${variant}_n`,
      claim: `${variant}: n=${arm.n_responses}, so one respondent moves a rate by ${fmt(arm.n_responses > 0 ? 1 / arm.n_responses : 1)} and the 95% sampling error on recognition is ±${fmt(rule.noise_z * standardError(arm.ad_recognition_rate, arm.n_responses))}.`,
      source: input.evidenceSource,
      ref: arm.id,
      value: arm.n_responses,
      observed_at: arm.ran_at,
    });
    const signal = signals.get(variant);
    if (signal !== undefined && signal.n > 0) {
      evidence.push({
        id: `ev_${variant}_verbatims`,
        claim:
          `${variant}: ${signal.confused} of ${signal.n} free-text answers volunteered confusion about ` +
          `it being an ad (${Math.round(signal.confusion_rate * 100)}%)` +
          `${signal.below_minimum ? " — below the minimum count for the veto to fire" : ""}` +
          `${signal.confusion_quotes[0] !== undefined ? `, e.g. "${signal.confusion_quotes[0]}"` : ""}.`,
        source: input.evidenceSource,
        ref: arm.id,
        value: signal.confusion_rate,
        observed_at: arm.ran_at,
      });
    }
  }
  evidence.push({
    id: "ev_rule",
    claim:
      `Honesty rule in force: recognition floor ${fmt(rule.recognition_floor)}, label lift ` +
      `${fmt(rule.lift_floor)} over an unlabeled control that itself failed the floor, catastrophe line ` +
      `${fmt(rule.halt_floor)}, verbatim confusion veto ${fmt(rule.confusion_veto)}. ` +
      (input.ruleFrozen
        ? `Frozen at ${prereg?.frozen_at ?? "?"} BEFORE any result was seen.`
        : input.ruleChangeAttempted
          ? "CHANGED AFTER RESULTS with allowRuleChange — discount this decision accordingly."
          : "No pre-registration was supplied, so the rule was resolved at decision time. Weaker."),
    source: input.ruleFrozen ? "human_input" : "model_prior",
    ref: prereg?.prediction_hash ?? "src/company/format.ts:DEFAULT_HONESTY_RULE",
    value: rule.recognition_floor,
    observed_at: prereg?.frozen_at ?? null,
  });
  if (candidates.some((c) => !c.measured && c.format !== "halt")) {
    evidence.push({
      id: "ev_escalation_prior",
      claim:
        `Estimated recognition for ${PROPOSED_FORMAT} is the best measured arm plus an assumed lift of ` +
        `${fmt(rule.escalation_recognition_lift)}. NO HUMAN HAS SEEN THIS FORMAT.`,
      source: "model_prior",
      ref: "src/company/format.ts:HonestyRule.escalation_recognition_lift",
      value: rule.escalation_recognition_lift,
      observed_at: null,
    });
    evidence.push({
      id: "ev_propagation_mechanism",
      claim:
        "PropagationState distinguishes surfaced_unlabeled — the model lifts our entry and drops the " +
        "adjacent notice. Adjacency is the failure mode, so the escalated format puts a second marker " +
        "inside the entry line itself rather than making the notice larger.",
      source: "measurement",
      ref: "src/contract.ts:PropagationState",
      value: "surfaced_unlabeled",
      observed_at: null,
    });
  }
  evidence.push({
    id: "ev_terac_latency",
    claim:
      "Terac panel latency is 5-6h against an 18:45 lock: there is no second study before submissions " +
      "close, so 'run another arm' is not an available option today.",
    source: "external_api",
    ref: "docs/TERAC.md",
    value: "5h12m typical",
    observed_at: null,
  });
  if (comparison !== null) {
    evidence.push({
      id: "ev_prediction_error",
      claim: comparison.headline,
      source: input.evidenceSource,
      ref: comparison.prediction_hash,
      value: comparison.wrongness,
      observed_at: comparison.frozen_at,
    });
  }
  const evidenceIds = new Set(evidence.map((e) => e.id));

  // ── Options, ordered MOST PROFITABLE FIRST. ──────────────────────────────
  // Deliberate: the DecisionLog aggregates a position-bias rate over
  // `chose_first_option`. Ordering the options by revenue makes that statistic
  // mean something for this agent — if the Format agent ever takes the first
  // option, commerce won. We would rather that be visible than hide behind an
  // ordering where the metric is uninformative.
  const ordered = [...candidates].sort((a, b) => {
    if (b.projected_value_cents !== a.projected_value_cents) {
      return b.projected_value_cents - a.projected_value_cents;
    }
    return (b.recognition ?? 0) - (a.recognition ?? 0);
  });

  const options: DecisionOption[] = ordered.map((c) => ({
    id: c.id,
    summary: describeCandidate(c),
    expected_outcome: expectedOutcomeFor(c, rule),
    supported_by: c.evidence_ids.filter((id) => evidenceIds.has(id)),
    projected_value_cents: c.projected_value_cents,
  }));

  const chosenOptionId = choice.candidate.id;
  const flip = buildFlip(choice, candidates, rule, comparison);

  // ── Supersession: only when the format actually changed. ─────────────────
  const prior = lastShipDecision(sink);
  const priorFormat = prior === null ? null : chosenFormatOf(prior);
  const supersedes =
    prior !== null && priorFormat !== chosenOptionId.replace(/^opt_/, "") ? prior.id : null;

  const rationale = buildRationale(input, choice);

  const draft: DecisionDraft = {
    id: input.decisionId,
    agent: "Format",
    decided_at: now().toISOString(),
    question:
      "Given what real respondents said, which disclosure format do we ship — and do we ship one at all?",
    context: "src/company/format.ts → decideFormat()",
    options,
    chosen_option_id: chosenOptionId,
    rationale,
    evidence,
    flip_condition: flip.condition,
    flip_to_option_id: flip.toId,
    replay: formatShipReplay(candidates, rule, extrapolationTrusted, chosenOptionId, flip.toId),
    // Applying a format is a config change and reverts instantly. But once a
    // block has been fetched by an answer engine it cannot be recalled, so an
    // EXECUTED format change is not fully reversible and we do not claim it is.
    reversible: !input.executed,
    reversal_path: input.executed
      ? "The renderer flips back in one commit, but blocks already written to publisher llms.txt files " +
        "and already fetched by answer engines cannot be recalled. Anything served under the old format " +
        "stays served under it."
      : "Nothing was applied. Re-run decideFormat with different flags, or with a second panel's results.",
    executed: input.executed,
    effect: input.effect,
    supersedes,
  };

  return sink.append(draft);
}

function describeCandidate(c: FormatCandidate): string {
  if (c.format === "halt") {
    return "Serve nothing — halt placements until a panel validates a stronger format";
  }
  const money = `$${(c.projected_value_cents / 100).toFixed(0)}/mo projected`;
  if (!c.measured) {
    return `Ship ${c.format} (PROPOSED, never shown to a human; est. recognition ${fmt(c.recognition ?? 0)}, ${money})`;
  }
  return `Ship ${c.format} (recognition ${fmt(c.recognition ?? 0)}, trust ${fmt(c.trust ?? 0)}, n=${c.n}, ${money})`;
}

function expectedOutcomeFor(c: FormatCandidate, rule: HonestyRule): string {
  if (c.format === "halt") {
    return (
      "No sponsored block reaches any publisher. Revenue for the period is $0 and AdLayer has no live " +
      "placement to demonstrate, but no reader is shown advertising they cannot identify as advertising."
    );
  }
  if (c.format === "unlabeled") {
    return (
      `Highest retained trust (${fmt(c.trust ?? 0)}) and therefore the highest projected revenue of any ` +
      `option, with only ${Math.round((c.recognition ?? 0) * 100)}% of readers able to tell it is an ad. ` +
      `The rendered block contains no ${DISCLOSURE_TAG}, so assertDisclosed() throws and no code path ` +
      `can serve it. This is the money we are structurally prevented from taking.`
    );
  }
  if (!c.measured) {
    return (
      `Recognition estimated at ${fmt(c.recognition ?? 0)} — above the ${fmt(rule.recognition_floor)} ` +
      `floor, but by extrapolation rather than observation. A second panel either confirms it or shows ` +
      `the agent shipped a format that reads no better than the one it replaced, which is the specific ` +
      `way this option can be wrong.`
    );
  }
  const clears = (c.recognition ?? 0) >= rule.recognition_floor;
  return (
    `${Math.round((c.recognition ?? 0) * 100)}% of readers identify the placement as an ad ` +
    `(${clears ? "clears" : "FAILS"} the ${fmt(rule.recognition_floor)} floor` +
    `${c.failures[0] !== undefined ? `; ${c.failures[0]}` : ""}), ${Math.round((c.trust ?? 0) * 100)}% ` +
    `still trust the assistant, projected $${(c.projected_value_cents / 100).toFixed(0)}/mo.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MECHANISM REPLAY — the auditor runs `chooseFrom`, it does not read about it
//
// Every flip condition this file writes is a sentence of the form "if candidate
// X had cleared the honesty rule / reached the recognition floor, X would have
// shipped". That is a claim about `chooseFrom`, and `chooseFrom` is pure, so the
// claim is testable rather than rhetorical: substitute the stated value, re-run,
// and require the choice to actually move. `formatShipReplay` attaches the
// pointer ONLY when that holds — an unverifiable replay is worse than none.
// ─────────────────────────────────────────────────────────────────────────────

/** Registry key. The DecisionLog re-runs the ship decision by this name. */
export const FORMAT_MECHANISM = "format.chooseFrom";

/** Everything `chooseFrom` reads, as plain JSON. */
export interface FormatChoiceInput {
  candidates: FormatCandidate[];
  rule: HonestyRule;
  extrapolation_trusted: boolean;
}

export function formatMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const input = raw as FormatChoiceInput;
  if (!Array.isArray(input.candidates) || input.rule === undefined) return null;
  try {
    return chooseFrom(input.candidates, input.rule, input.extrapolation_trusted === true).candidate
      .id;
  } catch {
    return null;
  }
}

registerMechanism(FORMAT_MECHANISM, formatMechanism);

/**
 * The flip condition's stated value, substituted into the candidate it names.
 *
 * Two shapes cover every sentence `buildFlip` emits:
 *
 *   a) "if X had cleared the honesty rule / reached the floor" — X becomes
 *      eligible with recognition exactly at `rule.recognition_floor`.
 *   b) "if the CHOSEN format's recognition had fallen below the floor" — used
 *      when the named target already clears the rule, so the only thing that
 *      moves the answer is the chosen format failing it.
 *
 * Each is tried in turn and the first that actually reproduces the named target
 * is kept. Nothing is recorded on the strength of the sentence alone.
 */
export function formatShipReplay(
  candidates: readonly FormatCandidate[],
  rule: HonestyRule,
  extrapolationTrusted: boolean,
  chosenId: string,
  flipToId: string | null,
): DecisionReplay | null {
  const input: FormatChoiceInput = {
    candidates: candidates.map((c) => ({ ...c })),
    rule,
    extrapolation_trusted: extrapolationTrusted,
  };
  if (formatMechanism(input) !== chosenId) return null;
  if (flipToId === null || flipToId === chosenId) return null;

  const clearRule = (c: FormatCandidate): FormatCandidate => ({
    ...c,
    recognition: c.format === "halt" ? c.recognition : Math.max(c.recognition ?? 0, rule.recognition_floor),
    eligible: true,
    admissible: true,
    failures: [],
  });
  const failRule = (c: FormatCandidate): FormatCandidate => ({
    ...c,
    recognition: Math.max(0, rule.recognition_floor - 0.01),
    eligible: false,
    failures: [`ad recognition fell below the floor ${rule.recognition_floor}`],
  });

  const attempts: FormatChoiceInput[] = [
    { ...input, candidates: input.candidates.map((c) => (c.id === flipToId ? clearRule(c) : c)) },
    {
      ...input,
      candidates: input.candidates.map((c) =>
        c.id === flipToId ? clearRule(c) : c.id === chosenId ? failRule(c) : c,
      ),
    },
    { ...input, candidates: input.candidates.map((c) => (c.id === chosenId ? failRule(c) : c)) },
  ];

  for (const attempt of attempts) {
    if (formatMechanism(attempt) === flipToId) {
      return { fn: FORMAT_MECHANISM, input, flip_input: attempt };
    }
  }
  return null;
}

function buildFlip(
  choice: ChoiceResult,
  candidates: readonly FormatCandidate[],
  rule: HonestyRule,
  comparison: FormatComparison | null,
): { condition: string; toId: string | null } {
  const chosen = choice.candidate;
  const others = candidates.filter((c) => c.id !== chosen.id);
  if (others.length === 0) return { condition: "", toId: null };

  const pickFallback = (): FormatCandidate =>
    bestBy(others, (c) => c.projected_value_cents) ?? (others[0] as FormatCandidate);

  if (choice.route === "eligible_measured") {
    // Case 1: a more profitable format ALSO cleared the honesty rule and lost
    // only because its commercial edge was inside sampling error. The falsifier
    // is then a statement about n, and it is the sharpest one in this file.
    if (choice.noise_broke_the_tie) {
      const richer = others
        .filter((c) => c.eligible && c.admissible && c.format !== "halt")
        .sort((a, b) => b.projected_value_cents - a.projected_value_cents)[0];
      if (richer !== undefined) {
        const gap = Math.abs((richer.trust ?? 0) - (chosen.trust ?? 0));
        const need =
          rule.noise_z *
          Math.sqrt(
            standardError(richer.trust ?? 0, richer.n) ** 2 +
              standardError(chosen.trust ?? 0, chosen.n) ** 2,
          );
        return {
          condition:
            `If the trust gap between ${richer.format} and ${chosen.format} had been real rather than ` +
            `noise — it measured ${fmt(gap)} against a 95% sampling threshold of ${fmt(need)} at ` +
            `n=${richer.n}/${chosen.n} — the commercial advantage would have counted and ` +
            `${richer.format} would have shipped. A panel roughly ` +
            `${Math.max(2, Math.ceil((need / Math.max(gap, 0.001)) ** 2))}× larger would settle it.`,
          toId: richer.id,
        };
      }
    }
    // Case 2: the interesting counterfactual is the option that was more
    // profitable but failed the honesty rule.
    const richer = others
      .filter((c) => c.projected_value_cents > chosen.projected_value_cents && c.format !== "halt")
      .sort((a, b) => b.projected_value_cents - a.projected_value_cents)[0];
    if (richer !== undefined) {
      if (!richer.admissible) {
        // The only richer option is structurally unservable, so the honest
        // counterfactual is the next admissible one.
        const next = others
          .filter((c) => c.admissible && c.format !== "halt" && c.id !== chosen.id)
          .sort((a, b) => b.projected_value_cents - a.projected_value_cents)[0];
        if (next !== undefined && next.id !== chosen.id) {
          return {
            condition:
              `If ${next.format}'s ad recognition had reached ${fmt(rule.recognition_floor)} — it ` +
              `measured ${fmt(next.recognition ?? 0)}, short by ${fmt(rule.recognition_floor - (next.recognition ?? 0))}, ` +
              `about ${Math.max(1, Math.round((rule.recognition_floor - (next.recognition ?? 0)) * next.n))} ` +
              `respondents out of ${next.n} — it would clear the honesty rule and beat the chosen format ` +
              `on the commercial proxy (${fmt(next.trust ?? 0)} vs ${fmt(chosen.trust ?? 0)} trust).`,
            toId: next.id,
          };
        }
      }
      return {
        condition:
          `If ${richer.format} had cleared the honesty rule — it fails on: ` +
          `${richer.failures[0] ?? "an unstated check"} — it would have been chosen, because it projects ` +
          `$${((richer.projected_value_cents - chosen.projected_value_cents) / 100).toFixed(0)}/mo more.`,
        toId: richer.id,
      };
    }
    const halt = others.find((c) => c.format === "halt");
    return {
      condition:
        `If the chosen format's recognition had fallen below ${fmt(rule.recognition_floor)} — it measured ` +
        `${fmt(chosen.recognition ?? 0)}, ${fmt((chosen.recognition ?? 0) - rule.recognition_floor)} above ` +
        `the floor — nothing measured would clear the honesty rule and the agent would escalate or halt.`,
      toId: (halt ?? pickFallback()).id,
    };
  }

  if (choice.route === "escalated") {
    const bestMeasured = bestBy(
      others.filter((c) => c.measured && c.admissible),
      (c) => c.recognition ?? -1,
    );
    if (bestMeasured !== undefined && bestMeasured !== null) {
      return {
        condition:
          `If ${bestMeasured.format} had reached ${fmt(rule.recognition_floor)} recognition — it measured ` +
          `${fmt(bestMeasured.recognition ?? 0)}, short by ` +
          `${fmt(rule.recognition_floor - (bestMeasured.recognition ?? 0))} — the agent would have shipped ` +
          `a format humans actually saw and would not have invented one.`,
        toId: bestMeasured.id,
      };
    }
    return { condition: `If any measured arm had cleared ${fmt(rule.recognition_floor)}.`, toId: pickFallback().id };
  }

  // halt
  if (choice.halt_reason === "model_unreliable") {
    const proposal = others.find((c) => !c.measured && c.format !== "halt");
    return {
      condition:
        `If the pre-registered ordering claims had survived — ${comparison?.claims.find((c) => c.held === false)?.detail ?? "they did not"} — ` +
        `the model would still be trusted to extrapolate and the agent would have escalated to ` +
        `${PROPOSED_FORMAT} rather than stopping the revenue line.`,
      toId: (proposal ?? pickFallback()).id,
    };
  }
  const bestMeasured = bestBy(
    others.filter((c) => c.measured && c.admissible),
    (c) => c.recognition ?? -1,
  );
  const target = others.find((c) => !c.measured && c.format !== "halt") ?? bestMeasured ?? pickFallback();
  return {
    condition:
      `If the best measured format had reached ${fmt(rule.recognition_floor)} recognition (or at least ` +
      `${fmt(rule.recognition_floor - rule.escalation_recognition_lift)}, close enough for the escalated ` +
      `rung to credibly close the gap) — it measured ${fmt(bestMeasured?.recognition ?? 0)} — the agent ` +
      `would have shipped a format instead of stopping placements entirely.`,
    toId: target.id,
  };
}

function buildRationale(input: ShipDecisionInput, choice: ChoiceResult): string {
  const parts: string[] = [];
  parts.push(
    "Honesty is a constraint here, not a term in a score: a format below the recognition floor is " +
      "ineligible at any price, and there is no coefficient anywhere in this agent that trades " +
      "recognition against revenue.",
  );
  parts.push(choice.reason);
  if (choice.honesty_overrode_commerce && choice.sacrificed !== null) {
    parts.push(
      `The most profitable option on the table was ${choice.sacrificed.format} at ` +
        `$${(choice.sacrificed.projected_value_cents / 100).toFixed(0)}/mo` +
        `${choice.sacrificed.admissible ? "" : ` (which no code path can serve — it carries no ${DISCLOSURE_TAG})`}` +
        `. We chose against it and gave up ` +
        `$${(choice.commercial_sacrifice_cents / 100).toFixed(0)}/mo of projected revenue. That number is ` +
        `the price of the honesty rule and it is written into this entry so it cannot be described later ` +
        `as costless.`,
    );
  }
  if (choice.noise_broke_the_tie) {
    parts.push(
      "The commercial gap between the top two eligible formats was inside sampling error, so it does not " +
        "count and the more disclosed format took the tie. Uncertainty is spent on the reader, not on us.",
    );
  }
  if (input.ruleFrozen) {
    parts.push(
      `The thresholds used were frozen at ${input.prereg?.frozen_at ?? "?"}, before any result existed, ` +
        `so they cannot have been chosen to select this outcome.`,
    );
  }
  if (input.ruleChangeAttempted) {
    parts.push(
      input.allowedRuleChange
        ? "A THRESHOLD WAS CHANGED AFTER THE RESULTS LANDED with allowRuleChange. A reader should treat " +
          "this decision as substantially weaker evidence than one made under the frozen rule."
        : "Flags asked for different thresholds than the frozen ones; the request was refused and the " +
          "frozen rule was used.",
    );
  }
  if (input.comparison !== null && input.comparison.wasModelWrong) {
    parts.push(input.comparison.headline);
  }
  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// The summary a judge reads
// ─────────────────────────────────────────────────────────────────────────────

export function formatSummary(verdict: FormatVerdict, choice?: ChoiceResult): string {
  const out: string[] = [];
  const rule = "─".repeat(78);
  out.push("ADLAYER — FORMAT AGENT");
  out.push(rule);

  // Loudest thing first when we were wrong. That is the requirement and it is
  // also the right editorial call: a prediction that survived is a smaller story
  // than a prediction humans killed.
  if (verdict.comparison !== null) {
    out.push(wrap(verdict.comparison.headline, 78));
    out.push("");
    out.push("  PRE-REGISTERED PREDICTION vs REAL HUMANS");
    for (const d of verdict.comparison.deltas) {
      out.push(
        `    ${d.variant.padEnd(18)} recognition ${fmt(d.predicted_recognition)} → ${fmt(d.actual_recognition)} ` +
          `(${signed(d.recognition_delta)}${d.recognition_within_band ? "" : " OUT OF BAND"})  ` +
          `trust ${fmt(d.predicted_trust)} → ${fmt(d.actual_trust)} ` +
          `(${signed(d.trust_delta)}${d.trust_within_band ? "" : " OUT OF BAND"})`,
      );
    }
    for (const c of verdict.comparison.claims) {
      const mark = c.held === false ? "BROKE " : c.held === null ? "n/a   " : "held  ";
      out.push(`    [${mark}] ${c.claim.statement}`);
      if (c.held === false) out.push(`             ${c.detail}`);
    }
    out.push("");
  }

  out.push(
    verdict.halt
      ? `DECISION: HALT — serve no sponsored blocks (${verdict.halt_reason ?? "unspecified"}).`
      : `DECISION: ship ${verdict.chosen}${verdict.route === "escalated" ? "  (ESCALATED — no human in this panel saw this format)" : ""}`,
  );
  out.push(
    `  route ${verdict.route} · rule ${verdict.rule_frozen ? "FROZEN before results" : "resolved at decision time"}` +
      `${verdict.rule_change_attempted ? " · A THRESHOLD CHANGE WAS ATTEMPTED AFTER RESULTS" : ""}` +
      ` · ${verdict.executed ? "EXECUTED" : "dry run"}`,
  );
  out.push("");

  out.push("THE CONFLICT, AND WHICH SIDE WON");
  for (const c of verdict.candidates) {
    const mark = c.id === verdict.decision.chosen_option_id ? "→" : " ";
    const money = `$${(c.projected_value_cents / 100).toFixed(0)}/mo`;
    const rates =
      c.format === "halt"
        ? "no placements"
        : `recog ${fmt(c.recognition ?? 0)} · trust ${fmt(c.trust ?? 0)}${c.measured ? ` · n=${c.n}` : " · ESTIMATED"}`;
    out.push(`  ${mark} ${String(c.format).padEnd(28)} ${rates.padEnd(46)} ${money.padStart(10)}`);
    for (const f of c.failures) out.push(`      ineligible: ${f}`);
    // A candidate that cleared the honesty rule and STILL was not taken needs an
    // explanation, or the table reads as if the agent ignored its own answer.
    if (c.eligible && c.admissible && c.id !== verdict.decision.chosen_option_id && c.format !== "halt") {
      if (!c.measured && verdict.halt_reason === "model_unreliable") {
        out.push(
          "      blocked: the pre-registered prediction was wrong about direction, so the agent " +
            "may not ship a format no human evaluated on the strength of that prior",
        );
      } else if (verdict.route === "eligible_measured" && c.measured) {
        const richer = c.projected_value_cents > chosenValue(verdict);
        out.push(
          richer && choice?.noise_broke_the_tie === true
            ? `      not chosen: also clears the honesty rule and projects more revenue, but the gap ` +
              `was inside sampling error, so it does not count`
            : richer
              ? `      not chosen: clears the honesty rule and projects more revenue — see the falsifier below`
              : `      not chosen: clears the honesty rule but projects less revenue than ${verdict.chosen}`,
        );
      }
    }
  }
  out.push("");
  if (verdict.honesty_overrode_commerce) {
    out.push(
      `  HONESTY BEAT COMMERCIAL INTEREST. We gave up ` +
        `$${(verdict.commercial_sacrifice_cents / 100).toFixed(0)}/mo of projected revenue` +
        `${choice?.sacrificed !== undefined && choice.sacrificed !== null ? ` by refusing ${choice.sacrificed.format}` : ""}. ` +
        `That is the price of the rule, stated as a number.`,
    );
  } else {
    out.push(
      "  The chosen format was also the most profitable option available. Honesty and commerce did not " +
        "conflict here, so this decision is NOT evidence that the priority holds — look for a run where " +
        "they did.",
    );
  }
  out.push("");

  out.push("WHAT WOULD HAVE CHANGED THIS ANSWER");
  out.push(`  ${wrap(verdict.decision.flip_condition, 74, "  ")}`);
  out.push("");

  out.push("WHAT THIS DOES NOT SHOW");
  if (verdict.halt) {
    out.push(
      `  · Serving is stopped, not cancelled. ${verdict.chosen} is what would go out the day a panel ` +
        "clears it; nothing ships until then.",
    );
  }
  out.push("  · Click-through is unmeasured. 'Commercial interest' is proxied by retained trust.");
  out.push(
    `  · The recognition floor (${verdict.rule.recognition_floor}) is our number, not a statute. Rerun with ` +
      "a different floor to see how load-bearing it is.",
  );
  if (verdict.route === "escalated") {
    out.push(
      "  · The format being shipped was NEVER SHOWN TO A HUMAN. Its recognition figure is an " +
        "extrapolation and the first thing a second panel should test.",
    );
  }
  const lexicon = verdict.verbatims.some((v) => v.signal.source === "lexicon");
  if (lexicon) {
    out.push(
      "  · Verbatims were read by a keyword lexicon, not a model. It can only veto a format, never " +
        "promote one.",
    );
  }
  if (verdict.comparison === null) {
    out.push(
      "  · No pre-registered prediction was supplied, so nothing here shows the rule predated the result.",
    );
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function chosenValue(verdict: FormatVerdict): number {
  return (
    verdict.candidates.find((c) => c.id === verdict.decision.chosen_option_id)
      ?.projected_value_cents ?? 0
  );
}

function isPreregistration(value: unknown): value is Preregistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v["prediction_hash"] === "string" && Array.isArray(v["arms"]);
}

function bestBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function fmt(x: number): string {
  return (Math.round(x * 1000) / 1000).toFixed(3);
}

function signed(x: number): string {
  return `${x >= 0 ? "+" : ""}${fmt(x)}`;
}

function wrap(text: string, width: number, indent = ""): string {
  const words = String(text ?? "").split(/\s+/).filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join(`\n${indent}`);
}
