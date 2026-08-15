/**
 * ADLAYER — Pricing agent tests.
 *
 * Written from the position of the panel, not the builder. The question these
 * tests answer is not "does it return a number" — it is "is there a decision
 * here at all, and could it have come out differently."
 *
 * The seven facts this file exists to prove:
 *
 *   1. The price MOVES with the inputs. A prospect we measured as invisible is
 *      priced above one that already surfaces; a scarce shelf is priced above an
 *      empty one; off-target inventory is discounted. Hardcoding the output
 *      would change all three.
 *   2. The agent REFUSES revenue. Below the floor it walks away, and it walks
 *      away at every price when the publisher's revenue share exceeds our
 *      margin. This is the clearest evidence the decision is real.
 *   3. The floor is a CONSTRAINT, not a preference. `sell_below_floor` is put on
 *      the record fully costed, can carry the highest expected value on the
 *      board, and still cannot be chosen.
 *   4. The agent knows the limit of its own authority and escalates past it
 *      rather than committing.
 *   5. Every price carries a logged rationale, a derived falsifier that names a
 *      DIFFERENT option, and evidence — and the decision log's own auditor
 *      grades the entries `decision`, not `rubber_stamp`. We run their check
 *      against ourselves rather than asserting our own good behaviour.
 *   6. It is not a constant function. Across a realistic scenario suite it
 *      reaches at least three distinct choices, which is the check
 *      `summarize()` would otherwise fire on us.
 *   7. It degrades and does not throw: no API key, garbage inputs, dry run by
 *      default, and no byte written to disk unless a path was named.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Publisher, RunFlags } from "../../contract.ts";
import {
  MIN_RATIONALE_CHARS,
  auditEntry,
  computeStats,
  openDecisionLog,
  verifyChain,
  type DecisionEntry,
  type DecisionSink,
} from "../decision-log.ts";
import {
  AUTONOMY_LIMIT_CENTS,
  BASE_PLACEMENT_CENTS,
  CATEGORY_DEMAND,
  CEILING_OVER_WTP,
  HARD_FLOOR_CENTS,
  MAX_SLOTS_PER_PUBLISHER,
  MIN_NET_CENTS,
  MIN_QUERIES_FOR_CONFIDENCE,
  OFF_TARGET_MULTIPLIER,
  SELECTABLE_STRATEGIES,
  STRIPE_FIXED_CENTS,
  STRIPE_PCT,
  calibrationFromOutcomes,
  closeProbability,
  computeQuote,
  defaultDemandLookup,
  demandMultiplier,
  describeQuote,
  findFlip,
  floorFor,
  netToAdLayer,
  painMultiplier,
  paymentLinkRequest,
  price,
  pricePlacement,
  scarcityMultiplier,
  stripeFee,
  type DemandFn,
  type InvisibilityScore,
  type PricingProspect,
  type PricingResult,
  type QuoteInput,
  type ShelfPlacement,
} from "../pricing.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Scratch space
// ─────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "adlayer-pricing-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DRY: RunFlags = { liveServe: false, liveMeasure: false, liveStudy: false };
const LIVE: RunFlags = { liveServe: true, liveMeasure: false, liveStudy: false };
const NOW = new Date("2026-08-15T15:00:00.000Z");
const clock = (): Date => NOW;

/** No live demand source. Forces the built-in prior, deterministically. */
const noDemand: DemandFn = async () => null;

function publisher(over: Partial<Publisher> = {}): Publisher {
  return {
    id: "pub_dental",
    domain: "dentalguide.example",
    integration: "hosted",
    categories: ["healthcare", "dentistry"],
    rev_share: 0.5,
    verified_at: "2026-08-15T10:00:00.000Z",
    ...over,
  };
}

function prospect(over: Partial<PricingProspect> = {}): PricingProspect {
  return {
    id: "adv_smile",
    name: "Smile Studio",
    domain: "smilestudio.example",
    categories: ["dentistry"],
    stated_budget_cents: null,
    size: "smb",
    ...over,
  };
}

function score(visibility: number, totalQueries = 30): InvisibilityScore {
  return {
    visibility,
    cited_queries: Math.round(visibility * totalQueries),
    total_queries: totalQueries,
  };
}

function shelf(n: number, publisherId = "pub_dental", from = 5000): ShelfPlacement[] {
  return Array.from({ length: n }, (_, i) => ({
    publisher_id: publisherId,
    price_cents: from + i * 100,
  }));
}

/** Every quote in these tests runs against a real, chained decision log. */
function freshLog(): DecisionSink {
  return openDecisionLog({ now: clock, logger: () => {} });
}

