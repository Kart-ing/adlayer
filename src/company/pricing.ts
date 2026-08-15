/**
 * ADLAYER — the PRICING agent.
 *
 * This is the agent that handles money. It answers exactly one question, and it
 * answers it for real: **what do we charge this advertiser for this slot on this
 * publisher, and is the deal worth doing at all?**
 *
 * ── WHY THIS IS AN AGENT AND NOT A FORMATTER ─────────────────────────────────
 *
 * The bar set for this file: if you deleted the agent and hardcoded its output,
 * nothing observable should change — and if that is true, it is decoration.
 * Delete this and hardcode "$20", and here is what changes, observably:
 *
 *   · We sell below cost. A publisher on an 85% revenue share leaves us $3.00
 *     gross on a $20 placement, of which Stripe takes $0.88. `floorFor()`
 *     computes the price at which a placement is worth processing FOR THAT
 *     PUBLISHER, and it refuses beneath it. A publisher demanding a share above
 *     our gross margin makes the floor infinite and every price a loss — the
 *     agent declines at any number.
 *   · We undercharge the desperate and overcharge the healthy. A prospect
 *     invisible across 30 measured queries has a problem we can prove and will
 *     pay multiples of one who already surfaces everywhere. Same $20 for both is
 *     money left on one table and a lost sale on the other.
 *   · We ignore the shelf. The fifth advertiser on a publisher is buying scarcer
 *     attention than the first, and the sixth is DILUTING the five who already
 *     paid. Occupancy moves the price, and past capacity it moves the FLOOR.
 *   · We quote five-figure numbers with nobody looking. Above
 *     `AUTONOMY_LIMIT_CENTS` the agent stops and hands the number to a human
 *     rather than emitting a binding quote it was not trusted to make.
 *
 * ── THE TRADEOFF IS GENUINE, AND THE AGENT CAN BE WRONG ──────────────────────
 *
 * Price too high and the prospect walks — we get nothing. Price too low and the
 * sale closes but we leave money on the table AND we enter a cheap comparable
 * into our own book that caps what the next advertiser on that publisher pays.
 * There is no safe direction. The agent resolves it by maximising EXPECTED NET
 * CONTRIBUTION — close probability times what actually reaches AdLayer after the
 * publisher's share and Stripe's fee — across a small set of named strategies:
 *
 *     hold_floor · market · premium · escalate · refuse
 *
 * It is genuinely uncertain which wins. On an empty shelf with a mid-sized
 * prospect, `market` wins. On a shelf at capacity where the dilution floor has
 * risen to meet the buyer's ceiling, `hold_floor` wins. Against a stated budget
 * beneath the floor, `refuse` wins. Those are three different choices from one
 * function, which is what `summarize()`'s distinct-choices check is looking for.
 *
 * **Where it can be wrong, stated plainly:** the close-probability curve is a
 * MODEL PRIOR, not a measurement, until real closes and rejections exist. The
 * agent logs it as `model_prior` evidence — which is the source `auditEntry()`
 * treats as weak — and it calibrates against observed outcomes the moment any
 * are passed in via `options.outcomes`. Until then, a miscalibrated curve is the
 * most likely reason this agent loses a sale, and the log says so rather than
 * hiding it. That is the honest account of the failure mode, and it is the one
 * we put in the writeup.
 *
 * ── REFUSING REVENUE ─────────────────────────────────────────────────────────
 *
 * There are three ways this agent declines money, and each is a different fact:
 *
 *   1. `refused_below_floor` — the most this buyer will pay is less than the
 *      least this placement is worth processing for. We do not discount into a
 *      loss to book a transaction.
 *   2. `refused_unprofitable_publisher` — the publisher's revenue share exceeds
 *      our gross margin. No price exists. This is a supply-side refusal and the
 *      right fix is renegotiating the share, which the log states.
 *   3. `escalated_to_human` — the price is defensible but larger than this agent
 *      is authorised to commit. It emits a PROPOSAL, not a quote, and names the
 *      Human as the approver. An agent with no spending limit is not trusted,
 *      it is unsupervised.
 *
 * ── WHAT THIS AGENT DOES NOT DO ──────────────────────────────────────────────
 *
 * It does not call Stripe. Payment execution is a Payment Link owned by the
 * other workstream. This agent decides the number and emits
 * `paymentLinkRequest()` — amount, currency, description, metadata — and stops
 * there. One decision-maker, one executor.
 *
 * ── SAFETY POSTURE ───────────────────────────────────────────────────────────
 *
 * · Dry run by default. `RunFlags.liveServe` is the closest flag in the shared
 *   contract to "this quote binds", because the advertiser is paying for a block
 *   that goes live; a price only has an effect when the placement does. We did
 *   NOT add a flag to `src/contract.ts` — that file is shared law and another
 *   workstream builds against it. With `liveServe: false` the decision is logged
 *   with `executed: false` and the effect describes what would have happened.
 * · Keyless. The optional demand lookup degrades to the built-in prior with ONE
 *   log line and never throws. The degradation is VISIBLE in the output: the
 *   demand evidence is recorded as `model_prior` instead of `external_api`,
 *   which raises the weak-evidence rate that `summarize()` prints against us.
 * · **No unlogged prices.** If the decision log refuses the draft, `price()`
 *   throws rather than returning a number. A price whose reasoning was not
 *   recorded is exactly the theatre this whole directory exists to prevent.
 * · Zero runtime dependencies. Node stdlib and global `fetch`.
 */

