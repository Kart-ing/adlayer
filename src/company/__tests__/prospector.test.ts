/**
 * ADLAYER — Prospector tests.
 *
 * Written from the position of a judge asking "is this agent actually deciding
 * anything, or is it a threshold with a nice comment?" The six facts this file
 * exists to prove:
 *
 *   1. It QUALIFIES on a measured number, and the resulting log entry survives
 *      our own rubber-stamp auditor at full strength.
 *   2. It REJECTS a company that is already visible — a decision that costs us
 *      a possible sale, which a spray-and-pray agent would never make.
 *   3. RANKING IS NOT SORTING. A less-invisible prospect outranks a more-
 *      invisible one, and with a tight budget the two orderings pick different
 *      companies. If this test ever passes trivially, the composite is inert.
 *   4. KEYLESS DEGRADES. No key, no engine, a throwing engine, or an engine
 *      returning nothing: one log line, everything deferred, nothing thrown,
 *      and the score is null — never 0, because 0 reads as "perfect lead".
 *   5. It refuses to pitch a number it cannot defend: a 0.00 visibility over
 *      too small a sample is DEFERRED, not approached.
 *   6. It incriminates itself. Fed fixtures instead of measurements, its own
 *      entries grade `rubber_stamp`.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  auditEntry,
  computeStats,
  openDecisionLog,
  readLog,
  resolveEvidenceRef,
  summarize,
  verifyChain,
  verifyMechanism,
} from "../decision-log.ts";
import type { RetrieveOutput } from "../../../engine/retrieve/types.ts";
import {
  DEFAULT_POLICY,
  deriveQueries,
  measure,
  prospectorMechanism,
  qualify,
  rankProspects,
  renderPlan,
  resetEngineLoaderForTests,
  scoreProspect,
  sonarRetrieve,
  toDomain,
  type FetchLike,
  type ProspectorFlags,
  type RetrieveFn,
} from "../prospector.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Scratch + fakes
// ─────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "adlayer-prospector-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const FIXED_NOW = (): Date => new Date("2026-08-15T14:00:00.000Z");

interface FakeSpec {
  domain: string;
  cited: number;
  total: number;
  /** [rival domain, queries it was cited in] */
  rivals?: [string, number][];
}

/** Build exactly what `engine/retrieve`'s `aggregate()` emits. */
function output(spec: FakeSpec): RetrieveOutput {
  const rivals = spec.rivals ?? [];
  return {
    score: {
      visibility: spec.total === 0 ? 0 : Math.round((spec.cited / spec.total) * 10000) / 10000,
      cited_queries: spec.cited,
      total_queries: spec.total,
    },
    sources: [
      { domain: spec.domain, citation_count: spec.cited, client_present: true },
      ...rivals.map(([domain, citation_count]) => ({
        domain,
        citation_count,
        client_present: false,
      })),
    ].sort((a, b) => b.citation_count - a.citation_count),
    queries: [],
  };
}

/** An injected stand-in for `engine/retrieve`, keyed by domain. */
function stub(...specs: FakeSpec[]): RetrieveFn {
  const byDomain = new Map(specs.map((s) => [toDomain(s.domain), output(s)]));
  return async (url: string): Promise<RetrieveOutput> => {
    const hit = byDomain.get(toDomain(url));
    if (hit === undefined) throw new Error(`no fake measurement for ${url}`);
    return hit;
  };
}

function capture(): { lines: string[]; logger: (m: string) => void } {
  const lines: string[] = [];
  return { lines, logger: (m: string): void => void lines.push(m) };
}