function quoteInput(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    base_cents: BASE_PLACEMENT_CENTS,
    visibility: 0.1,
    total_queries: 30,
    size_multiplier: 1.5,
    stated_budget_cents: null,
    demand_multiplier: 1.5,
    off_target: false,
    rev_share: 0.5,
    slots_used: 0,
    slots_total: MAX_SLOTS_PER_PUBLISHER,
    incumbent_max_cents: null,
    wtp_calibration: 1,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The economics — the floor is derived, not declared
// ─────────────────────────────────────────────────────────────────────────────

describe("unit economics", () => {
  it("charges the accounting identity: price = publisher share + stripe fee + our net", () => {
    for (const p of [500, 2000, 4900, 15000, 250000]) {
      for (const r of [0, 0.3, 0.5, 0.7, 0.9]) {
        const share = Math.round(p * r);
        const fee = stripeFee(p);
        assert.equal(share + fee + netToAdLayer(p, r), p, `${p} @ ${r}`);
      }
    }
  });

  it("derives a floor that actually clears the minimum net, and one cent below it does not", () => {
    for (const r of [0, 0.25, 0.5, 0.7, 0.8, 0.9]) {
      const floor = floorFor(r);
      assert.ok(Number.isFinite(floor), `floor should exist at rev_share ${r}`);
      assert.ok(
        netToAdLayer(floor, r) >= MIN_NET_CENTS,
        `floor ${floor} at rev_share ${r} nets ${netToAdLayer(floor, r)}, under ${MIN_NET_CENTS}`,
      );
      // The floor is the LEAST such price, except where the hard floor binds.
      if (floor > HARD_FLOOR_CENTS) {
        assert.ok(
          netToAdLayer(floor - 1, r) < MIN_NET_CENTS,
          `floor ${floor} at rev_share ${r} is not tight`,
        );
      }
    }
  });

  it("moves the floor when the publisher's revenue share moves", () => {
    assert.ok(floorFor(0.85) > floorFor(0.5), "a greedier publisher must raise the floor");
    assert.ok(floorFor(0.5) > floorFor(0.1));
  });

  it("never returns a floor below the hard floor, however generous the publisher", () => {
    assert.equal(floorFor(0), Math.max(HARD_FLOOR_CENTS, floorFor(0)));
    assert.ok(floorFor(0) >= HARD_FLOOR_CENTS);
  });

  it("returns an INFINITE floor when the revenue share eats the whole margin", () => {
    // Past 1 - STRIPE_PCT there is no price at which the deal is not a loss, and
    // a larger price is a larger loss. That is a fact about the supply deal.
    assert.equal(floorFor(1 - STRIPE_PCT), Number.POSITIVE_INFINITY);
    assert.equal(floorFor(0.98), Number.POSITIVE_INFINITY);
    assert.equal(floorFor(1), Number.POSITIVE_INFINITY);
  });

  it("charges Stripe's real published fee, because the floor is derived from it", () => {
    assert.equal(stripeFee(10000), Math.round(10000 * STRIPE_PCT) + STRIPE_FIXED_CENTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three signals
// ─────────────────────────────────────────────────────────────────────────────

describe("pain, scarcity and demand", () => {
  it("prices invisibility as pain, and full visibility as none", () => {
    assert.ok(painMultiplier(score(0.0)).pain > painMultiplier(score(0.5)).pain);
    assert.ok(painMultiplier(score(0.5)).pain > painMultiplier(score(1.0)).pain);
    assert.equal(painMultiplier(score(1.0)).pain, 1);
  });

  it("discounts a visibility number measured over too few queries", () => {
    // Zero visibility over two queries is not the same fact as over thirty, and
    // pricing off the first as though it were the second is a horoscope.
    const thin = painMultiplier(score(0, 2));
    const thick = painMultiplier(score(0, MIN_QUERIES_FOR_CONFIDENCE));
    assert.ok(thin.pain < thick.pain);
    assert.equal(thick.confidence, 1);
    assert.ok(thin.confidence < 0.2);
  });

  it("treats a zero-query measurement as carrying no information at all", () => {
    assert.equal(painMultiplier(score(0, 0)).pain, 1);
    assert.equal(painMultiplier(score(0, 0)).confidence, 0);
  });

  it("discounts an empty shelf and charges a premium for a full one", () => {
    const empty = scarcityMultiplier(0, 5);
    const half = scarcityMultiplier(2, 5);
    const nearly = scarcityMultiplier(4, 5);
    assert.ok(empty < 1, "the first advertiser is buying unproven inventory");
    assert.ok(half < nearly, "scarcity must rise as slots fill");
    assert.ok(nearly < scarcityMultiplier(5, 5));
  });

  it("reads demand off the intersection of advertiser and publisher categories", () => {
    const hit = demandMultiplier(["fintech"], ["fintech", "news"]);
    assert.equal(hit.offTarget, false);
    assert.deepEqual(hit.matched, ["fintech"]);
    assert.equal(hit.multiplier, CATEGORY_DEMAND["fintech"]);
  });

  it("flags and discounts inventory with no category overlap at all", () => {
    const miss = demandMultiplier(["fintech"], ["home_services"]);
    assert.equal(miss.offTarget, true);
    assert.deepEqual(miss.matched, []);
    assert.ok(miss.multiplier < (CATEGORY_DEMAND["fintech"] ?? 1));
    assert.equal(miss.multiplier, (CATEGORY_DEMAND["fintech"] ?? 1) * OFF_TARGET_MULTIPLIER);
  });

  it("normalises category spelling so a hyphen does not lose a match", () => {
    assert.equal(demandMultiplier(["Home Services"], ["home-services"]).offTarget, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The close-probability curve — where the tradeoff lives
// ─────────────────────────────────────────────────────────────────────────────

describe("close probability", () => {
  it("is a coin flip at estimated willingness to pay", () => {
    assert.ok(Math.abs(closeProbability(5000, 5000, null) - 0.5) < 1e-9);
  });

  it("falls monotonically as the ask rises", () => {
    let previous = 1;
    for (let ask = 1000; ask <= 12000; ask += 500) {
      const p = closeProbability(ask, 5000, null);
      assert.ok(p < previous, `P(close) must fall with price at ${ask}`);
      previous = p;
    }
  });

  it("treats a STATED budget as a wall, not a curve", () => {
    // A buyer who told us $40 does not close at $60 with probability 0.05. They
    // close with probability 0, and an agent that softens that talks itself into
    // a quote nobody accepts.
    assert.equal(closeProbability(6000, 5000, 4000), 0);
    assert.ok(closeProbability(4000, 5000, 4000) > 0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Calibration — the path off the model prior
// ─────────────────────────────────────────────────────────────────────────────

describe("calibration against observed outcomes", () => {
  it("does nothing on fewer than three observations", () => {
    const out = calibrationFromOutcomes([{ price_cents: 9000, closed: true }], 5000);
    assert.equal(out.wtp_cents, 5000);
    assert.equal(out.weight, 0);
  });

  it("brackets willingness to pay between the dearest close and the cheapest loss", () => {
    const out = calibrationFromOutcomes(
      [
        { price_cents: 4000, closed: true },
        { price_cents: 6000, closed: true },
        { price_cents: 9000, closed: false },
        { price_cents: 12000, closed: false },
      ],
      5000,
    );
    assert.ok(out.weight > 0);
    // Bracket midpoint is (6000 + 9000) / 2 = 7500, blended above the 5000 prior.
    assert.ok(out.wtp_cents > 5000 && out.wtp_cents < 7500);
  });

  it("reads an unbroken run of closes as evidence we are asking too little", () => {
    const closes = [3000, 3500, 4000, 4500].map((p) => ({ price_cents: p, closed: true }));
    assert.ok(calibrationFromOutcomes(closes, 4000).wtp_cents > 4000);
  });

  it("reads an unbroken run of refusals as evidence we are asking too much", () => {
    const losses = [9000, 9500, 10000, 11000].map((p) => ({ price_cents: p, closed: false }));
    assert.ok(calibrationFromOutcomes(losses, 9000).wtp_cents < 9000);
  });

  it("caps how far a handful of data points may move the estimate", () => {
    const many = Array.from({ length: 50 }, () => ({ price_cents: 100000, closed: true }));
    assert.ok(calibrationFromOutcomes(many, 5000).weight <= 0.6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FLOOR IS A CONSTRAINT, NOT A PREFERENCE
//
// This is the section that decides whether "the agent can refuse to sell below
// the floor" is a structural fact or a hope about the arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

describe("the floor as a hard constraint", () => {
  it("refuses the below-floor deal even when it carries the highest expected value on the board", () => {
    // Stated budget beneath the floor. Taking their number closes at nearly 100%
    // and nets real money — it is the highest-EV thing on the table — and it
    // still cannot be chosen, because a floor that yields to a good enough
    // expected value is not a floor.
    const quote = computeQuote(quoteInput({ stated_budget_cents: 400 }));
    const belowFloor = quote.candidates.find((c) => c.strategy === "sell_below_floor");

    assert.ok(belowFloor !== undefined, "the refused deal must be on the record");
    assert.ok(belowFloor.expected_net_cents > 0, "and it must be genuinely tempting");
    const best = Math.max(...quote.candidates.map((c) => c.expected_net_cents));
    assert.equal(belowFloor.expected_net_cents, best, "it is the highest-EV option here");

    assert.equal(quote.strategy, "refuse");
    assert.equal(quote.price_cents, null);
    assert.equal(quote.outcome, "refused_below_floor");
  });

  it("keeps `sell_below_floor` out of the selectable set entirely", () => {
    assert.ok(!SELECTABLE_STRATEGIES.includes("sell_below_floor"));
  });

  it("never quotes beneath the floor across a wide sweep of inputs", () => {
    let sold = 0;
    let refused = 0;
    for (const visibility of [0, 0.15, 0.5, 0.9, 1]) {
      for (const rev_share of [0, 0.2, 0.5, 0.7, 0.85, 0.95, 0.99]) {
        for (const slots_used of [0, 1, 3, 5, 7]) {
          for (const size_multiplier of [0.6, 1, 2.5, 4]) {
            for (const stated_budget_cents of [null, 300, 2500, 40000]) {
              const q = computeQuote(
                quoteInput({ visibility, rev_share, slots_used, size_multiplier, stated_budget_cents }),
              );
              if (q.price_cents === null) {
                refused += 1;
                continue;
              }
              sold += 1;
              assert.ok(Number.isFinite(q.price_cents), "a quote must be a finite number");
              assert.ok(
                q.price_cents >= q.floor_cents,
                `quoted ${q.price_cents} under floor ${q.floor_cents}`,
              );
              assert.ok(q.price_cents >= HARD_FLOOR_CENTS);
              assert.ok(
                netToAdLayer(q.price_cents, rev_share) >= MIN_NET_CENTS,
                "every sale must clear the minimum net",
              );
            }
          }
        }
      }
    }
    // A sweep where nothing sells, or nothing is refused, would prove nothing.
    assert.ok(sold > 100, `expected many sales in the sweep, got ${sold}`);
    assert.ok(refused > 20, `expected many refusals in the sweep, got ${refused}`);
  });

  it("refuses at EVERY price when the publisher's share exceeds our whole margin", () => {
    for (const budget of [null, 1000, 50000, 10_000_000]) {
      const q = computeQuote(quoteInput({ rev_share: 0.98, stated_budget_cents: budget }));
      assert.equal(q.outcome, "refused_unprofitable_publisher");
      assert.equal(q.price_cents, null);
      assert.equal(q.floor_cents, Number.POSITIVE_INFINITY);
    }
  });

  it("raises the floor to the dearest incumbent once the shelf is full", () => {
    // A sixth entry dilutes the five that already paid. Selling that dilution
    // for less than the dearest incumbent paid is value destruction wearing a
    // revenue number.
    const full = computeQuote(
      quoteInput({ slots_used: 5, slots_total: 5, incumbent_max_cents: 9000, size_multiplier: 4 }),
    );
    assert.equal(full.at_capacity, true);
    assert.ok(full.floor_cents >= 9000);
    if (full.price_cents !== null) assert.ok(full.price_cents >= 9000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The derived falsifier
// ─────────────────────────────────────────────────────────────────────────────

describe("the falsifier is derived, not written", () => {
  it("finds an input value that genuinely flips the choice, and re-running proves it", () => {
    const input = quoteInput({ visibility: 0.05, slots_used: 4 });
    const flip = findFlip(input);
    assert.ok(flip !== null, "a decision with no falsifier anywhere is not a decision");

    const before = computeQuote(input).strategy;
    const axisField = {
      visibility: "visibility",
      occupancy: "slots_used",
      rev_share: "rev_share",
      stated_budget: "stated_budget_cents",
    }[flip.axis];
    const after = computeQuote({ ...input, [axisField]: flip.threshold } as QuoteInput).strategy;

    assert.equal(before, flip.from);
    assert.equal(after, flip.to);
    assert.notEqual(after, before, "the stated flip must actually flip the choice");
  });

  it("states the falsifier in the same units as the evidence", () => {
    const flip = findFlip(quoteInput({ stated_budget_cents: 400 }));
    assert.ok(flip !== null);
    assert.match(flip.statement, /\d/, "a falsifier without a number cannot be checked");
    assert.ok(flip.statement.length > 40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REQUIRED CASES — price(), end to end, with a real decision log
// ─────────────────────────────────────────────────────────────────────────────

describe("price() — the money decision", () => {
  it("prices a measurably invisible prospect above a visible one", async () => {
    const log = freshLog();
    const invisible = await price(
      prospect({ id: "adv_invisible", name: "Invisible Dental" }),
      score(0.03),
      publisher(),
      DRY,
      { log, demandFn: noDemand, now: clock },
    );
    const visible = await price(
      prospect({ id: "adv_visible", name: "Already Everywhere" }),
      score(0.9),
      publisher(),
      DRY,
      { log, demandFn: noDemand, now: clock },
    );

    assert.ok(invisible.priceCents !== null && visible.priceCents !== null);
    assert.ok(
      invisible.priceCents > visible.priceCents,
      `invisible ${invisible.priceCents} should price above visible ${visible.priceCents}`,
    );
    // And for the stated reason, not a coincidence of another input.
    assert.ok(invisible.quote.pain_multiplier > visible.quote.pain_multiplier);
    assert.ok(invisible.quote.wtp_cents > visible.quote.wtp_cents);
  });

  it("prices the same prospect higher on a scarce shelf than an empty one", async () => {
    const log = freshLog();
    const empty = await price(prospect({ id: "adv_a" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
      shelf: [],
    });
    const scarce = await price(prospect({ id: "adv_b" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
      shelf: shelf(4),
    });

    assert.ok(empty.priceCents !== null && scarce.priceCents !== null);
    assert.ok(
      scarce.priceCents > empty.priceCents,
      `4/5 shelf (${scarce.priceCents}) must price above an empty one (${empty.priceCents})`,
    );
    assert.ok(scarce.quote.scarcity_multiplier > empty.quote.scarcity_multiplier);
    assert.equal(empty.quote.slots_used, 0);
    assert.equal(scarce.quote.slots_used, 4);
  });

  it("REFUSES the sale when the buyer's ceiling is beneath the floor", async () => {
    const log = freshLog();
    const result = await price(
      prospect({ id: "adv_broke", name: "Tight Budget Dental", stated_budget_cents: 400 }),
      score(0.05),
      publisher(),
      DRY,
      { log, demandFn: noDemand, now: clock },
    );

    assert.equal(result.priceCents, null, "no price is emitted");
    assert.equal(result.quote.outcome, "refused_below_floor");
    assert.ok(result.quote.ceiling_cents < result.quote.floor_cents);

    // The refusal must be a decision, not an omission: the deal we turned down
    // has to be on the record, priced, next to the reason we turned it down.
    const refused = result.decision.options.find((o) => o.id === "opt_sell_below_floor");
    assert.ok(refused !== undefined, "the refused deal must be logged as an option");
    assert.match(refused.expected_outcome, /\$/);
    assert.equal(result.decision.chosen_option_id, "opt_refuse");
    assert.equal(auditEntry(result.decision).strength, "decision");

    // And nothing downstream can accidentally charge a refusal.
    assert.equal(paymentLinkRequest(result, prospect(), publisher()), null);
  });

  it("REFUSES at any price when the publisher's revenue share exceeds our margin", async () => {
    const log = freshLog();
    const result = await price(
      prospect({ id: "adv_rich", size: "enterprise", stated_budget_cents: 5_000_00 }),
      score(0.0),
      publisher({ id: "pub_greedy", rev_share: 0.98 }),
      DRY,
      { log, demandFn: noDemand, now: clock, shelf: [] },
    );

    assert.equal(result.priceCents, null);
    assert.equal(result.quote.outcome, "refused_unprofitable_publisher");
    assert.match(result.decision.rationale, /renegotiat/i);
    assert.equal(auditEntry(result.decision).strength, "decision");
  });

  it("escalates rather than committing a price above its own authority", async () => {
    const log = freshLog();
    const result = await price(
      prospect({ id: "adv_big", name: "Northgate Capital", categories: ["fintech"], size: "enterprise" }),
      score(0.02),
      publisher({ id: "pub_fin", domain: "fintechreads.example", categories: ["fintech"] }),
      DRY,
      { log, demandFn: noDemand, now: clock, shelf: shelf(4, "pub_fin") },
    );

    assert.equal(result.quote.outcome, "escalated_to_human");
    assert.equal(result.priceCents, null, "an escalation is not a quote");
    assert.ok(result.quote.proposed_price_cents !== null);
    assert.ok(result.quote.proposed_price_cents > AUTONOMY_LIMIT_CENTS);
    assert.equal(result.decision.chosen_option_id, "opt_escalate");
    assert.match(result.decision.effect, /has not been contacted/i);
    // Nothing may be charged on an escalation either.
    assert.equal(paymentLinkRequest(result, prospect(), publisher()), null);
  });

  it("discounts inventory with no category overlap", async () => {
    const log = freshLog();
    const onTarget = await price(prospect({ id: "adv_on" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
    });
    const offTarget = await price(
      prospect({ id: "adv_off", categories: ["nonprofit"] }),
      score(0.05),
      publisher(),
      DRY,
      { log, demandFn: noDemand, now: clock },
    );

    assert.equal(offTarget.quote.off_target, true);
    assert.equal(onTarget.quote.off_target, false);
    assert.ok(onTarget.priceCents !== null && offTarget.priceCents !== null);
    assert.ok(offTarget.priceCents < onTarget.priceCents);
  });

  it("moves the price when real quote outcomes are supplied", async () => {
    const log = freshLog();
    const uncalibrated = await price(prospect({ id: "adv_u" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
    });
    const calibrated = await price(prospect({ id: "adv_c" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
      outcomes: [
        { price_cents: 12000, closed: true, ref: "ch_1" },
        { price_cents: 13000, closed: true, ref: "ch_2" },
        { price_cents: 14000, closed: true, ref: "ch_3" },
        { price_cents: 15000, closed: true, ref: "ch_4" },
      ],
    });

    assert.ok(uncalibrated.priceCents !== null && calibrated.priceCents !== null);
    assert.ok(
      calibrated.priceCents > uncalibrated.priceCents,
      "four closes well above our asking price should raise the next quote",
    );
    // And the evidence stops being a prior once there is something to fit.
    const curve = calibrated.decision.evidence.find((e) => e.id === "ev_close_curve");
    assert.equal(curve?.source, "measurement");
    const priorCurve = uncalibrated.decision.evidence.find((e) => e.id === "ev_close_curve");
    assert.equal(priorCurve?.source, "model_prior");
  });

  it("is exported under the name the decision-log fixtures use", () => {
    assert.equal(pricePlacement, price);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVERY PRICE CARRIES A LOGGED RATIONALE
//
// Run the decision log's OWN auditor against our entries. Asserting our good
// behaviour with our own assertions would prove less.
// ─────────────────────────────────────────────────────────────────────────────

interface Scenario {
  label: string;
  result: PricingResult;
}

async function scenarioSuite(log: DecisionSink): Promise<Scenario[]> {
  const run = async (
    label: string,
    p: PricingProspect,
    s: InvisibilityScore,
    pub: Publisher,
    opts: Parameters<typeof price>[4] = {},
  ): Promise<Scenario> => ({
    label,
    result: await price(p, s, pub, DRY, { log, demandFn: noDemand, now: clock, ...opts }),
  });

  return [
    await run("invisible smb, empty shelf", prospect({ id: "s1" }), score(0.03), publisher()),
    await run("visible smb, empty shelf", prospect({ id: "s2" }), score(0.9), publisher()),
    await run("invisible smb, scarce shelf", prospect({ id: "s3" }), score(0.03), publisher(), {
      shelf: shelf(4),
    }),
    await run("invisible smb, shelf at capacity", prospect({ id: "s4" }), score(0.03), publisher(), {
      shelf: shelf(5, "pub_dental", 6000),
    }),
    await run(
      "budget beneath the floor",
      prospect({ id: "s5", stated_budget_cents: 400 }),
      score(0.03),
      publisher(),
    ),
    await run("unprofitable publisher", prospect({ id: "s6" }), score(0.03), publisher({ rev_share: 0.98 })),
    await run(
      "enterprise fintech, scarce shelf",
      prospect({ id: "s7", categories: ["fintech"], size: "enterprise" }),
      score(0.02),
      publisher({ id: "pub_fin", domain: "fintechreads.example", categories: ["fintech"] }),
      { shelf: shelf(4, "pub_fin") },
    ),
    await run("off-target solo", prospect({ id: "s8", categories: ["nonprofit"], size: "solo" }), score(0.4), publisher()),
    await run("thin measurement, 2 queries", prospect({ id: "s9" }), score(0, 2), publisher()),
    await run("greedy but viable publisher", prospect({ id: "s10", size: "midmarket" }), score(0.05), publisher({ rev_share: 0.85 })),
  ];
}

describe("every decision is auditable by the log's own rules", () => {
  it("grades every entry a real decision, never a rubber stamp", async () => {
    const log = freshLog();
    const scenarios = await scenarioSuite(log);
    for (const { label, result } of scenarios) {
      const audit = auditEntry(result.decision);
      assert.equal(
        audit.strength,
        "decision",
        `${label} graded ${audit.strength}: ${audit.defects.join(", ")}`,
      );
      assert.deepEqual(audit.defects, [], label);
    }
  });

  it("carries a rationale, a falsifier and evidence on every single price", async () => {
    const log = freshLog();
    const scenarios = await scenarioSuite(log);
    for (const { label, result } of scenarios) {
      const d: DecisionEntry = result.decision;
      assert.equal(d.agent, "Pricing", label);
      assert.ok(d.rationale.trim().length >= MIN_RATIONALE_CHARS, `${label} rationale too thin`);
      assert.ok(d.flip_condition.trim().length > 0, `${label} has no falsifier`);
      assert.notEqual(d.flip_condition, d.rationale, `${label} falsifier restates the rationale`);
      assert.ok(d.evidence.length >= 4, `${label} evidence too thin`);
      assert.ok(
        d.evidence.some((e) => e.source === "measurement"),
        `${label} rests on nothing measured`,
      );
      assert.ok(
        d.evidence.some((e) => typeof e.ref === "string" && e.ref.trim() !== ""),
        `${label} has no evidence a reader can open`,
      );
      assert.ok(d.options.length >= 2, `${label} offered no fork`);
      assert.ok(d.context.includes("pricing.ts"), label);
    }
  });

  it("always points the falsifier at a DIFFERENT option that the entry actually lists", async () => {
    const log = freshLog();
    const scenarios = await scenarioSuite(log);
    for (const { label, result } of scenarios) {
      const d = result.decision;
      assert.ok(d.flip_to_option_id !== null, `${label} falsifier names no alternative`);
      assert.notEqual(d.flip_to_option_id, d.chosen_option_id, label);
      assert.ok(
        d.options.some((o) => o.id === d.flip_to_option_id),
        `${label} flips to "${String(d.flip_to_option_id)}", which is not one of its options`,
      );
    }
  });

  it("gives every option a distinct predicted outcome, so the options are not decoration", async () => {
    const log = freshLog();
    const scenarios = await scenarioSuite(log);
    for (const { label, result } of scenarios) {
      const outcomes = new Set(result.decision.options.map((o) => o.expected_outcome));
      assert.equal(outcomes.size, result.decision.options.length, `${label} has duplicate outcomes`);
      for (const o of result.decision.options) {
        assert.ok(o.expected_outcome.length > 40, `${label}/${o.id} outcome too thin`);
      }
    }
  });

  it("is not a constant function — it reaches several different choices", async () => {
    const log = freshLog();
    await scenarioSuite(log);
    const stats = computeStats(log.entries());
    const pricing = stats.by_agent.find((a) => a.agent === "Pricing");
    assert.ok(pricing !== undefined);
    assert.ok(
      pricing.distinct_choices >= 3,
      `Pricing made ${pricing.total} decisions with only ${pricing.distinct_choices} distinct choice(s) — that is a constant function wearing a costume`,
    );
    assert.equal(pricing.rubber_stamps, 0);
    // The warning the summary would fire on a constant-function agent must not fire.
    assert.ok(!stats.warnings.some((w) => w.includes("constant function")), stats.warnings.join("; "));
  });

  it("writes a chain that verifies across a whole run", async () => {
    const log = freshLog();
    await scenarioSuite(log);
    const chain = verifyChain(log.entries());
    assert.equal(chain.ok, true, chain.detail ?? "");
    assert.equal(chain.entries_checked, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No unlogged prices
// ─────────────────────────────────────────────────────────────────────────────

describe("no price without a record", () => {
  it("refuses to return a number when the log will not accept the decision", async () => {
    const log = freshLog();
    const args = [prospect(), score(0.05), publisher(), DRY] as const;
    await price(...args, { log, demandFn: noDemand, now: clock, decisionId: "dec_fixed" });
    // Same id twice: the ledger rejects it, and a price whose reasoning was not
    // recorded must never reach the caller.
    await assert.rejects(
      () => price(...args, { log, demandFn: noDemand, now: clock, decisionId: "dec_fixed" }),
      /duplicate entry id/,
    );
    assert.equal(log.entries().length, 1);
  });

  it("records the price and the decision hash on the payment link handoff", async () => {
    const log = freshLog();
    const p = prospect();
    const pub = publisher();
    const result = await price(p, score(0.05), pub, DRY, { log, demandFn: noDemand, now: clock });
    const request = paymentLinkRequest(result, p, pub);

    assert.ok(request !== null);
    assert.equal(request.amount_cents, result.priceCents);
    assert.equal(request.currency, "usd");
    assert.equal(request.metadata["adlayer_decision_id"], result.decision.id);
    assert.equal(request.metadata["adlayer_decision_hash"], result.decision.entry_hash);
    assert.equal(request.metadata["adlayer_publisher_id"], pub.id);
    assert.match(request.description, /Smile Studio/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety posture
// ─────────────────────────────────────────────────────────────────────────────

describe("safety posture", () => {
  it("is dry run by default: nothing is executed and nothing is written to disk", async () => {
    const dir = scratch();
    const before = readdirSync(dir);
    const log = openDecisionLog({ now: clock, logger: () => {} });
    const result = await price(prospect(), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
    });

    assert.equal(log.path, null, "a log with no path must not touch disk");
    assert.equal(result.decision.executed, false);
    assert.match(result.decision.effect, /DRY RUN/);
    assert.deepEqual(readdirSync(dir), before);
  });

  it("marks a live sale executed, and never marks a refusal executed", async () => {
    const log = freshLog();
    const sale = await price(prospect({ id: "adv_live" }), score(0.05), publisher(), LIVE, {
      log,
      demandFn: noDemand,
      now: clock,
    });
    assert.equal(sale.decision.executed, true);

    const refusal = await price(
      prospect({ id: "adv_no", stated_budget_cents: 400 }),
      score(0.05),
      publisher(),
      LIVE,
      { log, demandFn: noDemand, now: clock },
    );
    assert.equal(refusal.decision.executed, false, "refusing money changes nothing outside the log");
  });

  it("runs keyless: no demand API key logs exactly one line and never throws", async () => {
    const url = process.env["ADLAYER_DEMAND_API_URL"];
    const key = process.env["ADLAYER_DEMAND_API_KEY"];
    delete process.env["ADLAYER_DEMAND_API_URL"];
    delete process.env["ADLAYER_DEMAND_API_KEY"];

    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const lookup = await defaultDemandLookup(["fintech"]);
      assert.equal(lookup, null, "no key means no live demand, not a throw");
      assert.equal(lines.length, 1, `expected one log line, got ${lines.length}`);
      assert.match(lines[0] ?? "", /no demand API key/);
    } finally {
      console.log = realLog;
      if (url !== undefined) process.env["ADLAYER_DEMAND_API_URL"] = url;
      if (key !== undefined) process.env["ADLAYER_DEMAND_API_KEY"] = key;
    }
  });

  it("degrades visibly: without a live demand source the evidence is labelled a prior", async () => {
    const log = freshLog();
    const degraded = await price(prospect({ id: "adv_d" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
    });
    const live = await price(prospect({ id: "adv_l" }), score(0.05), publisher(), DRY, {
      log,
      now: clock,
      demandFn: async () => ({
        table: { dentistry: 2.2 },
        source: "external_api" as const,
        ref: "https://demand.example/v1",
        observed_at: "2026-08-15T14:00:00.000Z",
      }),
    });

    assert.equal(degraded.decision.evidence.find((e) => e.id === "ev_demand")?.source, "model_prior");
    assert.equal(live.decision.evidence.find((e) => e.id === "ev_demand")?.source, "external_api");
    assert.match(degraded.decision.rationale, /built-in prior/);
    // A live source that says demand is higher must actually move the price.
    assert.ok(live.priceCents !== null && degraded.priceCents !== null);
    assert.ok(live.priceCents > degraded.priceCents);
  });

  it("survives a demand source that throws, and says so in one line", async () => {
    // There is exactly one throw path in this module and it is the decision log
    // refusing to record a price. A broken demand API is not it.
    const lines: string[] = [];
    const result = await price(prospect(), score(0.05), publisher(), DRY, {
      log: freshLog(),
      now: clock,
      logger: (m) => lines.push(m),
      demandFn: async () => {
        throw new Error("connection reset");
      },
    });
    assert.ok(result.priceCents !== null && Number.isFinite(result.priceCents));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /connection reset/);
    assert.equal(result.decision.evidence.find((e) => e.id === "ev_demand")?.source, "model_prior");
  });

  it("labels publisher terms as human input only when the publisher was actually verified", async () => {
    const log = freshLog();
    const verified = await price(prospect({ id: "adv_v" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
    });
    const seeded = await price(
      prospect({ id: "adv_s" }),
      score(0.05),
      publisher({ id: "pub_seed", verified_at: null }),
      DRY,
      { log, demandFn: noDemand, now: clock },
    );
    assert.equal(verified.decision.evidence.find((e) => e.id === "ev_revshare")?.source, "human_input");
    assert.equal(seeded.decision.evidence.find((e) => e.id === "ev_revshare")?.source, "fixture");
  });

  it("admits in the log when the price rests on a guess about the prospect's size", async () => {
    const log = freshLog();
    const unknown = await price(
      prospect({ id: "adv_unknown", size: null }),
      score(0.05),
      publisher(),
      DRY,
      { log, demandFn: noDemand, now: clock },
    );
    const known = await price(prospect({ id: "adv_known", size: "smb" }), score(0.05), publisher(), DRY, {
      log,
      demandFn: noDemand,
      now: clock,
    });
    assert.equal(unknown.decision.evidence.find((e) => e.id === "ev_size")?.source, "model_prior");
    assert.equal(known.decision.evidence.find((e) => e.id === "ev_size")?.source, "human_input");
    assert.match(unknown.decision.evidence.find((e) => e.id === "ev_size")?.claim ?? "", /guess/);
  });

  it("is deterministic for identical inputs", async () => {
    const args = () =>
      price(prospect({ id: "adv_det" }), score(0.137, 30), publisher(), DRY, {
        log: freshLog(),
        demandFn: noDemand,
        now: clock,
      });
    const a = await args();
    const b = await args();
    assert.equal(a.priceCents, b.priceCents);
    assert.equal(a.quote.floor_cents, b.quote.floor_cents);
    assert.equal(a.quote.strategy, b.quote.strategy);
    assert.equal(a.decision.rationale, b.decision.rationale);
  });

  it("does not mutate anything it was handed", async () => {
    const p = prospect();
    const s = score(0.05);
    const pub = publisher();
    const inventory = shelf(3);
    const snapshot = JSON.stringify({ p, s, pub, inventory, DRY });
    await price(p, s, pub, DRY, { log: freshLog(), demandFn: noDemand, now: clock, shelf: inventory });
    assert.equal(JSON.stringify({ p, s, pub, inventory, DRY }), snapshot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hostile and malformed input
//
// This agent is handed measurements from a network engine and publisher records
// from a JSON file. Both can be wrong. A pricing agent that emits NaN, or a
// negative charge, is worse than one that refuses.
// ─────────────────────────────────────────────────────────────────────────────

describe("malformed input", () => {
  const garbage: { label: string; score: InvisibilityScore; publisher: Publisher }[] = [
    {
      label: "NaN visibility",
      score: { visibility: Number.NaN, cited_queries: 0, total_queries: 30 },
      publisher: publisher(),
    },
    {
      label: "visibility above 1",
      score: { visibility: 42, cited_queries: 0, total_queries: 30 },
      publisher: publisher(),
    },
    {
      label: "negative query count",
      score: { visibility: 0.1, cited_queries: -5, total_queries: -30 },
      publisher: publisher(),
    },
    {
      label: "negative revenue share",
      score: score(0.1),
      publisher: publisher({ rev_share: -3 }),
    },
    {
      label: "revenue share above 1",
      score: score(0.1),
      publisher: publisher({ rev_share: 9 }),
    },
    {
      label: "Infinity revenue share",
      score: score(0.1),
      publisher: publisher({ rev_share: Number.POSITIVE_INFINITY }),
    },
  ];

  for (const g of garbage) {
    it(`emits a finite price or a refusal for ${g.label}, never NaN`, async () => {
      const result = await price(prospect({ id: `adv_${g.label.replace(/\W+/g, "")}` }), g.score, g.publisher, DRY, {
        log: freshLog(),
        demandFn: noDemand,
        now: clock,
      });
      if (result.priceCents !== null) {
        assert.ok(Number.isFinite(result.priceCents), `${g.label} produced ${result.priceCents}`);
        assert.ok(result.priceCents >= HARD_FLOOR_CENTS, g.label);
      }
      assert.ok(!Number.isNaN(result.quote.wtp_cents));
      assert.ok(result.decision.rationale.length >= MIN_RATIONALE_CHARS);
    });
  }

  it("handles a prospect with no categories at all", async () => {
    const result = await price(
      prospect({ id: "adv_nocat", categories: [] }),
      score(0.1),
      publisher(),
      DRY,
      { log: freshLog(), demandFn: noDemand, now: clock },
    );
    assert.equal(result.quote.off_target, true);
    assert.ok(result.priceCents === null || Number.isFinite(result.priceCents));
  });

  it("ignores shelf entries belonging to other publishers", async () => {
    const result = await price(prospect(), score(0.05), publisher(), DRY, {
      log: freshLog(),
      demandFn: noDemand,
      now: clock,
      shelf: [...shelf(4, "pub_somewhere_else"), ...shelf(1, "pub_dental")],
    });
    assert.equal(result.quote.slots_used, 1, "another publisher's shelf is not ours");
  });

  it("renders a human-readable working for any outcome", async () => {
    const log = freshLog();
    for (const { result } of await scenarioSuite(log)) {
      const text = describeQuote(result);
      assert.match(text, /PRICING —/);
      assert.match(text, /CONSIDERED/);
      assert.match(text, /WRONG IF/);
      assert.ok(!text.includes("NaN"), text);
      assert.ok(!text.includes("undefined"), text);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard rails on the constants themselves
// ─────────────────────────────────────────────────────────────────────────────

describe("the constants hold together", () => {
  it("keeps the ceiling above willingness to pay, or the premium option is meaningless", () => {
    assert.ok(CEILING_OVER_WTP > 1);
  });

  it("sets an authority limit that is actually reachable, or escalation is dead code", () => {
    // Reached in the enterprise scenario above. If this ever exceeds the most a
    // quote can be, the escalation branch becomes theatre and this test says so.
    const maxWtp = BASE_PLACEMENT_CENTS * 2 * 4;
    assert.ok(
      AUTONOMY_LIMIT_CENTS < maxWtp * CEILING_OVER_WTP,
      "no reachable quote exceeds the authority limit — escalation would never fire",
    );
  });

  it("keeps the hard floor beneath every derived floor it could bind against", () => {
    assert.ok(HARD_FLOOR_CENTS > STRIPE_FIXED_CENTS);
    assert.ok(MIN_NET_CENTS > 0);
  });
});