import type { Publisher, RunFlags } from "../contract.ts";
import {
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
// Inputs
//
// `InvisibilityScore` is declared here rather than imported from
// `engine/retrieve/types.ts` on purpose: that module belongs to the retrieval
// workstream and this one is being written in parallel. The shape is IDENTICAL,
// so an engine `Score` is structurally assignable with no import and no
// coupling. If the engine's shape ever changes, this file keeps compiling and
// the mismatch surfaces at the call site, which is where it belongs.
// ─────────────────────────────────────────────────────────────────────────────

export interface InvisibilityScore {
  /** 0..1 — share of measured queries where the prospect was cited. LOW IS PAIN. */
  visibility: number;
  cited_queries: number;
  /** Sample size. A visibility of 0 over 2 queries is not the same fact as over 30. */
  total_queries: number;
}

/**
 * Rough size band. Drives willingness to pay when nothing better is known.
 *
 * This is deliberately NOT measured — we do not have revenue data on a prospect
 * and pretending otherwise would be the fake number in this file. When it is
 * absent the agent uses `1.0` and records the fact as `model_prior` evidence,
 * which is the source that pushes the entry toward "weak" in the audit. The log
 * telling you the price rested on a guess is the point.
 */
export type ProspectSize = "solo" | "smb" | "midmarket" | "enterprise";

export interface PricingProspect {
  id: string;
  name: string;
  domain: string;
  /** Extracted at intake. Intersected with the publisher's for targeting. */
  categories: string[];
  /** What a human heard them say they'd spend. `null` when nobody asked. */
  stated_budget_cents?: number | null;
  size?: ProspectSize | null;
}

/**
 * A placement already live on this publisher. Only the two fields pricing needs.
 * `Placement` from the shared contract is structurally assignable.
 */
export interface ShelfPlacement {
  publisher_id: string;
  price_cents: number;
}

/** A price we already quoted and the answer we got. This is what calibrates. */
export interface ObservedOutcome {
  price_cents: number;
  closed: boolean;
  /** Something a reader can resolve — a Stripe ref, a placement id. */
  ref?: string | null;
  observed_at?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Priors and hard limits
//
// Exported so tests, the dashboard and the writeup all read the same numbers
// instead of three copies drifting apart.
// ─────────────────────────────────────────────────────────────────────────────

/** PRD §9: "$20. We need a transaction, not margin." That is the anchor, not the answer. */
export const BASE_PLACEMENT_CENTS = 2000;

/**
 * Never quote below this regardless of what the arithmetic says. A $1 placement
 * does not lose us meaningful money; it destroys the price signal for every
 * later placement on the network, which is worth more than the dollar.
 */
export const HARD_FLOOR_CENTS = 500;

/** Stripe standard pricing. Real numbers, because the floor is derived from them. */
export const STRIPE_PCT = 0.029;
export const STRIPE_FIXED_CENTS = 30;

/** Minimum that must reach AdLayer after the publisher's share and Stripe's cut. */
export const MIN_NET_CENTS = 300;

/**
 * A floor above this is not a price, it is a broken supply deal. One entry in
 * one publisher's llms.txt is not worth five figures, so when the revenue share
 * pushes break-even past here the honest report is "no price exists".
 */
export const NO_VIABLE_PRICE_ABOVE_CENTS = 1_000_000;

/**
 * A Sponsored section with more than this many entries stops being a shelf and
 * becomes a directory, which is the point at which models stop distinguishing
 * entries and every advertiser on it gets less than they paid for.
 */
export const MAX_SLOTS_PER_PUBLISHER = 5;

/**
 * The largest quote this agent may issue on its own. Above it, a human signs.
 * Every sales organisation has this number; an agent without one is not
 * autonomous, it is unsupervised.
 */
export const AUTONOMY_LIMIT_CENTS = 15000;

/** Steepness of the close-probability logistic. At ask = WTP, P(close) = 0.5. */
export const CLOSE_STEEPNESS = 6;

/** How far above estimated willingness-to-pay we will still ASK. */
export const CEILING_OVER_WTP = 1.25;

/** Queries needed before a visibility number is treated as fully load-bearing. */
export const MIN_QUERIES_FOR_CONFIDENCE = 20;

/** Range of the pain multiplier is [1, 1 + PAIN_WEIGHT]. */
export const PAIN_WEIGHT = 1.0;

/**
 * Category demand. A PRIOR — stated as one, overridable by `options.demandFn`,
 * and logged with source `model_prior` whenever the prior is what was used.
 */
export const CATEGORY_DEMAND: Readonly<Record<string, number>> = {
  fintech: 1.8,
  legal: 1.7,
  saas: 1.6,
  b2b_software: 1.6,
  healthcare: 1.5,
  dentistry: 1.5,
  insurance: 1.5,
  real_estate: 1.3,
  ecommerce: 1.1,
  home_services: 1.0,
  travel: 1.0,
  education: 0.8,
  nonprofit: 0.6,
};

export const DEFAULT_CATEGORY_DEMAND = 1.0;

/**
 * Applied when the prospect's categories and the publisher's do not intersect.
 * A fintech ad in a gardening llms.txt is the thing that makes ad networks
 * worthless to read, so it is priced as the low-value inventory it is.
 */
export const OFF_TARGET_MULTIPLIER = 0.5;

export const SIZE_MULTIPLIER: Readonly<Record<ProspectSize, number>> = {
  solo: 0.6,
  smb: 1.5,
  midmarket: 2.5,
  enterprise: 4.0,
};

/** Used when size is unknown. Recorded as a prior, not as a fact. */
export const UNKNOWN_SIZE_MULTIPLIER = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// The pure pricing core
//
// Everything below this line up to `price()` is a pure function of numbers. No
// clock, no network, no log. That matters for two reasons: it is exhaustively
// testable, and the FLIP SEARCH re-runs it a few hundred times with one input
// perturbed to derive — not to assert — what would have changed the answer.
// ─────────────────────────────────────────────────────────────────────────────

export type PricingStrategy =
  /** Quote the lowest price the placement is worth processing for. */
  | "hold_floor"
  /** Quote the model price: floor plus market position across the band. */
  | "market"
  /** Quote the buyer's ceiling. Low close probability, high comparable if it lands. */
  | "premium"
  /** Defensible price, above this agent's authority. Propose it; a human signs. */
  | "escalate"
  /**
   * Take the buyer's number even though it is beneath the floor. NEVER
   * SELECTABLE — it exists so that the option the agent refuses is on the
   * record, priced and costed, next to the refusal. An entry that logs only
   * "refuse" is graded a rubber stamp by our own auditor, and it deserves to
   * be: a refusal with nothing to refuse is not a decision.
   */
  | "sell_below_floor"
  /** Decline the deal. */
  | "refuse";

/**
 * Strategies the agent is permitted to choose. `sell_below_floor` is absent by
 * construction — the floor is a hard constraint on the choice set, not a term
 * in the objective function that a large enough close probability can outvote.
 * This is the line that makes "the agent can refuse to sell below the floor" a
 * structural fact rather than a hope about the arithmetic.
 */
export const SELECTABLE_STRATEGIES: readonly PricingStrategy[] = [
  "hold_floor",
  "market",
  "premium",
  "escalate",
  "refuse",
] as const;

export type PricingOutcome =
  | "sell"
  | "escalated_to_human"
  | "refused_below_floor"
  | "refused_unprofitable_publisher";

/** One priced strategy, fully costed. These become the `DecisionOption`s. */
export interface PricingCandidate {
  strategy: PricingStrategy;
  /** `null` for `refuse`. */
  price_cents: number | null;
  close_probability: number;
  net_to_adlayer_cents: number;
  publisher_share_cents: number;
  stripe_fee_cents: number;
  expected_net_cents: number;
  /** Why this candidate is on the table at all. */
  note: string;
}

/** Fully resolved numeric inputs. Perturbing one field is how the flip is found. */
export interface QuoteInput {
  base_cents: number;
  visibility: number;
  total_queries: number;
  size_multiplier: number;
  stated_budget_cents: number | null;
  demand_multiplier: number;
  off_target: boolean;
  rev_share: number;
  slots_used: number;
  slots_total: number;
  /** Highest price already paid on this shelf. Sets the dilution floor at capacity. */
  incumbent_max_cents: number | null;
  /** Blended from observed outcomes when any exist. 1.0 means "prior only". */
  wtp_calibration: number;
}

export interface PriceQuote {
  outcome: PricingOutcome;
  strategy: PricingStrategy;
  /** The number to charge. `null` whenever we are not selling today. */
  price_cents: number | null;
  /** Set on `escalated_to_human`: the price a human is being asked to approve. */
  proposed_price_cents: number | null;

  /** Least this placement may be sold for. `Infinity` when no price works. */
  floor_cents: number;
  /** Most this buyer will plausibly be asked. */
  ceiling_cents: number;
  /** Estimated willingness to pay. The centre of the close-probability curve. */
  wtp_cents: number;

  pain_multiplier: number;
  confidence: number;
  demand_multiplier: number;
  scarcity_multiplier: number;
  size_multiplier: number;
  /** Where in the [floor, ceiling] band the market price sits. 0..1. */
  market_position: number;

  slots_used: number;
  slots_total: number;
  occupancy: number;
  at_capacity: boolean;
  off_target: boolean;

  net_to_adlayer_cents: number;
  publisher_share_cents: number;
  stripe_fee_cents: number;
  close_probability: number;
  expected_net_cents: number;

  candidates: PricingCandidate[];
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Coerce anything to a finite number. Garbage in must not become NaN out. */
function finite(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Stripe's cut on a charge of `cents`. */
export function stripeFee(cents: number): number {
  return Math.round(cents * STRIPE_PCT) + STRIPE_FIXED_CENTS;
}

/** What actually reaches AdLayer. This — not the sticker price — is the money. */
export function netToAdLayer(cents: number, revShare: number): number {
  const share = Math.round(cents * clamp(revShare, 0, 1));
  return cents - share - stripeFee(cents);
}

/**
 * The floor, DERIVED rather than declared.
 *
 * Solve `p(1 - r) - (p·0.029 + 30) >= MIN_NET` for p:
 *
 *     p >= (MIN_NET + STRIPE_FIXED) / (1 - r - STRIPE_PCT)
 *
 * When the publisher's revenue share `r` meets or exceeds `1 - STRIPE_PCT`, the
 * denominator is non-positive and NO price clears the bar — every placement is a
 * loss that grows with the price. The function returns `Infinity` and the agent
 * refuses at any number. That is not an edge case to guard against; it is a real
 * commercial fact about a publisher we should not sign, and the log says so.
 */
export function floorFor(revShare: number, minNetCents: number = MIN_NET_CENTS): number {
  const r = clamp(finite(revShare, 0), 0, 1);
  const denominator = 1 - r - STRIPE_PCT;
  // Not `<= 0`. At r = 1 - STRIPE_PCT exactly, binary floating point makes this
  // 7.3e-20 rather than 0, and the closed form then returns a "floor" of
  // $135,880,034,471 — a finite number, so every downstream branch treats the
  // deal as merely expensive rather than impossible. The epsilon is the fix.
  if (!(denominator > 1e-9)) return Number.POSITIVE_INFINITY;

  const analytic = Math.ceil((minNetCents + STRIPE_FIXED_CENTS) / denominator);
  // Above this the supply deal is broken, not the price. No placement in a
  // single llms.txt is worth five figures, so a floor beyond it means no price
  // exists in this market and the honest report is a refusal, not a quote.
  if (!Number.isFinite(analytic) || analytic > NO_VIABLE_PRICE_ABOVE_CENTS) {
    return Number.POSITIVE_INFINITY;
  }

  // `stripeFee()` ROUNDS its percentage to whole cents; the closed form above
  // does not. That makes the analytic answer off by a cent or two in either
  // direction, so correct it against the real fee function until the floor is
  // exactly the least price that clears `minNetCents`. Both walks are bounded:
  // an unbounded correction loop in a pricing agent is a hang, not a price.
  let p = Math.max(HARD_FLOOR_CENTS, analytic);
  for (let i = 0; i < 100 && netToAdLayer(p, r) < minNetCents; i++) p += 1;
  for (let i = 0; i < 100 && p > HARD_FLOOR_CENTS && netToAdLayer(p - 1, r) >= minNetCents; i++) {
    p -= 1;
  }
  return p;
}

/**
 * How much a measured visibility number is allowed to move the price.
 *
 * Sample size gates it. A visibility of 0.0 across 2 queries and across 30
 * queries are different facts, and pricing off the first as though it were the
 * second is how a measurement instrument becomes a horoscope.
 */
export function painMultiplier(score: InvisibilityScore): { pain: number; confidence: number } {
  const visibility = clamp(finite(score?.visibility, 1), 0, 1);
  const total = Math.max(0, finite(score?.total_queries, 0));
  const confidence = clamp(total / MIN_QUERIES_FOR_CONFIDENCE, 0, 1);
  return { pain: 1 + PAIN_WEIGHT * (1 - visibility) * confidence, confidence };
}

/**
 * Scarcity, and it is deliberately NOT monotonic at the low end.
 *
 * An empty shelf is CHEAPER, not dearer: the first advertiser on a publisher is
 * buying inventory with no comparables and no evidence anyone reads it, and is
 * taking that risk on our behalf. From there the price climbs as slots fill.
 * Past capacity it does not climb smoothly — a sixth entry dilutes the five that
 * already paid, so the premium is capped and the FLOOR takes over instead (see
 * `computeQuote`, dilution floor).
 */
export function scarcityMultiplier(slotsUsed: number, slotsTotal: number): number {
  const total = Math.max(1, Math.floor(finite(slotsTotal, MAX_SLOTS_PER_PUBLISHER)));
  const used = Math.max(0, Math.floor(finite(slotsUsed, 0)));
  if (used === 0) return 0.85; // pioneer discount: unproven inventory
  const occupancy = used / total;
  if (occupancy >= 1) return 1.6;
  return 1 + 0.5 * occupancy;
}

/**
 * Category demand from the intersection of what the advertiser sells and what
 * the publisher's readers are asking about. No intersection is a real signal,
 * not a missing value.
 */
export function demandMultiplier(
  prospectCategories: readonly string[],
  publisherCategories: readonly string[],
  table: Readonly<Record<string, number>> = CATEGORY_DEMAND,
): { multiplier: number; matched: string[]; offTarget: boolean } {
  const norm = (s: unknown): string =>
    String(s ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const mine = new Set((prospectCategories ?? []).map(norm).filter((s) => s !== ""));
  const theirs = new Set((publisherCategories ?? []).map(norm).filter((s) => s !== ""));
  const matched = [...mine].filter((c) => theirs.has(c)).sort();

  if (matched.length === 0) {
    // Fall back to the advertiser's own strongest category so an off-target buy
    // is still priced against something real, then discount it hard.
    const best = [...mine].reduce(
      (acc, c) => Math.max(acc, finite(table[c], DEFAULT_CATEGORY_DEMAND)),
      mine.size === 0 ? DEFAULT_CATEGORY_DEMAND : 0,
    );
    return { multiplier: best * OFF_TARGET_MULTIPLIER, matched: [], offTarget: true };
  }
  const multiplier = matched.reduce(
    (acc, c) => Math.max(acc, finite(table[c], DEFAULT_CATEGORY_DEMAND)),
    0,
  );
  return { multiplier, matched, offTarget: false };
}

/**
 * P(close | ask). A logistic centred on estimated willingness to pay.
 *
 * A STATED budget is a wall, not a curve: a buyer who told us $40 does not close
 * at $60 with probability 0.05, they close with probability 0. Treating a stated
 * number as soft is how an agent talks itself into a quote nobody accepts.
 */
export function closeProbability(
  askCents: number,
  wtpCents: number,
  statedBudgetCents: number | null,
  steepness: number = CLOSE_STEEPNESS,
): number {
  if (statedBudgetCents !== null && askCents > statedBudgetCents) return 0;
  const wtp = Math.max(1, wtpCents);
  const z = (steepness * (askCents - wtp)) / wtp;
  return 1 / (1 + Math.exp(clamp(z, -40, 40)));
}

/**
 * Calibrate willingness-to-pay against prices we actually quoted and the answers
 * we got. This is the path off the model prior, and it is implemented rather
 * than promised: the highest price that CLOSED and the lowest price that was
 * REFUSED bracket the market, and the midpoint of that bracket is an observation.
 * Weight grows with n and is capped, because six data points is a hint, not a
 * demand curve.
 */
export function calibrationFromOutcomes(
  outcomes: readonly ObservedOutcome[],
  priorWtpCents: number,
): { wtp_cents: number; weight: number; n: number } {
  const clean = (outcomes ?? []).filter(
    (o) => o !== null && o !== undefined && Number.isFinite(Number(o.price_cents)),
  );
  if (clean.length < 3) return { wtp_cents: priorWtpCents, weight: 0, n: clean.length };

  const closed = clean.filter((o) => o.closed === true).map((o) => Number(o.price_cents));
  const lost = clean.filter((o) => o.closed !== true).map((o) => Number(o.price_cents));
  const maxClosed = closed.length > 0 ? Math.max(...closed) : null;
  const minLost = lost.length > 0 ? Math.min(...lost) : null;

  let observed: number;
  if (maxClosed !== null && minLost !== null) {
    // The bracket. If they cross (someone said no below someone else's yes) the
    // midpoint is still the best single estimate we have of the boundary.
    observed = (maxClosed + minLost) / 2;
  } else if (maxClosed !== null) {
    // Everything closed — the market is above the highest price we dared ask.
    observed = maxClosed * 1.2;
  } else if (minLost !== null) {
    // Everything was refused — the market is below the cheapest thing we asked.
    observed = minLost * 0.8;
  } else {
    return { wtp_cents: priorWtpCents, weight: 0, n: clean.length };
  }

  const weight = Math.min(0.6, clean.length / 10);
  return {
    wtp_cents: Math.round(priorWtpCents * (1 - weight) + observed * weight),
    weight,
    n: clean.length,
  };
}

/**
 * THE DECISION, as arithmetic. Pure, deterministic, and the thing the flip
 * search perturbs.
 *
 * Shape of the model:
 *   · The FLOOR is a supply-side fact — our costs, the publisher's share, and
 *     the dilution the shelf suffers if we oversell it.
 *   · The CEILING is a demand-side fact — this buyer's measured pain, their
 *     size, and any budget they stated.
 *   · Category demand and scarcity set WHERE IN THAT BAND we ask.
 *   · Expected net contribution picks between asking low, asking at the market,
 *     and asking high — and against not selling at all.
 */
export function computeQuote(input: QuoteInput): PriceQuote {
  const revShare = clamp(finite(input.rev_share, 0), 0, 1);
  const slotsTotal = Math.max(1, Math.floor(finite(input.slots_total, MAX_SLOTS_PER_PUBLISHER)));
  const slotsUsed = Math.max(0, Math.floor(finite(input.slots_used, 0)));
  const occupancy = slotsUsed / slotsTotal;
  const atCapacity = slotsUsed >= slotsTotal;

  const { pain, confidence } = painMultiplier({
    visibility: input.visibility,
    cited_queries: 0,
    total_queries: input.total_queries,
  });
  const scarcity = scarcityMultiplier(slotsUsed, slotsTotal);
  const demand = Math.max(0, finite(input.demand_multiplier, DEFAULT_CATEGORY_DEMAND));
  const sizeMultiplier = Math.max(0, finite(input.size_multiplier, UNKNOWN_SIZE_MULTIPLIER));
  const base = Math.max(0, finite(input.base_cents, BASE_PLACEMENT_CENTS));

  // ── Demand side ───────────────────────────────────────────────────────────
  const priorWtp = base * pain * sizeMultiplier;
  const wtp = Math.max(1, Math.round(priorWtp * Math.max(0, finite(input.wtp_calibration, 1))));
  const statedBudget =
    input.stated_budget_cents === null || input.stated_budget_cents === undefined
      ? null
      : Math.max(0, Math.round(finite(input.stated_budget_cents, 0)));
  const ceiling = Math.floor(
    statedBudget === null
      ? wtp * CEILING_OVER_WTP
      : Math.min(statedBudget, wtp * CEILING_OVER_WTP),
  );

  // ── Supply side ───────────────────────────────────────────────────────────
  const economicFloor = floorFor(revShare);
  // Dilution floor: past capacity, a new entry costs every incumbent some of the
  // attention they bought. Selling that dilution for less than the dearest
  // incumbent paid is value destruction disguised as revenue.
  const dilutionFloor =
    atCapacity && input.incumbent_max_cents !== null
      ? Math.max(0, Math.round(finite(input.incumbent_max_cents, 0)))
      : 0;
  const floor = Math.max(economicFloor, dilutionFloor);

  // Where in the band to ask. Capped at 0.85 so `premium` (the ceiling) is
  // always a genuinely different number from `market` — two "options" that
  // resolve to the same price are one option with two names, and the decision
  // log grades that as a rubber stamp.
  const marketPosition = clamp(0.5 * demand * scarcity, 0.1, 0.85);

  const cost = (p: number): Omit<PricingCandidate, "strategy" | "note"> => {
    const share = Math.round(p * revShare);
    const fee = stripeFee(p);
    const net = p - share - fee;
    const prob = closeProbability(p, wtp, statedBudget);
    return {
      price_cents: p,
      close_probability: Math.round(prob * 1000) / 1000,
      net_to_adlayer_cents: net,
      publisher_share_cents: share,
      stripe_fee_cents: fee,
      expected_net_cents: Math.round(prob * net),
    };
  };

  const refuseCandidate: PricingCandidate = {
    strategy: "refuse",
    price_cents: null,
    close_probability: 0,
    net_to_adlayer_cents: 0,
    publisher_share_cents: 0,
    stripe_fee_cents: 0,
    expected_net_cents: 0,
    note: "Decline the deal. No revenue today, the slot stays open, and no below-cost comparable enters our own book.",
  };

  const floorIsReachable = Number.isFinite(floor);
  const bandIsOpen = floorIsReachable && ceiling >= floor;
  const candidates: PricingCandidate[] = [];

  const asks: { strategy: PricingStrategy; price: number; note: string }[] = [];
  if (floorIsReachable) {
    asks.push({
      strategy: "hold_floor",
      price: floor,
      note: `Quote the floor — the least this placement is worth processing at a ${Math.round(revShare * 100)}% revenue share. Maximum close probability, minimum upside, and it sets a cheap comparable for the next advertiser on this publisher.`,
    });
  }
  if (bandIsOpen) {
    const rawMarket = floor + (ceiling - floor) * marketPosition;
    asks.push({
      strategy: "market",
      price: clamp(Math.round(rawMarket / 100) * 100, floor, ceiling),
      note: `Quote the model price: ${Math.round(marketPosition * 100)}% of the way up the band, driven by category demand ×${demand.toFixed(2)} and shelf scarcity ×${scarcity.toFixed(2)}.`,
    });
    asks.push({
      strategy: "premium",
      price: ceiling,
      note: "Quote the buyer's ceiling. Most likely to lose the sale, and the most valuable comparable if it lands.",
    });
  } else if (ceiling > 0) {
    // The buyer's ceiling is beneath our floor. Put the deal we are turning
    // down on the record, fully costed, so the refusal has something to refuse.
    asks.push({
      strategy: "sell_below_floor",
      price: ceiling,
      note: floorIsReachable
        ? `Take their number — ${money(ceiling)} — and book the transaction anyway. Beneath the ${money(floor)} floor, so it nets less than the ${money(MIN_NET_CENTS)} that makes a placement worth processing, and it enters a below-cost comparable that caps every later quote on this publisher.`
        : `Take their number — ${money(ceiling)} — and book the transaction anyway. At a ${Math.round(revShare * 100)}% revenue share no price clears our costs at all, so this one loses money and a larger one would lose more.`,
    });
  }

  const seen = new Set<number>();
  for (const a of asks) {
    if (seen.has(a.price)) continue; // collapsed by rounding — one option, one price
    seen.add(a.price);
    candidates.push({ strategy: a.strategy, ...cost(a.price), note: a.note });
  }
  candidates.push(refuseCandidate);

  // ── Choose ────────────────────────────────────────────────────────────────
  // Argmax expected NET contribution, not expected revenue. A cheap sale on a
  // greedy publisher can gross well and net nothing, and revenue we do not keep
  // is not a reason to price low.
  //
  // The scan runs over SELECTABLE_STRATEGIES only. `sell_below_floor` can have
  // the highest expected value on the board and still cannot win — that is what
  // a floor IS. Ties go to `refuse`, because it starts as the incumbent and the
  // comparison is strictly greater-than: a sale that is merely as good as not
  // selling is not worth the obligations it creates.
  let chosen: PricingCandidate = refuseCandidate;
  for (const c of candidates) {
    if (!SELECTABLE_STRATEGIES.includes(c.strategy)) continue;
    if (c.strategy === "refuse") continue;
    if (c.expected_net_cents > chosen.expected_net_cents) chosen = c;
  }

  let outcome: PricingOutcome;
  let strategy: PricingStrategy = chosen.strategy;
  let priceCents: number | null = chosen.price_cents;
  let proposed: number | null = null;

  if (chosen.strategy === "refuse") {
    outcome = Number.isFinite(floor) ? "refused_below_floor" : "refused_unprofitable_publisher";
    priceCents = null;
  } else if ((chosen.price_cents ?? 0) > AUTONOMY_LIMIT_CENTS) {
    // Defensible, but above what this agent was trusted to commit unilaterally.
    outcome = "escalated_to_human";
    strategy = "escalate";
    proposed = chosen.price_cents;
    priceCents = null;
    candidates.push({
      strategy: "escalate",
      price_cents: null,
      close_probability: chosen.close_probability,
      net_to_adlayer_cents: chosen.net_to_adlayer_cents,
      publisher_share_cents: chosen.publisher_share_cents,
      stripe_fee_cents: chosen.stripe_fee_cents,
      expected_net_cents: chosen.expected_net_cents,
      note: `Hold for human approval at ${money(chosen.price_cents)} — above this agent's ${money(AUTONOMY_LIMIT_CENTS)} authority limit. No quote is issued until a person signs.`,
    });
  } else {
    outcome = "sell";
  }

  return {
    outcome,
    strategy,
    price_cents: priceCents,
    proposed_price_cents: proposed,
    floor_cents: floor,
    ceiling_cents: ceiling,
    wtp_cents: wtp,
    pain_multiplier: round3(pain),
    confidence: round3(confidence),
    demand_multiplier: round3(demand),
    scarcity_multiplier: round3(scarcity),
    size_multiplier: round3(sizeMultiplier),
    market_position: round3(marketPosition),
    slots_used: slotsUsed,
    slots_total: slotsTotal,
    occupancy: round3(occupancy),
    at_capacity: atCapacity,
    off_target: input.off_target === true,
    net_to_adlayer_cents: chosen.net_to_adlayer_cents,
    publisher_share_cents: chosen.publisher_share_cents,
    stripe_fee_cents: chosen.stripe_fee_cents,
    close_probability: chosen.close_probability,
    expected_net_cents: chosen.expected_net_cents,
    candidates,
  };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function money(cents: number | null): string {
  if (cents === null) return "—";
  if (!Number.isFinite(cents)) return "no price exists";
  return `$${(cents / 100).toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The falsifier, DERIVED
//
// `flip_condition` is the field a faker hates, so it is not written by hand
// here. The pricing core is pure, so we can walk each input axis outward from
// its actual value and find the nearest point where the CHOICE changes. What
// comes back is a real number in the same units as the evidence — "if visibility
// had been 0.41 instead of 0.13" — and a reader can check how close the call was.
//
// A flip that is not found is also information: it means the choice was
// insensitive to that input across its whole range, and the log says exactly
// that rather than inventing a condition.
// ─────────────────────────────────────────────────────────────────────────────

export interface FlipPoint {
  axis: "visibility" | "occupancy" | "rev_share" | "stated_budget";
  /** Value of that axis at which the choice changes. */
  threshold: number;
  /** Value it actually had. */
  actual: number;
  from: PricingStrategy;
  to: PricingStrategy;
  /** Sentence for `flip_condition`. Same units as the evidence. */
  statement: string;
  /** How far the input had to move, relative. Smaller = closer call. */
  distance: number;
}

function strategyOf(input: QuoteInput): PricingStrategy {
  return computeQuote(input).strategy;
}

/**
 * Plain-language description of an action, so `flip_condition` reads as a
 * claim about what the company would have DONE rather than as a symbol only
 * this file understands. It also keeps the sentence true when the flipped-to
 * strategy has no exact counterpart among this entry's options — "would have
 * sold rather than refused" is accurate whichever selling option we map to.
 */
export const STRATEGY_NOUN: Readonly<Record<PricingStrategy, string>> = {
  hold_floor: "the floor price",
  market: "the market price",
  premium: "this buyer's ceiling",
  escalate: "a hold for human approval",
  sell_below_floor: "a below-floor discount",
  refuse: "no sale",
};

function flipPhrase(from: PricingStrategy, to: PricingStrategy): string {
  if (to === "refuse") return `walked away instead of quoting ${STRATEGY_NOUN[from]}`;
  if (to === "escalate") return `held the price for human approval instead of quoting ${STRATEGY_NOUN[from]}`;
  if (from === "refuse") return `sold at ${STRATEGY_NOUN[to]} instead of walking away`;
  if (from === "escalate") return `quoted ${STRATEGY_NOUN[to]} outright instead of holding it for human approval`;
  return `quoted ${STRATEGY_NOUN[to]} instead of ${STRATEGY_NOUN[from]}`;
}

/**
 * Nearest flip across every axis, returning the closest call. Each scan is a
 * few hundred evaluations of pure arithmetic — cheap enough to do on every
 * quote, which is the point: the falsifier is computed per decision, not
 * boilerplate copied between entries.
 */
export function findFlip(input: QuoteInput): FlipPoint | null {
  const from = strategyOf(input);
  const found: FlipPoint[] = [];

  const scan = (
    axis: FlipPoint["axis"],
    actual: number,
    values: number[],
    apply: (v: number) => QuoteInput,
    describe: (v: number, to: PricingStrategy) => string,
    scale: number,
  ): void => {
    let best: FlipPoint | null = null;
    for (const v of values) {
      const to = strategyOf(apply(v));
      if (to === from) continue;
      const distance = Math.abs(v - actual) / (scale === 0 ? 1 : scale);
      if (best === null || distance < best.distance) {
        best = { axis, threshold: v, actual, from, to, statement: describe(v, to), distance };
      }
    }
    if (best !== null) found.push(best);
  };

  const grid = (lo: number, hi: number, step: number): number[] => {
    const out: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  };

  scan(
    "visibility",
    clamp(finite(input.visibility, 0), 0, 1),
    grid(0, 1, 0.01),
    (v) => ({ ...input, visibility: v }),
    (v, to) =>
      `If ${input.total_queries} measured queries had put their visibility at ${v.toFixed(2)} instead of ${clamp(finite(input.visibility, 0), 0, 1).toFixed(2)}, this agent would have ${flipPhrase(from, to)}.`,
    1,
  );

  scan(
    "occupancy",
    Math.max(0, Math.floor(finite(input.slots_used, 0))),
    grid(0, Math.max(1, input.slots_total) + 2, 1),
    (v) => ({ ...input, slots_used: v }),
    (v, to) =>
      `If this publisher already carried ${v} placement${v === 1 ? "" : "s"} instead of ${Math.max(0, Math.floor(finite(input.slots_used, 0)))}, this agent would have ${flipPhrase(from, to)}.`,
    Math.max(1, input.slots_total),
  );

  scan(
    "rev_share",
    clamp(finite(input.rev_share, 0), 0, 1),
    grid(0, 0.98, 0.01),
    (v) => ({ ...input, rev_share: v }),
    (v, to) =>
      `If the publisher's revenue share were ${Math.round(v * 100)}% instead of ${Math.round(clamp(finite(input.rev_share, 0), 0, 1) * 100)}%, this agent would have ${flipPhrase(from, to)}.`,
    1,
  );

  if (input.stated_budget_cents !== null) {
    const actual = Math.max(0, finite(input.stated_budget_cents, 0));
    const hi = Math.max(actual * 4, 20000);
    scan(
      "stated_budget",
      actual,
      grid(0, hi, Math.max(100, Math.round(hi / 200 / 100) * 100)),
      (v) => ({ ...input, stated_budget_cents: v }),
      (v, to) =>
        `If they had stated a budget of ${money(v)} instead of ${money(actual)}, this agent would have ${flipPhrase(from, to)}.`,
      Math.max(1, actual),
    );
  }

  if (found.length === 0) return null;
  return found.reduce((a, b) => (b.distance < a.distance ? b : a));
}

// ─────────────────────────────────────────────────────────────────────────────
// Category demand lookup — the keyless seam
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// MECHANISM REPLAY — the auditor re-runs this agent instead of reading about it
//
// `auditEntry()` on its own checks the SHAPE of a record, and a coin-flip agent
// with good templates passes every shape check (see decision-log.ts's header).
// The check it cannot pass is this one: the entry carries the exact `QuoteInput`
// the price came from, plus that input with the flip condition's stated value
// substituted, and the auditor re-runs `computeQuote` on both. The first must
// reproduce the chosen option; the second must produce a different one.
//
// Nothing here is a second implementation of the pricing rules — it is the same
// `computeQuote` the agent called, addressed by name, so the record and the code
// cannot drift apart.
// ─────────────────────────────────────────────────────────────────────────────

/** Registry key. The DecisionLog re-runs the quote by this name. */
export const PRICING_MECHANISM = "pricing.computeQuote";

/** JSON in, option id out. Total: bad input returns null rather than throwing. */
export function pricingMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  try {
    return `opt_${computeQuote(raw as QuoteInput).strategy}`;
  } catch {
    return null;
  }
}

registerMechanism(PRICING_MECHANISM, pricingMechanism);

/**
 * The flip condition's stated value, substituted into the input it names.
 *
 * `findFlip` already located the nearest input change that alters the choice
 * and wrote the sentence from it; this applies the same number to the same
 * field, so the replayed falsifier is the sentence, not a paraphrase of it.
 */
export function applyFlipPoint(input: QuoteInput, flip: FlipPoint): QuoteInput {
  switch (flip.axis) {
    case "visibility":
      return { ...input, visibility: flip.threshold };
    case "occupancy":
      return { ...input, slots_used: flip.threshold };
    case "rev_share":
      return { ...input, rev_share: flip.threshold };
    case "stated_budget":
      return { ...input, stated_budget_cents: flip.threshold };
    default:
      return input;
  }
}

export interface DemandLookup {
  /** category → multiplier. Merged over the prior table. */
  table: Record<string, number>;
  source: EvidenceSource;
  ref: string | null;
  observed_at: string | null;
}

export type DemandFn = (categories: readonly string[]) => Promise<DemandLookup | null>;

/**
 * Live category demand, when a key exists.
 *
 * Runs keyless: with `ADLAYER_DEMAND_API_URL` or `ADLAYER_DEMAND_API_KEY`
 * missing it emits ONE log line and returns `null`, and the caller falls back to
 * `CATEGORY_DEMAND`. It never throws — not on a missing key, not on a timeout,
 * not on a 500, not on unparseable JSON. The degradation is visible downstream:
 * the demand evidence is logged as `model_prior` rather than `external_api`,
 * which raises the weak-evidence rate `summarize()` prints against us.
 */
export const defaultDemandLookup: DemandFn = async (categories) => {
  const url = process.env["ADLAYER_DEMAND_API_URL"];
  const key = process.env["ADLAYER_DEMAND_API_KEY"];
  if (url === undefined || url === "" || key === undefined || key === "") {
    console.log(
      "[adlayer:pricing] no demand API key — pricing off the built-in category prior. " +
        "Demand evidence is logged as model_prior, which counts against this decision in the audit.",
    );
    return null;
  }
  try {
    const response = await fetch(`${url}?categories=${encodeURIComponent(categories.join(","))}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.log(`[adlayer:pricing] demand API returned ${response.status} — falling back to the prior.`);
      return null;
    }
    const body: unknown = await response.json();
    const table: Record<string, number> = {};
    if (typeof body === "object" && body !== null) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) table[k.toLowerCase()] = n;
      }
    }
    if (Object.keys(table).length === 0) {
      console.log("[adlayer:pricing] demand API returned nothing usable — falling back to the prior.");
      return null;
    }
    return { table, source: "external_api", ref: url, observed_at: new Date().toISOString() };
  } catch (err) {
    console.log(
      `[adlayer:pricing] demand API unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to the prior.`,
    );
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// The agent
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingOptions {
  /** Placements already live on this publisher. Drives scarcity and the dilution floor. */
  shelf?: readonly ShelfPlacement[];
  /** Prices we already quoted and the answers we got. Calibrates willingness to pay. */
  outcomes?: readonly ObservedOutcome[];
  /** Where the decision is recorded. Defaults to a memory-only, dry-run log. */
  log?: DecisionSink;
  /** Injected in tests. Defaults to the keyless-degrading live lookup. */
  demandFn?: DemandFn;
  /** Something a reader can open to check the visibility number. */
  scoreRef?: string | null;
  slotsTotal?: number;
  /** Stable id for the log entry. Defaults to a derived, collision-free id. */
  decisionId?: string;
  now?: () => Date;
  logger?: (message: string) => void;
}

export interface PricingResult {
  /** The number to charge, in cents. `null` whenever we are not selling today. */
  priceCents: number | null;
  /** The logged, hash-chained record of how that number was reached. */
  decision: DecisionEntry;
  /** The full working: floor, ceiling, every candidate, and the derived falsifier. */
  quote: PriceQuote;
  /** The nearest input change that would have flipped the choice. `null` if none exists. */
  flip: FlipPoint | null;
}

/** In-process tiebreak so two quotes in the same millisecond cannot collide on id. */
let decisionCounter = 0;

/**
 * Price one placement.
 *
 * Throws only when the decision log refuses the draft — see the header. A price
 * whose reasoning was not recorded is worse than no price, so this function will
 * not return one.
 */
export async function price(
  prospect: PricingProspect,
  score: InvisibilityScore,
  publisher: Publisher,
  flags: RunFlags,
  options: PricingOptions = {},
): Promise<PricingResult> {
  const now = options.now ?? ((): Date => new Date());
  const decidedAt = now().toISOString();
  const log = options.log ?? openDecisionLog({ logger: options.logger });
  const demandFn = options.demandFn ?? defaultDemandLookup;

  // ── Resolve the inputs ────────────────────────────────────────────────────
  const shelf = (options.shelf ?? []).filter((p) => p?.publisher_id === publisher.id);
  const slotsTotal = Math.max(1, Math.floor(finite(options.slotsTotal, MAX_SLOTS_PER_PUBLISHER)));
  const incumbentPrices = shelf
    .map((p) => finite(p.price_cents, 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const incumbentMax = incumbentPrices.length > 0 ? Math.max(...incumbentPrices) : null;

  // A demand source that throws is a broken demand source, not a reason to
  // stop pricing. The built-in lookup already degrades; an injected one might
  // not, and there is exactly one throw path in this module (see the header)
  // and it is the decision log refusing to record the price.
  let lookup: DemandLookup | null = null;
  try {
    lookup = await demandFn([...(prospect.categories ?? []), ...(publisher.categories ?? [])]);
  } catch (err) {
    (options.logger ?? console.log)(
      `[adlayer:pricing] demand lookup threw (${err instanceof Error ? err.message : String(err)}) — pricing off the built-in category prior.`,
    );
    lookup = null;
  }
  const table = lookup === null ? CATEGORY_DEMAND : { ...CATEGORY_DEMAND, ...lookup.table };
  const demand = demandMultiplier(prospect.categories ?? [], publisher.categories ?? [], table);

  const sizeKnown = prospect.size !== undefined && prospect.size !== null;
  const sizeMultiplier = sizeKnown
    ? (SIZE_MULTIPLIER[prospect.size as ProspectSize] ?? UNKNOWN_SIZE_MULTIPLIER)
    : UNKNOWN_SIZE_MULTIPLIER;

  const { pain } = painMultiplier(score);
  const priorWtp = BASE_PLACEMENT_CENTS * pain * sizeMultiplier;
  const calibration = calibrationFromOutcomes(options.outcomes ?? [], priorWtp);
  const wtpCalibration = priorWtp === 0 ? 1 : calibration.wtp_cents / priorWtp;

  const input: QuoteInput = {
    base_cents: BASE_PLACEMENT_CENTS,
    visibility: clamp(finite(score?.visibility, 1), 0, 1),
    total_queries: Math.max(0, finite(score?.total_queries, 0)),
    size_multiplier: sizeMultiplier,
    stated_budget_cents:
      prospect.stated_budget_cents === undefined || prospect.stated_budget_cents === null
        ? null
        : Math.max(0, Math.round(finite(prospect.stated_budget_cents, 0))),
    demand_multiplier: demand.multiplier,
    off_target: demand.offTarget,
    rev_share: clamp(finite(publisher.rev_share, 0), 0, 1),
    slots_used: shelf.length,
    slots_total: slotsTotal,
    incumbent_max_cents: incumbentMax,
    wtp_calibration: wtpCalibration,
  };

  const quote = computeQuote(input);
  const flip = findFlip(input);

  // ── Build the record ──────────────────────────────────────────────────────
  const evidence = buildEvidence({
    prospect,
    score,
    publisher,
    quote,
    input,
    demand,
    lookup,
    calibration,
    sizeKnown,
    scoreRef: options.scoreRef ?? null,
    shelfCount: shelf.length,
    incumbentMax,
  });
  const evidenceIds = new Set(evidence.map((e) => e.id));
  const cite = (...ids: string[]): string[] => ids.filter((id) => evidenceIds.has(id));

  const decisionOptions: DecisionOption[] = quote.candidates.map((c) => ({
    id: `opt_${c.strategy}`,
    summary:
      c.price_cents === null
        ? c.strategy === "escalate"
          ? `Escalate: propose ${money(quote.proposed_price_cents)}, human approves before any quote is sent`
          : "Refuse the deal"
        : c.strategy === "sell_below_floor"
          ? `Discount to ${money(c.price_cents)} — beneath the ${money(quote.floor_cents)} floor`
          : `Quote ${money(c.price_cents)} (${c.strategy.replace(/_/g, " ")})`,
    expected_outcome: expectedOutcomeFor(c, quote, publisher),
    supported_by: supportFor(c.strategy, cite),
    projected_value_cents: c.expected_net_cents,
  }));

  const chosenId = `opt_${quote.strategy}`;

  // DERIVE the falsifier rather than assert it. We substitute the flip
  // condition's own stated value, re-run the same pure function the price came
  // from, and take whatever it returns. `pickFlipTarget` remains the fallback
  // for the case where no input we can vary changes the answer — an entry that
  // is INSENSITIVE, which `buildFlipCondition` already says out loud.
  const flipInput = flip === null ? null : applyFlipPoint(input, flip);
  const derivedFlipId = flipInput === null ? null : pricingMechanism(flipInput);
  const derivedIsUsable =
    derivedFlipId !== null &&
    derivedFlipId !== chosenId &&
    decisionOptions.some((o) => o.id === derivedFlipId);
  const flipToId = derivedIsUsable
    ? derivedFlipId
    : pickFlipTarget(quote, decisionOptions, chosenId, flip);

  // Attach the replay ONLY when it verifies here. An unverifiable replay is
  // worse than no replay: `auditEntry()` treats a refuted one as fatal, and
  // rightly — it would mean the record and the code disagree. Entries without
  // one are counted as "not re-run" in the summary, never as verified.
  const replay: DecisionReplay | null =
    pricingMechanism(input) === chosenId && derivedIsUsable && flipInput !== null
      ? { fn: PRICING_MECHANISM, input, flip_input: flipInput }
      : null;

  const draft: DecisionDraft = {
    id:
      options.decisionId ??
      `dec_pricing_${slug(prospect.id)}_${slug(publisher.id)}_${(decisionCounter++).toString(36)}${Date.now().toString(36)}`,
    agent: "Pricing",
    decided_at: decidedAt,
    question: `What do we charge ${prospect.name} for a placement on ${publisher.domain}?`,
    context: "src/company/pricing.ts → price()",
    options: decisionOptions,
    chosen_option_id: chosenId,
    rationale: buildRationale(
      prospect,
      publisher,
      quote,
      flip,
      demand,
      calibration,
      lookup,
      input.visibility,
    ),
    evidence,
    flip_condition: buildFlipCondition(quote, flip),
    flip_to_option_id: flipToId,
    replay,
    // A quote is withdrawable up to the moment it is paid. What is NOT reversible
    // is the comparable it enters into our own book, and the reversal path says so.
    reversible: true,
    reversal_path:
      quote.price_cents === null
        ? "Nothing was sent. Re-run pricing with a renegotiated revenue share, a stated budget, or a fresh visibility measurement."
        : `Withdraw or re-quote before the Stripe Payment Link is paid. After payment, a refund returns the money but not the ${money(quote.price_cents)} comparable this sale enters into the book for ${publisher.domain}.`,
    // Dry run by default: the price only binds when the placement it pays for
    // can actually go live. See the header on why liveServe is the gate.
    executed: flags?.liveServe === true && quote.outcome === "sell",
    effect: buildEffect(quote, publisher, flags),
    supersedes: null,
  };

  // No unlogged prices. If the ledger refuses this draft, the caller gets the
  // error, not a number — see the header.
  const decision = log.append(draft);

  return { priceCents: quote.price_cents, decision, quote, flip };
}

/** The name the DecisionLog fixtures use. Same function, kept as an alias. */
export const pricePlacement = price;

// ─────────────────────────────────────────────────────────────────────────────
// Record construction
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceInput {
  prospect: PricingProspect;
  score: InvisibilityScore;
  publisher: Publisher;
  quote: PriceQuote;
  input: QuoteInput;
  demand: { multiplier: number; matched: string[]; offTarget: boolean };
  lookup: DemandLookup | null;
  calibration: { wtp_cents: number; weight: number; n: number };
  sizeKnown: boolean;
  scoreRef: string | null;
  shelfCount: number;
  incumbentMax: number | null;
}

function buildEvidence(i: EvidenceInput): DecisionEvidence[] {
  const { prospect, score, publisher, quote, demand, lookup, calibration } = i;
  const shelfRef = `https://${publisher.domain}/llms.txt`;
  const out: DecisionEvidence[] = [];

  out.push({
    id: "ev_visibility",
    claim: `${prospect.name} is cited in ${score?.cited_queries ?? 0} of ${score?.total_queries ?? 0} measured answer-engine queries (visibility ${i.input.visibility.toFixed(4)}).`,
    source: "measurement",
    ref: i.scoreRef ?? `prospect:${prospect.id}`,
    value: i.input.visibility,
    observed_at: null,
  });

  out.push({
    id: "ev_sample",
    claim: `That visibility rests on ${i.input.total_queries} queries, which is ${Math.round(quote.confidence * 100)}% of the ${MIN_QUERIES_FOR_CONFIDENCE} needed before we price off it fully.`,
    source: "measurement",
    ref: i.scoreRef ?? `prospect:${prospect.id}`,
    value: i.input.total_queries,
    observed_at: null,
  });

  out.push({
    id: "ev_demand",
    claim:
      demand.matched.length > 0
        ? `Publisher and advertiser both sit in [${demand.matched.join(", ")}]; category demand multiplier ×${demand.multiplier.toFixed(2)}.`
        : `No category overlap between ${prospect.domain} and ${publisher.domain}. Off-target inventory, discounted ×${OFF_TARGET_MULTIPLIER}.`,
    source: lookup === null ? "model_prior" : lookup.source,
    ref: lookup === null ? "src/company/pricing.ts#CATEGORY_DEMAND" : lookup.ref,
    value: demand.multiplier,
    observed_at: lookup?.observed_at ?? null,
  });

  out.push({
    id: "ev_occupancy",
    claim: `${publisher.domain} already carries ${i.shelfCount} of ${quote.slots_total} sponsored slots (scarcity ×${quote.scarcity_multiplier.toFixed(2)})${i.incumbentMax !== null ? `; the dearest incumbent paid ${money(i.incumbentMax)}` : ""}.`,
    source: "measurement",
    ref: shelfRef,
    value: i.shelfCount,
    observed_at: null,
  });

  out.push({
    id: "ev_revshare",
    claim: `${publisher.domain} takes ${Math.round(i.input.rev_share * 100)}% of placement revenue, which puts the break-even floor at ${money(quote.floor_cents)} for a ${money(MIN_NET_CENTS)} minimum net.`,
    // A verified publisher was onboarded by a person; an unverified one is
    // seeded demo data. Saying which is which is cheap and it is the truth.
    source: publisher.verified_at !== null ? "human_input" : "fixture",
    ref: shelfRef,
    value: i.input.rev_share,
    observed_at: publisher.verified_at,
  });

  if (i.input.stated_budget_cents !== null) {
    out.push({
      id: "ev_budget",
      claim: `${prospect.name} stated a budget of ${money(i.input.stated_budget_cents)}. Treated as a hard wall: close probability above it is zero, not small.`,
      source: "human_input",
      ref: `prospect:${prospect.id}`,
      value: i.input.stated_budget_cents,
      observed_at: null,
    });
  }

  out.push({
    id: "ev_size",
    claim: i.sizeKnown
      ? `${prospect.name} is banded "${String(prospect.size)}" (willingness-to-pay ×${quote.size_multiplier.toFixed(2)}).`
      : `Nobody established ${prospect.name}'s size, so willingness to pay uses the neutral ×${UNKNOWN_SIZE_MULTIPLIER.toFixed(2)}. This is a guess and it moves the price.`,
    source: i.sizeKnown ? "human_input" : "model_prior",
    ref: i.sizeKnown ? `prospect:${prospect.id}` : "src/company/pricing.ts#SIZE_MULTIPLIER",
    value: quote.size_multiplier,
    observed_at: null,
  });

  out.push({
    id: "ev_close_curve",
    claim:
      calibration.weight > 0
        ? `Close-probability curve calibrated against ${calibration.n} observed quote outcomes (weight ${calibration.weight.toFixed(2)}); willingness to pay estimated at ${money(quote.wtp_cents)}.`
        : `Close-probability curve is an UNCALIBRATED prior (logistic, steepness ${CLOSE_STEEPNESS}, centred on ${money(quote.wtp_cents)}). No closed or lost deals exist yet to fit it. This is the most likely reason this price is wrong.`,
    source: calibration.weight > 0 ? "measurement" : "model_prior",
    ref: calibration.weight > 0 ? "pricing:observed_outcomes" : "src/company/pricing.ts#closeProbability",
    value: quote.wtp_cents,
    observed_at: null,
  });

  return out;
}

function supportFor(strategy: PricingStrategy, cite: (...ids: string[]) => string[]): string[] {
  switch (strategy) {
    case "hold_floor":
      return cite("ev_revshare", "ev_close_curve", "ev_budget");
    case "market":
      return cite("ev_visibility", "ev_sample", "ev_demand", "ev_occupancy");
    case "premium":
      return cite("ev_occupancy", "ev_demand", "ev_size");
    case "escalate":
      return cite("ev_size", "ev_visibility");
    case "sell_below_floor":
      return cite("ev_budget", "ev_revshare", "ev_close_curve");
    case "refuse":
      return cite("ev_revshare", "ev_budget", "ev_close_curve");
  }
}

function expectedOutcomeFor(
  candidate: PricingCandidate,
  quote: PriceQuote,
  publisher: Publisher,
): string {
  if (candidate.strategy === "refuse") {
    return `No revenue today and no charge to reconcile. The slot on ${publisher.domain} stays open for a buyer above the ${money(quote.floor_cents)} floor, and our book gains no comparable that caps the next quote.`;
  }
  if (candidate.strategy === "escalate") {
    return `No quote reaches the advertiser until a person approves ${money(quote.proposed_price_cents)}. Expected net ${money(candidate.expected_net_cents)} is deferred by however long the human takes, and the deal can be lost to the delay.`;
  }
  const pct = Math.round(candidate.close_probability * 100);
  if (candidate.strategy === "sell_below_floor") {
    return `Closes with probability ~${pct}% and books ${money(candidate.price_cents)} of gross, of which ${money(candidate.net_to_adlayer_cents)} reaches AdLayer after ${publisher.domain}'s share and Stripe's fee — against a ${money(MIN_NET_CENTS)} minimum. The transaction count goes up, the placement is served at a price that does not cover the work of serving it, and ${money(candidate.price_cents)} becomes the comparable every later advertiser on ${publisher.domain} negotiates against.`;
  }
  return `Closes with probability ~${pct}%. If it closes, ${money(candidate.price_cents)} is charged, ${publisher.domain} is owed ${money(candidate.publisher_share_cents)}, Stripe takes ${money(candidate.stripe_fee_cents)}, and ${money(candidate.net_to_adlayer_cents)} reaches AdLayer — expected net ${money(candidate.expected_net_cents)}. A close also enters ${money(candidate.price_cents)} as the comparable for the next advertiser on ${publisher.domain}.`;
}

/**
 * The option `flip_condition` leads to, guaranteed to be one this entry lists.
 *
 * The falsifier is derived by re-running the pricing core with one input moved,
 * so the strategy it lands on can be one that does not appear in THIS entry's
 * option set — a refusal has no `market` option to flip to even though a bigger
 * budget would have produced one. Resolution, in order:
 *
 *   1. the exact strategy, if it is on the table here;
 *   2. any selling option, when the flip is from refusing to selling — the
 *      `flip_condition` sentence says "would have sold", which is true of
 *      whichever selling option we name;
 *   3. `refuse`, when the flip is toward declining;
 *   4. the runner-up by expected net — the option we came closest to taking.
 */
function pickFlipTarget(
  quote: PriceQuote,
  options: readonly DecisionOption[],
  chosenId: string,
  flip: FlipPoint | null,
): string | null {
  const has = (id: string): boolean => id !== chosenId && options.some((o) => o.id === id);

  if (flip !== null) {
    const exact = `opt_${flip.to}`;
    if (has(exact)) return exact;
    if (flip.to === "refuse" && has("opt_refuse")) return "opt_refuse";
    if (flip.to !== "refuse") {
      for (const s of ["hold_floor", "market", "premium", "escalate"] as const) {
        if (has(`opt_${s}`)) return `opt_${s}`;
      }
    }
  }

  const others = quote.candidates
    .filter((c) => `opt_${c.strategy}` !== chosenId)
    .sort((a, b) => b.expected_net_cents - a.expected_net_cents);
  for (const c of others) {
    const id = `opt_${c.strategy}`;
    if (has(id)) return id;
  }
  return null;
}

function buildFlipCondition(quote: PriceQuote, flip: FlipPoint | null): string {
  if (flip !== null) return flip.statement;
  return (
    `No value of measured visibility (0.00–1.00), shelf occupancy (0–${quote.slots_total + 2}) or publisher revenue share (0–98%) changes this choice, ` +
    `so this decision is INSENSITIVE to every input we can vary — read it as a weak decision, not a robust one.`
  );
}

function buildRationale(
  prospect: PricingProspect,
  publisher: Publisher,
  quote: PriceQuote,
  flip: FlipPoint | null,
  demand: { matched: string[]; offTarget: boolean },
  calibration: { weight: number; n: number },
  lookup: DemandLookup | null,
  visibility: number,
): string {
  const parts: string[] = [];

  if (quote.outcome === "refused_unprofitable_publisher") {
    parts.push(
      `REFUSED. ${publisher.domain} takes ${Math.round((publisher.rev_share ?? 0) * 100)}% of placement revenue, which is at or above our whole gross margin once Stripe's ${STRIPE_PCT * 100}% + ${money(STRIPE_FIXED_CENTS)} comes out. No price clears a ${money(MIN_NET_CENTS)} net — a higher price loses MORE money, not less. This is not a pricing problem, it is a supply deal that should be renegotiated before anything is sold on it.`,
    );
  } else if (quote.outcome === "refused_below_floor") {
    parts.push(
      `REFUSED. The most ${prospect.name} will be asked is ${money(quote.ceiling_cents)}, and the least this placement is worth processing for on ${publisher.domain} is ${money(quote.floor_cents)}. Selling into that gap books a transaction and loses money on it, and it enters a below-cost comparable that caps every later quote on this publisher. Turning down ${money(quote.ceiling_cents)} of gross today is cheaper than that.`,
    );
  } else if (quote.outcome === "escalated_to_human") {
    parts.push(
      `ESCALATED, not quoted. Expected net contribution peaks at ${money(quote.proposed_price_cents)}, which is above this agent's ${money(AUTONOMY_LIMIT_CENTS)} authority limit. The number is defensible; committing to it unilaterally is not. A person signs before anything reaches ${prospect.name}.`,
    );
  } else {
    parts.push(
      `Quote ${money(quote.price_cents)} on the "${quote.strategy}" strategy. Band is ${money(quote.floor_cents)} (break-even at a ${Math.round((publisher.rev_share ?? 0) * 100)}% revenue share) to ${money(quote.ceiling_cents)} (this buyer's ceiling), and ${money(quote.price_cents)} sits ${Math.round(quote.market_position * 100)}% up it.`,
    );
    parts.push(
      `That price closes with probability ~${Math.round(quote.close_probability * 100)}% for an expected net of ${money(quote.expected_net_cents)} — higher than every other strategy on the table, which is the whole reason it won. Asking less closes more often and nets less; asking more nets more per close and loses the sale often enough to be worse.`,
    );
  }

  parts.push(
    `Inputs: measured visibility ${visibility.toFixed(2)} (pain ×${quote.pain_multiplier.toFixed(2)} at ${Math.round(quote.confidence * 100)}% sample confidence), category demand ×${quote.demand_multiplier.toFixed(2)}${demand.offTarget ? " (OFF-TARGET — no category overlap, discounted)" : ` on [${demand.matched.join(", ")}]`}, shelf ${quote.slots_used}/${quote.slots_total} (scarcity ×${quote.scarcity_multiplier.toFixed(2)})${quote.at_capacity ? ", AT CAPACITY so the floor rises to the dearest incumbent — a sixth entry dilutes the five that already paid" : ""}.`,
  );

  if (lookup === null) {
    parts.push(
      "Category demand came from the built-in prior, not a live source, so that input could not have surprised this agent.",
    );
  }
  if (calibration.weight === 0) {
    parts.push(
      "The close-probability curve is uncalibrated — no quote has been accepted or refused yet. If this price is wrong, that is the most likely reason.",
    );
  } else {
    parts.push(
      `Close probability is calibrated against ${calibration.n} observed outcomes at weight ${calibration.weight.toFixed(2)}.`,
    );
  }
  if (flip === null) {
    parts.push(
      "Nothing we can vary flips this choice, which means the inputs were not close to any boundary.",
    );
  }
  return parts.join(" ");
}

function buildEffect(quote: PriceQuote, publisher: Publisher, flags: RunFlags): string {
  const live = flags?.liveServe === true;
  switch (quote.outcome) {
    case "sell":
      return live
        ? `Emitted a binding ${money(quote.price_cents)} quote for ${publisher.domain}; the Payment Link is created downstream by the Stripe integration, not by this agent.`
        : `DRY RUN — would have emitted a ${money(quote.price_cents)} quote for ${publisher.domain}. No payment link requested, nothing charged.`;
    case "escalated_to_human":
      return `No quote issued. ${money(quote.proposed_price_cents)} is proposed to a human for approval; the advertiser has not been contacted with a number.`;
    case "refused_below_floor":
      return `No quote issued. The slot on ${publisher.domain} stays open and the advertiser is told we cannot serve them at their budget.`;
    case "refused_unprofitable_publisher":
      return `No quote issued at any price. Flagged ${publisher.domain}'s revenue share for renegotiation before further inventory is sold on it.`;
  }
}

const slug = (s: string): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";

// ─────────────────────────────────────────────────────────────────────────────
// Handoff to the payment workstream
//
// This agent decides the number. It does not call Stripe. This is the whole of
// the interface between the two, kept deliberately small: an amount, a currency,
// a description, and the metadata that lets a charge be tied back to the exact
// decision that produced it.
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentLinkRequest {
  amount_cents: number;
  currency: "usd";
  description: string;
  metadata: Record<string, string>;
}

/**
 * `null` whenever there is nothing to charge — refusal, escalation, or a dry
 * run that never produced a price. Returning `null` rather than a zero-amount
 * request is deliberate: a $0 payment link is a live link, and the downstream
 * integration must be forced to handle "no sale" rather than fall into it.
 */
export function paymentLinkRequest(
  result: PricingResult,
  prospect: PricingProspect,
  publisher: Publisher,
): PaymentLinkRequest | null {
  if (result.priceCents === null || result.priceCents <= 0) return null;
  return {
    amount_cents: result.priceCents,
    currency: "usd",
    description: `AdLayer sponsored placement — ${prospect.name} on ${publisher.domain}`,
    metadata: {
      adlayer_decision_id: result.decision.id,
      adlayer_decision_hash: result.decision.entry_hash,
      adlayer_prospect_id: prospect.id,
      adlayer_publisher_id: publisher.id,
      adlayer_strategy: result.quote.strategy,
      adlayer_floor_cents: String(result.quote.floor_cents),
      adlayer_publisher_share_cents: String(result.quote.publisher_share_cents),
    },
  };
}

/** Human-readable working, for the dashboard and the demo. */
export function describeQuote(result: PricingResult): string {
  const q = result.quote;
  const out: string[] = [];
  out.push(`PRICING — ${q.outcome.toUpperCase().replace(/_/g, " ")}`);
  out.push("─".repeat(72));
  out.push(
    q.price_cents !== null
      ? `  price      ${money(q.price_cents)}  (${q.strategy})`
      : q.proposed_price_cents !== null
        ? `  price      ${money(q.proposed_price_cents)} PROPOSED, not quoted  (${q.strategy})`
        : `  price      no sale  (${q.strategy})`,
  );
  out.push(
    `  band       floor ${money(q.floor_cents)} · WTP ${money(q.wtp_cents)} · ceiling ${money(q.ceiling_cents)}`,
  );
  out.push(
    `  drivers    pain ×${q.pain_multiplier.toFixed(2)} · demand ×${q.demand_multiplier.toFixed(2)} · scarcity ×${q.scarcity_multiplier.toFixed(2)} · size ×${q.size_multiplier.toFixed(2)}`,
  );
  out.push(`  shelf      ${q.slots_used}/${q.slots_total}${q.at_capacity ? " AT CAPACITY" : ""}${q.off_target ? " · OFF-TARGET" : ""}`);
  if (q.price_cents !== null) {
    out.push(
      `  economics  publisher ${money(q.publisher_share_cents)} · stripe ${money(q.stripe_fee_cents)} · adlayer ${money(q.net_to_adlayer_cents)} · P(close) ${Math.round(q.close_probability * 100)}% · E[net] ${money(q.expected_net_cents)}`,
    );
  }
  out.push("");
  out.push("  CONSIDERED");
  for (const c of q.candidates) {
    const mark = `opt_${c.strategy}` === result.decision.chosen_option_id ? "→" : " ";
    out.push(
      `  ${mark} ${c.strategy.padEnd(17)} ${(c.price_cents === null ? "—" : money(c.price_cents)).padStart(10)}  P ${String(Math.round(c.close_probability * 100)).padStart(3)}%  E[net] ${money(c.expected_net_cents).padStart(9)}`,
    );
  }
  out.push("");
  out.push(`  WRONG IF   ${result.decision.flip_condition}`);
  return out.join("\n");
}