function baseFlags(retrieve: RetrieveFn, extra: ProspectorFlags = {}): ProspectorFlags {
  return { retrieve, now: FIXED_NOW, logger: (): void => {}, ...extra };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The qualified case
// ─────────────────────────────────────────────────────────────────────────────

describe("qualifies a measurably invisible company", () => {
  const spec: FakeSpec = {
    domain: "acme.dev",
    cited: 0,
    total: 24,
    rivals: [
      ["rival.io", 20],
      ["someone.com", 4],
    ],
  };

  it("returns qualified with the real measured score and a number in the rationale", async () => {
    const res = await qualify("https://acme.dev", baseFlags(stub(spec)));

    assert.equal(res.qualified, true);
    assert.equal(res.verdict, "approach");
    assert.equal(res.reason, "provable_invisibility");
    assert.equal(res.score, 0);
    assert.equal(res.probe.total_queries, 24);
    assert.equal(res.probe.degraded, false);
    // The pitch opener must carry the measurement, not an adjective.
    assert.match(res.rationale, /0 of 24/);
    assert.match(res.rationale, /rival\.io/);
  });

  it("logs an entry that survives our own rubber-stamp auditor at full strength", async () => {
    const res = await qualify("https://acme.dev", baseFlags(stub(spec)));
    const audit = auditEntry(res.decision);

    assert.equal(audit.agent, "Prospector");
    assert.equal(audit.strength, "decision", `defects: ${audit.defects.join(", ")}`);
    assert.deepEqual(audit.defects, []);
    // Three genuinely different predicted worlds, not one world with three names.
    assert.equal(audit.distinct_outcomes, 3);
    assert.equal(audit.weak_evidence_only, false);
  });

  it("cites the measurement as evidence and names a falsifier in the same units", async () => {
    const res = await qualify("https://acme.dev", baseFlags(stub(spec)));
    const e = res.decision;

    const visibility = e.evidence.find((x) => x.id === "ev_visibility");
    assert.ok(visibility, "visibility must be logged as evidence");
    assert.equal(visibility.source, "measurement");
    assert.equal(visibility.value, 0);
    // The ref must point at something a reader can open from a clone of this
    // repo. The old ref named engine/retrieve, a module that cannot load here.
    assert.equal(
      resolveEvidenceRef(visibility.ref).resolved,
      true,
      `evidence ref must resolve: ${visibility.ref}`,
    );

    // The falsifier is stated against the same thresholds the evidence carries.
    assert.match(e.flip_condition, /0\.4/);
    assert.match(e.flip_condition, /0\.15/);
    assert.equal(e.flip_to_option_id, "o_reject");
    assert.notEqual(e.flip_to_option_id, e.chosen_option_id);
    assert.equal(e.chosen_option_id, "o_approach_now");
  });

  it("does not mark the approach executed — the Closer sends, not the Prospector", async () => {
    const res = await qualify("https://acme.dev", baseFlags(stub(spec)));
    assert.equal(res.decision.executed, false);
    assert.match(res.decision.effect, /No message sent yet/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The rejection that costs us a sale
// ─────────────────────────────────────────────────────────────────────────────

describe("rejects a company that is already visible", () => {
  const visible: FakeSpec = {
    domain: "wellknown.com",
    cited: 15,
    total: 24,
    rivals: [["rival.io", 12]],
  };

  it("rejects, and does not qualify, despite the sale being on the table", async () => {
    const res = await qualify("https://wellknown.com", baseFlags(stub(visible)));

    assert.equal(res.qualified, false);
    assert.equal(res.verdict, "reject");
    assert.equal(res.reason, "already_visible");
    assert.equal(res.score, 0.625);
    assert.equal(res.decision.chosen_option_id, "o_reject");
  });

  it("states the forgone revenue in the rejected-option counterfactual", async () => {
    const res = await qualify("https://wellknown.com", baseFlags(stub(visible)));
    const approach = res.decision.options.find((o) => o.id === "o_approach_now");
    const reject = res.decision.options.find((o) => o.id === "o_reject");

    assert.ok(approach && reject);
    // The option we did NOT take has a projected value; the one we took is zero.
    assert.equal(approach.projected_value_cents, 2000);
    assert.equal(reject.projected_value_cents, 0);
    assert.match(reject.expected_outcome, /forgo/i);
    assert.match(reject.expected_outcome, /competitor/i);
    // And the flip points back at the sale we just turned down.
    assert.equal(res.decision.flip_to_option_id, "o_approach_now");
  });

  it("grades the rejection as a full decision, not a stamp", async () => {
    const res = await qualify("https://wellknown.com", baseFlags(stub(visible)));
    const audit = auditEntry(res.decision);
    assert.equal(audit.strength, "decision", `defects: ${audit.defects.join(", ")}`);
    // Rejecting is the SECOND option listed, so this entry cannot be explained
    // away as the agent always picking whatever came first.
    assert.equal(audit.chose_first_option, false);
  });

  it("flags a marginal rejection as re-checkable rather than closed", async () => {
    const marginal = await qualify(
      "https://marginal.com",
      baseFlags(stub({ domain: "marginal.com", cited: 11, total: 24, rivals: [["rival.io", 12]] })),
    );
    assert.equal(marginal.verdict, "reject");
    assert.ok(marginal.score !== null && marginal.score < DEFAULT_POLICY.borderline_ceiling);
    assert.match(marginal.decision.context, /BORDERLINE/);

    const emphatic = await qualify("https://wellknown.com", baseFlags(stub(visible)));
    assert.doesNotMatch(emphatic.decision.context, /BORDERLINE/);
  });

  it("rejects an invisible company whose answer space nobody is winning", async () => {
    const res = await qualify(
      "https://quiet.com",
      baseFlags(stub({ domain: "quiet.com", cited: 0, total: 24, rivals: [["nobody.io", 2]] })),
    );
    assert.equal(res.verdict, "reject");
    assert.equal(res.reason, "no_provable_pain");
    assert.equal(res.score, 0, "invisible, and still rejected");
    assert.match(res.rationale, /Nobody is winning/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ranking is not sorting
// ─────────────────────────────────────────────────────────────────────────────

describe("ranks across candidates under a finite budget", () => {
  // thin:  visibility 0.00 but only 10 usable queries and a fragmented space.
  // solid: visibility 0.25 over 24 queries with a rival taking 20 of them.
  // Sorting by score puts `thin` first. The Prospector puts `solid` first.
  const thin: FakeSpec = { domain: "thin.io", cited: 0, total: 10, rivals: [["a-rival.com", 2]] };
  const solid: FakeSpec = { domain: "solid.io", cited: 6, total: 24, rivals: [["b-rival.com", 20]] };

  it("computes a composite that inverts the naive ordering", () => {
    const t = scoreProspect({
      url: "https://thin.io",
      domain: "thin.io",
      visibility: 0,
      cited_queries: 0,
      total_queries: 10,
      rivals: [{ domain: "a-rival.com", citation_count: 2, query_share: 0.2 }],
      measured_at: "2026-08-15T14:00:00.000Z",
      degraded: false,
      degraded_reason: null,
      instrument: "injected retrieve()",
      provenance: "measurement",
    });
    const s = scoreProspect({
      url: "https://solid.io",
      domain: "solid.io",
      visibility: 0.25,
      cited_queries: 6,
      total_queries: 24,
      rivals: [{ domain: "b-rival.com", citation_count: 20, query_share: 20 / 24 }],
      measured_at: "2026-08-15T14:00:00.000Z",
      degraded: false,
      degraded_reason: null,
      instrument: "injected retrieve()",
      provenance: "measurement",
    });

    assert.equal(t.pitch_strength, 0.3);
    assert.equal(s.pitch_strength, 0.6875);
    assert.ok(s.pitch_strength > t.pitch_strength, "the less invisible prospect ranks higher");
  });

  it("sends to the less-invisible prospect first", async () => {
    const plan = await rankProspects(
      ["https://thin.io", "https://solid.io"],
      baseFlags(stub(thin, solid), { budget: 2 }),
    );

    assert.deepEqual(
      plan.approach.map((p) => p.domain),
      ["solid.io", "thin.io"],
    );
    assert.equal(plan.approach[0]?.qualify.score, 0.25);
    assert.equal(plan.approach[1]?.qualify.score, 0);
  });

  it("picks a DIFFERENT company than sorting by score when the budget is tight", async () => {
    const plan = await rankProspects(
      ["https://thin.io", "https://solid.io"],
      baseFlags(stub(thin, solid), { budget: 1 }),
    );

    assert.equal(plan.ranking_changed_the_set, true, "if this is false the composite is inert");
    assert.deepEqual(
      plan.approach.map((p) => p.domain),
      ["solid.io"],
    );
    assert.equal(plan.held[0]?.domain, "thin.io");
    assert.match(plan.held[0]?.held_reason ?? "", /Out of budget/);
  });

  it("logs the portfolio decision with both orderings and a real falsifier", async () => {
    const plan = await rankProspects(
      ["https://thin.io", "https://solid.io"],
      baseFlags(stub(thin, solid), { budget: 1 }),
    );

    const portfolio = plan.decisions.find((d) => d.id.startsWith("prospector-outreach-batch"));
    assert.ok(portfolio, "the budget allocation must be logged");
    assert.equal(portfolio.agent, "Prospector");
    assert.equal(portfolio.options.length, 3);
    assert.equal(portfolio.chosen_option_id, "o_rank_by_pitch_strength");
    assert.equal(portfolio.flip_to_option_id, "o_rank_by_raw_invisibility");

    // The rejected ordering must state what it would actually have done.
    const naive = portfolio.options.find((o) => o.id === "o_rank_by_raw_invisibility");
    assert.match(naive?.expected_outcome ?? "", /thin\.io > solid\.io/);
    assert.match(portfolio.rationale, /load-bearing/);
    assert.equal(auditEntry(portfolio).strength, "decision");
  });

  it("admits when the composite changed nothing rather than claiming a win", async () => {
    // Both orderings agree here, so the entry must say so.
    const a: FakeSpec = { domain: "aa.io", cited: 0, total: 24, rivals: [["x.com", 20]] };
    const b: FakeSpec = { domain: "bb.io", cited: 6, total: 24, rivals: [["y.com", 20]] };
    const plan = await rankProspects(
      ["https://aa.io", "https://bb.io"],
      baseFlags(stub(a, b), { budget: 2 }),
    );

    assert.equal(plan.ranking_changed_the_set, false);
    const portfolio = plan.decisions.find((d) => d.id.startsWith("prospector-outreach-batch"));
    assert.match(portfolio?.rationale ?? "", /inert/);
  });

  it("holds the weaker of two prospects contesting the same answer space", async () => {
    const p1: FakeSpec = { domain: "p1.io", cited: 0, total: 24, rivals: [["bigco.com", 20]] };
    const p2: FakeSpec = { domain: "p2.io", cited: 3, total: 24, rivals: [["bigco.com", 18]] };

    const plan = await rankProspects(
      ["https://p1.io", "https://p2.io"],
      baseFlags(stub(p1, p2), { budget: 3 }),
    );

    assert.deepEqual(
      plan.approach.map((p) => p.domain),
      ["p1.io"],
    );
    assert.equal(plan.held[0]?.domain, "p2.io");
    assert.match(plan.held[0]?.held_reason ?? "", /same answer space/);

    const conflict = plan.decisions.find((d) => d.id.startsWith("prospector-space-conflict"));
    assert.ok(conflict, "a binding inventory conflict must be logged");
    assert.equal(conflict.chosen_option_id, "o_one_slot_in_space");
    assert.equal(conflict.executed, true);
    // We turned down the higher-revenue option on purpose. Say so numerically.
    const both = conflict.options.find((o) => o.id === "o_both_in_space");
    assert.equal(both?.projected_value_cents, 4000);
    assert.equal(auditEntry(conflict).strength, "decision");
  });

  it("does not log a conflict decision when the constraint never binds", async () => {
    const plan = await rankProspects(
      ["https://thin.io", "https://solid.io"],
      baseFlags(stub(thin, solid), { budget: 3 }),
    );
    assert.equal(
      plan.decisions.filter((d) => d.id.startsWith("prospector-space-conflict")).length,
      0,
      "a constraint that changed nothing is decoration, not a decision",
    );
  });

  it("keeps the whole batch on one verifiable hash chain", async () => {
    const dir = scratch();
    const path = join(dir, "decisions.jsonl");
    const plan = await rankProspects(
      ["https://thin.io", "https://solid.io", "https://wellknown.com"],
      baseFlags(
        stub(thin, solid, { domain: "wellknown.com", cited: 15, total: 24, rivals: [["r.io", 12]] }),
        { budget: 1, log: openDecisionLog({ path }) },
      ),
    );

    assert.equal(plan.decisions.length, 4); // 3 qualifications + 1 portfolio
    const onDisk = readLog(path);
    assert.equal(onDisk.length, 4);
    assert.equal(verifyChain(onDisk).ok, true);

    // The agent is not a constant function: it approached, held and rejected.
    const chosen = new Set(onDisk.map((e) => e.chosen_option_id));
    assert.ok(chosen.size >= 3, `expected varied choices, got ${[...chosen].join(", ")}`);
    assert.match(summarize(onDisk), /Prospector/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Degraded without keys
// ─────────────────────────────────────────────────────────────────────────────

describe("degrades without keys instead of throwing", () => {
  it("makes no network call and defers everything on a dry run", async () => {
    resetEngineLoaderForTests();
    const { lines, logger } = capture();

    const res = await qualify("https://unknown.io", { now: FIXED_NOW, logger });

    // The engine module is never even loaded, so nothing could have dialled out.
    assert.equal(
      lines.some((l) => l.includes("engine/retrieve")),
      false,
      "dry run must not touch the retrieval engine at all",
    );
    assert.match(res.probe.degraded_reason ?? "", /liveMeasure not set/);
    assert.equal(res.qualified, false);
    assert.equal(res.verdict, "defer");
    assert.equal(res.reason, "unmeasured");
    assert.equal(res.probe.degraded, true);
    assert.equal(lines.length, 1, `expected exactly one log line, got: ${lines.join(" | ")}`);
    assert.match(lines[0] ?? "", /dry run/);
  });

  it("scores an unmeasured prospect null, NEVER 0", async () => {
    const res = await qualify("https://unknown.io", { now: FIXED_NOW, logger: () => {} });
    // 0 means "maximally invisible" — the most attractive lead on the list. If
    // this ever regresses to 0, a total measurement outage renders as a page of
    // perfect prospects and the agent pitches numbers it never had.
    assert.equal(res.score, null);
    assert.notEqual(res.score, 0);
    assert.match(res.rationale, /null, not zero/);
  });

  it("defers when the engine returns nothing usable, which is the keyless path", async () => {
    const { lines, logger } = capture();
    // This is literally what `retrieve()` returns with no API key set: EMPTY.
    const empty: RetrieveFn = async () => ({
      score: { visibility: 0, cited_queries: 0, total_queries: 0 },
      sources: [],
      queries: [],
    });

    const res = await qualify("https://acme.dev", { retrieve: empty, now: FIXED_NOW, logger });

    assert.equal(res.verdict, "defer");
    assert.equal(res.score, null);
    assert.match(res.probe.degraded_reason ?? "", /no usable queries/);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /every query came back empty or failed/);
  });

  it("degrades rather than throwing when the engine itself throws", async () => {
    const { lines, logger } = capture();
    const boom: RetrieveFn = async () => {
      throw new Error("ECONNRESET");
    };

    const res = await qualify("https://acme.dev", { retrieve: boom, now: FIXED_NOW, logger });

    assert.equal(res.verdict, "defer");
    assert.equal(res.score, null);
    assert.match(res.probe.degraded_reason ?? "", /ECONNRESET/);
    assert.match(lines[0] ?? "", /measurement failed/);
  });

  it("degrades with one named log line when the sonar instrument has no key", async () => {
    resetEngineLoaderForTests();
    const { lines, logger } = capture();

    const res = await qualify("https://acme.dev", {
      liveMeasure: true,
      sonar: { apiKey: null },
      now: FIXED_NOW,
      logger,
    });

    assert.equal(res.verdict, "defer");
    assert.equal(res.score, null);
    // The log line must name the actual blocker, not say "something went wrong".
    const joined = lines.join(" ");
    assert.match(joined, /PERPLEXITY_API_KEY/);
    assert.equal(lines.length, 1, `expected one log line, got: ${lines.join(" | ")}`);
    // And it must NOT have reached out to engine/retrieve, which is opt-in now.
    assert.doesNotMatch(joined, /engine\/retrieve/);
  });

  it("still names engine/retrieve's real blockers when a caller opts into it", async () => {
    resetEngineLoaderForTests();
    const { lines, logger } = capture();

    const res = await qualify("https://acme.dev", {
      liveMeasure: true,
      useEngine: true,
      sonar: { apiKey: null },
      now: FIXED_NOW,
      logger,
    });

    assert.equal(res.verdict, "defer");
    const joined = lines.join(" ");
    assert.match(joined, /engine\/retrieve unavailable/);
    assert.match(joined, /openai/);
    // Having failed over, it says which instrument it fell back to.
    assert.match(joined, /PERPLEXITY_API_KEY/);
    resetEngineLoaderForTests();
  });

  it("still writes a decision entry when degraded — silence is not a record", async () => {
    const res = await qualify("https://unknown.io", { now: FIXED_NOW, logger: () => {} });
    const audit = auditEntry(res.decision);

    assert.equal(res.decision.agent, "Prospector");
    assert.equal(res.decision.chosen_option_id, "o_defer_remeasure");
    // A deferral changes NOTHING outside this log. An earlier version marked it
    // executed, which inflated a fully-degraded run to "N of N executed" and
    // silenced the one warning that catches exactly that state.
    assert.equal(res.decision.executed, false, "a deferral executes nothing");
    assert.match(res.decision.effect, /nothing outside this log changed/);
    // The instrument's own failure is the evidence, and it points at code that
    // exists: a ref naming a module this repo cannot load resolves to nothing.
    const inst = res.decision.evidence.find((e) => e.id === "ev_instrument");
    assert.ok(inst);
    assert.equal(inst.value, false);
    assert.equal(
      resolveEvidenceRef(inst.ref).resolved,
      true,
      `evidence ref must resolve from a clone of the repo: ${inst.ref}`,
    );
    assert.equal(audit.strength, "decision", `defects: ${audit.defects.join(", ")}`);
  });

  it("a keyless run trips the log's own 'this is a simulation' warning", async () => {
    // The check this whole file exists to keep armed: if nothing was executed,
    // the summary must SAY nothing was executed.
    const plan = await rankProspects(["https://a.io", "https://b.io", "https://c.io"], {
      now: FIXED_NOW,
      logger: () => {},
    });
    const text = summarize(plan.log.entries());
    assert.match(text, /nothing in this log was executed/);
    assert.match(text, /simulation of an agent-run company/);
  });

  it("never throws on a malformed candidate URL", async () => {
    const res = await qualify("not a url at all", { now: FIXED_NOW, logger: () => {} });
    assert.equal(res.verdict, "defer");
    assert.equal(res.score, null);
  });

  it("produces an empty, honest plan when nothing can be measured", async () => {
    const plan = await rankProspects(["https://a.io", "https://b.io"], {
      now: FIXED_NOW,
      logger: () => {},
    });

    assert.equal(plan.approach.length, 0);
    assert.equal(plan.deferred.length, 2);
    // No qualified prospects means no portfolio decision to fake.
    assert.equal(plan.decisions.filter((d) => d.id.includes("outreach-batch")).length, 0);
    assert.match(renderPlan(plan), /no prospect cleared qualification/);
  });

  it("writes no file at all unless a path is named", async () => {
    const dir = scratch();
    const path = join(dir, "never-written.jsonl");
    const plan = await rankProspects(["https://a.io"], { now: FIXED_NOW, logger: () => {} });

    assert.equal(plan.log.path, null);
    assert.equal(existsSync(path), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The anti-spray rule
// ─────────────────────────────────────────────────────────────────────────────

describe("refuses to pitch a number it cannot defend", () => {
  it("defers a 0.00 visibility measured over too small a sample", async () => {
    const res = await qualify(
      "https://tiny.io",
      baseFlags(stub({ domain: "tiny.io", cited: 0, total: 5, rivals: [["rival.io", 4]] })),
    );

    // Maximally invisible AND a dominant rival — the naive agent pitches this
    // instantly. We do not, because 5 queries is not a finding.
    assert.equal(res.score, 0);
    assert.equal(res.signals.urgency, 0.8);
    assert.equal(res.qualified, false);
    assert.equal(res.verdict, "defer");
    assert.equal(res.reason, "sample_too_small");
    assert.match(res.rationale, /evidence floor/);
    // The falsifier turns on sample size, not on the score.
    assert.match(res.decision.flip_condition, /sample size/);
    assert.equal(res.decision.flip_to_option_id, "o_approach_now");
  });

  it("qualifies the same company once the sample clears the floor", async () => {
    const res = await qualify(
      "https://tiny.io",
      baseFlags(stub({ domain: "tiny.io", cited: 0, total: 12, rivals: [["rival.io", 9]] })),
    );
    assert.equal(res.qualified, true);
    assert.equal(res.reason, "provable_invisibility");
  });

  it("honours a caller who argues the policy down", async () => {
    const res = await qualify(
      "https://tiny.io",
      baseFlags(stub({ domain: "tiny.io", cited: 0, total: 5, rivals: [["rival.io", 4]] }), {
        policy: { min_admissible_queries: 4 },
      }),
    );
    assert.equal(res.qualified, true);
    // And the log records which policy was in force when it did.
    assert.match(res.decision.context, /min_admissible_queries=4/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The agent incriminates itself
// ─────────────────────────────────────────────────────────────────────────────

describe("does not disarm its own auditor", () => {
  const spec: FakeSpec = { domain: "acme.dev", cited: 0, total: 24, rivals: [["rival.io", 20]] };

  it("grades a fixture-driven run as a rubber stamp", async () => {
    const res = await qualify(
      "https://acme.dev",
      baseFlags(stub(spec), { evidenceSource: "fixture" }),
    );
    const audit = auditEntry(res.decision);

    assert.equal(res.qualified, true, "the verdict is unchanged...");
    assert.equal(audit.strength, "rubber_stamp", "...but the record admits it ran on fixtures");
    assert.ok(audit.defects.includes("evidence_is_all_fixture_or_prior"));
    assert.equal(audit.weak_evidence_only, true);
  });

  it("keeps policy thresholds out of the evidence array", async () => {
    const res = await qualify(
      "https://acme.dev",
      baseFlags(stub(spec), { evidenceSource: "fixture" }),
    );
    // Logging the human-set policy as `human_input` evidence would make every
    // entry immune to the weak-evidence defect forever. It belongs in context.
    assert.equal(
      res.decision.evidence.some((e) => e.source === "human_input"),
      false,
    );
    assert.match(res.decision.context, /human-set, not evidence/);
    assert.match(res.decision.context, /visible_enough=0\.4/);
  });

  it("does not count the prospect's own subdomains as rivals eating its answers", async () => {
    // engine/retrieve keys on hostname, so docs.acme.dev arrives as a separate
    // cited domain. Treating it as a competitor inflates urgency and can
    // qualify a prospect on the strength of their OWN content winning — the
    // exact inverse of the problem we sell.
    const res = await qualify(
      "https://acme.dev",
      baseFlags(
        stub({
          domain: "acme.dev",
          cited: 0,
          total: 24,
          rivals: [
            ["docs.acme.dev", 20],
            ["blog.acme.dev", 6],
          ],
        }),
      ),
    );

    assert.deepEqual(res.probe.rivals, [], "own properties are not rivals");
    assert.equal(res.signals.urgency, 0);
    assert.equal(res.signals.contested_space, null);
    assert.equal(res.verdict, "reject");
    assert.equal(res.reason, "no_provable_pain");
  });

  it("still counts a genuine competitor with a similar-looking name", async () => {
    const res = await qualify(
      "https://myapp.io",
      baseFlags(stub({ domain: "myapp.io", cited: 0, total: 24, rivals: [["app.io", 20]] })),
    );
    assert.equal(res.probe.rivals[0]?.domain, "app.io");
    assert.equal(res.qualified, true);
  });

  it("reports the number of rivals it actually saw, not a claim about them", async () => {
    const probe = await measure("https://acme.dev", baseFlags(stub(spec)));
    assert.equal(probe.rivals.length, 1);
    assert.equal(probe.rivals[0]?.domain, "rival.io");
    assert.equal(probe.rivals[0]?.query_share, 20 / 24);
    // The prospect's own domain is never counted as its own rival.
    assert.equal(
      probe.rivals.some((r) => r.domain === "acme.dev"),
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE INSTRUMENT — the fix for "in every configuration this repo can run,
//    it returns defer for every candidate"
//
// The old live path was `engine/retrieve`, which cannot load here: extensionless
// specifiers and an `openai` import that is not in package.json. So the agent
// deferred always, and the decision function — which is real — never ran on a
// number the agent measured itself. These tests exercise the replacement.
// ─────────────────────────────────────────────────────────────────────────────

describe("the sonar instrument", () => {
  /** A fake Perplexity that answers each query with a fixed citation list. */
  function fakeSonar(citationsPerQuery: string[][]): {
    fetchImpl: FetchLike;
    asked: string[];
  } {
    const asked: string[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { messages: { content: string }[] };
      asked.push(body.messages[0]?.content ?? "");
      const citations = citationsPerQuery[i++ % citationsPerQuery.length] ?? [];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "..." } }], citations }),
      };
    };
    return { fetchImpl, asked };
  }

  it("is unavailable — one log line, no throw — when there is no API key", () => {
    const { lines, logger } = capture();
    assert.equal(sonarRetrieve({ apiKey: null }, logger), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /PERPLEXITY_API_KEY/);
  });

  it("measures a real visibility number over a real sample", async () => {
    const { fetchImpl } = fakeSonar([
      ["https://rival.io/a", "https://other.com/b"],
      ["https://rival.io/c"],
      ["https://acme.dev/pricing", "https://rival.io/d"],
    ]);
    const retrieve = sonarRetrieve({ apiKey: "test", fetchImpl, maxQueries: 9 }, () => {});
    assert.ok(retrieve !== null);

    const out = await retrieve("https://acme.dev");
    assert.equal(out.score.total_queries, 9);
    // The prospect is cited in 1 of every 3 answers in the fixture cycle.
    assert.equal(out.score.cited_queries, 3);
    assert.equal(out.score.visibility, 0.3333);
    const rival = out.sources.find((s) => s.domain === "rival.io");
    assert.ok(rival);
    assert.equal(rival.client_present, false);
    assert.equal(out.sources.find((s) => s.domain === "acme.dev")?.client_present, true);
  });

  it("drops a failed query from the sample rather than counting it as a miss", async () => {
    // Counting a rate-limited query as "not cited" manufactures invisibility —
    // the one direction this number must never be wrong in.
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n++;
      if (n % 2 === 0) return { ok: false, status: 429, text: async () => "rate limited" };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ citations: ["https://acme.dev/x"] }),
      };
    };
    const retrieve = sonarRetrieve({ apiKey: "test", fetchImpl, maxQueries: 6 }, () => {});
    assert.ok(retrieve !== null);
    const out = await retrieve("https://acme.dev");

    assert.equal(out.score.total_queries, 3, "only the queries that returned count as the sample");
    assert.equal(out.score.cited_queries, 3);
    assert.equal(out.score.visibility, 1);
  });

  it("never lets a URL the model merely typed count as a citation", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "You should look at https://acme.dev for this." } }],
          citations: ["https://rival.io/a"],
        }),
    });
    const retrieve = sonarRetrieve({ apiKey: "test", fetchImpl, maxQueries: 4 }, () => {});
    assert.ok(retrieve !== null);
    const out = await retrieve("https://acme.dev");
    assert.equal(out.score.cited_queries, 0, "prose is not a citation");
    assert.equal(out.score.visibility, 0);
  });

  it("drives the whole agent end to end, so liveMeasure decides rather than defers", async () => {
    const { fetchImpl } = fakeSonar([["https://rival.io/a"], ["https://rival.io/b"]]);
    const res = await qualify("https://acme.dev", {
      liveMeasure: true,
      sonar: { apiKey: "test", fetchImpl, maxQueries: 12 },
      now: FIXED_NOW,
      logger: () => {},
    });

    // 12 usable queries, zero citations, one rival taking all of them.
    assert.equal(res.probe.degraded, false);
    assert.equal(res.probe.total_queries, 12);
    assert.equal(res.score, 0);
    assert.equal(res.verdict, "approach");
    assert.equal(res.reason, "provable_invisibility");
    assert.match(res.probe.instrument, /perplexity/);
  });

  it("asks the categories it was given, not a guess from the domain name", () => {
    const derived = deriveQueries("acme.dev", ["gutter cleaning"], 3);
    assert.ok(derived.every((q) => q.includes("gutter cleaning")));
    const fallback = deriveQueries("acme.dev", [], 3);
    assert.ok(fallback.every((q) => q.includes("acme")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ONE dead instrument is ONE decision, not N
// ─────────────────────────────────────────────────────────────────────────────

describe("does not inflate its decision count when the instrument is down", () => {
  it("logs a single entry for a wholly unmeasured batch", async () => {
    const plan = await rankProspects(
      ["https://a.io", "https://b.io", "https://c.io", "https://d.io"],
      { now: FIXED_NOW, logger: () => {} },
    );

    assert.equal(plan.instrument_down, true);
    assert.equal(plan.deferred.length, 4, "every candidate is still accounted for");
    assert.equal(plan.log.entries().length, 1, "four identical deferrals are ONE decision");
    const entry = plan.log.entries()[0];
    assert.ok(entry !== undefined);
    assert.match(entry.id, /instrument-down/);
    assert.equal(entry.executed, false);
    assert.match(renderPlan(plan), /INSTRUMENT DOWN/);
  });

  it("prices the option it refused, so the refusal is legible as a choice", async () => {
    const plan = await rankProspects(["https://a.io", "https://b.io"], {
      now: FIXED_NOW,
      logger: () => {},
    });
    const entry = plan.log.entries()[0];
    assert.ok(entry !== undefined);
    const spray = entry.options.find((o) => o.id === "o_batch_pitch_unmeasured");
    assert.ok(spray, "spraying must be on the record, not omitted");
    assert.equal(spray.projected_value_cents, 4000);
    assert.notEqual(entry.chosen_option_id, "o_batch_pitch_unmeasured");
    // And it is re-runnable: one usable measurement flips it.
    assert.equal(auditEntry(entry).mechanism, "verified");
  });

  it("goes back to per-candidate entries the moment ONE measurement lands", async () => {
    const partial: RetrieveFn = async (url) => {
      if (toDomain(url) !== "b.io") throw new Error("instrument down for this one");
      return {
        score: { visibility: 0, cited_queries: 0, total_queries: 24 },
        sources: [
          { domain: "b.io", citation_count: 0, client_present: true },
          { domain: "rival.io", citation_count: 20, client_present: false },
        ],
        queries: [],
      };
    };
    const plan = await rankProspects(["https://a.io", "https://b.io"], {
      retrieve: partial,
      now: FIXED_NOW,
      logger: () => {},
    });

    assert.equal(plan.instrument_down, false);
    assert.equal(plan.approach.map((p) => p.domain).join(","), "b.io");
    assert.equal(plan.deferred.length, 1);
    assert.ok(plan.log.entries().length >= 3, "two qualify entries plus the portfolio entry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. MECHANISM REPLAY — the auditor re-runs this agent
// ─────────────────────────────────────────────────────────────────────────────

describe("mechanism replay", () => {
  const specs: FakeSpec[] = [
    { domain: "acme.dev", cited: 0, total: 24, rivals: [["rival.io", 20]] },
    { domain: "wellknown.com", cited: 15, total: 24, rivals: [["rival.io", 12]] },
    { domain: "quiet.com", cited: 0, total: 24, rivals: [["nobody.io", 2]] },
    { domain: "tiny.io", cited: 0, total: 5, rivals: [["rival.io", 4]] },
  ];

  it("verifies every qualify entry: the choice reproduces AND the falsifier flips it", async () => {
    const log = openDecisionLog({ now: FIXED_NOW });
    for (const s of specs) {
      await qualify(`https://${s.domain}`, baseFlags(stub(s), { log }));
    }
    const stats = computeStats(log.entries());

    assert.equal(stats.total, 4);
    assert.equal(stats.mechanism_verified, 4, "all four re-run and reproduce");
    assert.equal(stats.mechanism_refuted, 0);
    // Four different reasons, and the derived flip target is not always the same.
    assert.ok(new Set(log.entries().map((e) => e.flip_to_option_id)).size >= 2);
  });

  it("catches a record edited to claim a choice the code does not make", async () => {
    const res = await qualify("https://acme.dev", baseFlags(stub(specs[0] as FakeSpec)));
    // Hand-edit the record: claim we rejected them. The code says approach.
    const forged = { ...res.decision, chosen_option_id: "o_reject" };
    const check = verifyMechanism(forged);
    assert.equal(check.status, "refuted");
    assert.match(check.detail, /the record and the code disagree/);
  });

  it("derives the falsifier — it is not a sentence someone typed", async () => {
    const res = await qualify("https://acme.dev", baseFlags(stub(specs[0] as FakeSpec)));
    const replay = res.decision.replay;
    assert.ok(replay);
    assert.equal(replay.fn, "prospector.qualify");
    // The flip input is the recorded input with ONE stated value substituted.
    const before = replay.input as { visibility: number; total_queries: number };
    const after = replay.flip_input as { visibility: number; total_queries: number };
    assert.equal(before.visibility, 0);
    assert.equal(after.visibility, DEFAULT_POLICY.visible_enough);
    assert.equal(after.total_queries, before.total_queries, "only the named value moved");
    // And re-running at that value really does change the answer.
    assert.equal(prospectorMechanism(before), "o_approach_now");
    assert.equal(prospectorMechanism(after), "o_reject");
  });
});
