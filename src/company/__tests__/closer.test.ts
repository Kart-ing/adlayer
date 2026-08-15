/**
 * ADLAYER — Closer tests.
 *
 * Written from the position of someone trying to catch us shipping spam with a
 * decision log stapled to it, not someone trying to show the happy path works.
 *
 * The six facts this file exists to prove:
 *
 *   1. A generated pitch OPENS with the prospect's own measured number and names
 *      the domains beating them, and both come from the score object.
 *   2. NO DRAFT CONTAINS A FABRICATED METRIC. Checked two ways: the module's own
 *      guard, and an independent extraction in this file that recomputes the
 *      allowed set by hand rather than trusting `allowedNumbersFor()`.
 *   3. Declining is a real outcome with real consequences: no copy, no model
 *      call, no bytes on disk — and it is still logged.
 *   4. A missing API key degrades to the template with one line and never throws.
 *      A model that invents a statistic or fakes urgency is overruled.
 *   5. The agent could have chosen otherwise: the same code produces all three
 *      angles, all three channels and all three dispositions across a realistic
 *      prospect list, so it is not a constant function wearing a costume.
 *   6. Nothing is ever sent. `liveSend: true` is refused, out loud.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  auditEntry,
  computeStats,
  openDecisionLog,
  verifyChain,
  type DecisionSink,
} from "../decision-log.ts";
import {
  BANNED_URGENCY,
  COMPETITOR_CONCENTRATION_FLOOR,
  DEFAULT_SENDER,
  LOSS_FRAME_CEILING,
  MIN_QUERIES_FOR_ASSERTION,
  OPT_OUT_SENTENCE,
  RECONTACT_DAYS,
  VISIBILITY_PITCH_CEILING,
  allowedNumbersFor,
  assertNoFabricatedMetrics,
  checkModelDraft,
  CloserError,
  decideAngle,
  decideChannel,
  decideDisposition,
  evidenceOpening,
  findComplianceViolations,
  findFabricatedNumbers,
  maskLiterals,
  pitch,
  renderTemplate,
  type CloserFlags,
  type InvisibilityScore,
  type Prospect,
  type ProspectContact,
  type SenderIdentity,
} from "../closer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Scratch space
// ─────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "adlayer-closer-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-15T14:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SENDER: SenderIdentity = {
  name: "AdLayer",
  reply_to: "hello@adlayer.test",
  website: "https://adlayer.test",
  postal_address: "1 Test Street, Testville",
};

function contact(overrides: Partial<ProspectContact> = {}): ProspectContact {
  return {
    email: "partnerships@acme.test",
    form_url: null,
    source: "advertising_invite",
    ...overrides,
  };
}

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    id: "prospect_acme",
    name: "Acme Robotics",
    domain: "acme.test",
    categories: ["warehouse robotics"],
    contact: contact(),
    last_contacted_at: null,
    opted_out: false,
    record_ref: "fixture.json#/client",
    ...overrides,
  };
}

/** An invisible prospect with one dominant rival. The headline case. */
function score(overrides: Partial<InvisibilityScore> = {}): InvisibilityScore {
  return {
    visibility: 0,
    cited_queries: 0,
    total_queries: 12,
    competitors: [
      { domain: "rival.test", citation_count: 9 },
      { domain: "second.test", citation_count: 5 },
      { domain: "third.test", citation_count: 3 },
    ],
    engine: "perplexity/sonar",
    measured_at: "2026-08-15T12:30:00.000Z",
    source: "measurement",
    ref: "retrieve_run_0031",
    queries: [
      "best warehouse robotics vendor",
      "warehouse automation platform comparison",
      "who makes autonomous warehouse robots",
    ],
    ...overrides,
  };
}

/** Never let a developer's real ANTHROPIC_API_KEY reach a test. */
function baseFlags(extra: CloserFlags = {}): CloserFlags {
  return {
    env: {},
    now: () => NOW,
    logger: () => {},
    sender: SENDER,
    ...extra,
  };
}

function fetchThatMustNotBeCalled(): typeof fetch {
  return (): Promise<Response> => {
    throw new Error("network was called during a keyless run");
  };
}

function modelReturning(subject: string, body: string): typeof fetch {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ subject, body }) }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A pitch with the real evidence embedded
// ─────────────────────────────────────────────────────────────────────────────

describe("pitch — generated with real evidence embedded", () => {
  it("opens with the measured number and names the domains beating them", async () => {
    const p = prospect();
    const s = score();
    const result = await pitch(p, s, baseFlags({ useModel: false }));

    assert.equal(result.decision.disposition, "send");

    // The number is the first sentence, not buried in paragraph four.
    const opening = evidenceOpening(p, s);
    assert.ok(result.body.startsWith(opening), `body should open with: ${opening}`);
    assert.match(result.body, /cited in 0 of the 12 AI answers we measured/);

    // The domains beating them, with their measured counts.
    assert.match(result.body, /rival\.test \(9 of 12\)/);
    assert.match(result.body, /second\.test \(5 of 12\)/);
    assert.match(result.body, /third\.test \(3 of 12\)/);

    // The engine and date, so the claim is checkable rather than assertable.
    assert.ok(result.body.includes("perplexity/sonar"));
    assert.ok(result.body.includes("2026-08-15"));

    // The subject states a measured fact. It does not tease one. Under the
    // competitor angle that fact is which domain holds the answers instead.
    assert.equal(result.decision.angle, "competitor_framed");
    assert.equal(
      result.subject,
      "rival.test is in the AI answers for warehouse robotics. Acme Robotics is not.",
    );
    // ...and under the other two angles it is the number itself.
    const spread = score({
      visibility: 0.25,
      cited_queries: 3,
      competitors: [
        { domain: "x.test", citation_count: 4 },
        { domain: "y.test", citation_count: 4 },
        { domain: "z.test", citation_count: 4 },
      ],
    });
    const other = await pitch(p, spread, baseFlags({ useModel: false }));
    assert.match(other.subject, /3 of 12/);
  });

  it("names the queries so the prospect can re-run the measurement", async () => {
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false }));
    assert.ok(result.body.includes("best warehouse robotics vendor"));
  });

  it("carries the disclosure tag and an opt-out, and invents no urgency", async () => {
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false }));
    assert.ok(result.body.includes("[SPONSORED]"));
    assert.ok(result.body.includes(OPT_OUT_SENTENCE));
    for (const phrase of BANNED_URGENCY) {
      assert.ok(
        !result.body.toLowerCase().includes(phrase),
        `template should never contain "${phrase}"`,
      );
    }
    assert.ok(!result.subject.includes("!"));
    assert.ok(!/^\s*(re|fwd)\s*:/i.test(result.subject));
  });

  it("logs three decisions — gate, angle, channel — and the chain verifies", async () => {
    const log = openDecisionLog({ logger: () => {} });
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false, log }));

    assert.equal(result.decision.entries.length, 3);
    assert.deepEqual(
      result.decision.entries.map((e) => e.question.slice(0, 4)),
      ["Do w", "Whic", "Whic"],
    );
    for (const entry of result.decision.entries) {
      assert.equal(entry.agent, "Closer");
      assert.notEqual(entry.flip_condition.trim(), "");
      assert.notEqual(entry.flip_to_option_id, null);
      assert.notEqual(entry.flip_to_option_id, entry.chosen_option_id);
      assert.ok(entry.evidence.length >= 4);
    }
    assert.equal(verifyChain(log.entries()).ok, true);
  });

  it("grades its own send decisions as real decisions, not rubber stamps", async () => {
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false }));
    for (const entry of result.decision.entries) {
      const audit = auditEntry(entry);
      assert.equal(
        audit.strength,
        "decision",
        `${entry.id} graded ${audit.strength}: ${audit.defects.join(", ")}`,
      );
    }
  });

  it("never reports itself as sent, and lists what blocks a real send", async () => {
    const result = await pitch(
      prospect(),
      score(),
      baseFlags({ useModel: false, sender: DEFAULT_SENDER }),
    );
    assert.equal(result.decision.sent, false);
    assert.ok(result.decision.send_blockers.some((b) => b.includes("no send transport")));
    assert.ok(result.decision.send_blockers.some((b) => b.includes("reply_to")));
    assert.ok(result.decision.send_blockers.some((b) => b.includes("postal_address")));
  });

  it("refuses liveSend out loud rather than quietly ignoring it", async () => {
    const lines: string[] = [];
    const result = await pitch(
      prospect(),
      score(),
      baseFlags({ useModel: false, liveSend: true, logger: (m) => lines.push(m) }),
    );
    assert.equal(result.decision.sent, false);
    assert.ok(lines.some((l) => l.includes("no send transport is wired")));
    assert.ok(result.decision.degraded.some((d) => d.includes("liveSend requested and refused")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Declining and holding
// ─────────────────────────────────────────────────────────────────────────────

describe("pitch — declining is a real decision", () => {
  it("declines an opted-out prospect, produces no copy, and still logs it", async () => {
    const log = openDecisionLog({ logger: () => {} });
    const dir = scratch();
    const result = await pitch(
      prospect({ opted_out: true }),
      score(),
      baseFlags({ useModel: false, log, draftDir: dir }),
    );

    assert.equal(result.decision.disposition, "decline");
    assert.equal(result.subject, "");
    assert.equal(result.body, "");
    assert.equal(result.decision.copy_source, "none");
    assert.equal(result.decision.draft_path, null);
    assert.deepEqual(readdirSync(dir), [], "a declined prospect must not touch disk");

    assert.equal(result.decision.entries.length, 1);
    const entry = result.decision.entries[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.executed, false);
    // Honest grading: an opt-out is a RULE, not a judgement. There is no
    // defensible second option, so we log one option and let our own auditor
    // call it a rubber stamp rather than invent a strawman to game the grade.
    assert.equal(entry.options.length, 1);
    assert.equal(auditEntry(entry).strength, "rubber_stamp");
  });

  it("declines a prospect who is already visible, and says what would flip it", async () => {
    const result = await pitch(
      prospect(),
      score({ visibility: 0.75, cited_queries: 9 }),
      baseFlags({ useModel: false }),
    );
    assert.equal(result.decision.disposition, "decline");
    const entry = result.decision.entries[0];
    assert.ok(entry !== undefined);
    assert.match(entry.flip_condition, new RegExp(String(VISIBILITY_PITCH_CEILING)));
    assert.equal(entry.options.length, 2, "declining a visible prospect had a defensible alternative");
    assert.equal(auditEntry(entry).strength, "decision");
  });

  it("declines inside the frequency cap and counts the days", async () => {
    const recent = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const result = await pitch(
      prospect({ last_contacted_at: recent }),
      score(),
      baseFlags({ useModel: false }),
    );
    assert.equal(result.decision.disposition, "decline");
    assert.match(result.decision.reason, /3 days ago/);
    assert.match(result.decision.reason, new RegExp(`${RECONTACT_DAYS}-day cap`));
  });

  it("declines when there is no contact route at all", async () => {
    const result = await pitch(
      prospect({ contact: contact({ email: null, form_url: null, source: "unknown" }) }),
      score(),
      baseFlags({ useModel: false }),
    );
    assert.equal(result.decision.disposition, "decline");
    assert.match(result.decision.reason, /nothing to send to/);
  });

  it("HOLDS rather than pitching on fixture evidence", async () => {
    const result = await pitch(
      prospect(),
      score({ source: "fixture" }),
      baseFlags({ useModel: false }),
    );
    assert.equal(result.decision.disposition, "hold");
    assert.equal(result.body, "");
    assert.match(result.decision.reason, /not a live measurement/);

    // Every evidence item is fixture-sourced, so nothing could have surprised
    // this call. Our own auditor says so. That grade is correct and we keep it.
    const entry = result.decision.entries[0];
    assert.ok(entry !== undefined);
    assert.equal(auditEntry(entry).weak_evidence_only, true);
  });

  it("HOLDS on a sample too small to assert", async () => {
    const result = await pitch(
      prospect(),
      score({ total_queries: 2, competitors: [{ domain: "rival.test", citation_count: 2 }] }),
      baseFlags({ useModel: false }),
    );
    assert.equal(result.decision.disposition, "hold");
    assert.match(result.decision.reason, new RegExp(`${MIN_QUERIES_FOR_ASSERTION}-query floor`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. No fabricated metrics. The load-bearing property.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Independent number extraction. Deliberately does NOT call
 * `allowedNumbersFor()` — the point is to check the copy against the score by a
 * second route, so a bug in the allow-list cannot pass the test that exists to
 * catch it.
 */
function numbersInCopy(text: string, p: Prospect, s: InvisibilityScore): string[] {
  const literals = [
    p.name,
    p.domain,
    p.id,
    ...p.categories,
    ...s.competitors.map((c) => c.domain),
    ...s.queries,
    s.engine,
    "[SPONSORED]",
    SENDER.name,
    SENDER.reply_to ?? "",
    SENDER.website ?? "",
    SENDER.postal_address ?? "",
    s.measured_at ?? "",
    (s.measured_at ?? "").slice(0, 10),
  ].filter((l) => l !== "");
  const masked = maskLiterals(text, literals);
  return [...masked.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)].map((m) => m[0] ?? "");
}

function measuredValues(s: InvisibilityScore): Set<string> {
  const values = new Set<string>([
    String(s.cited_queries),
    String(s.total_queries),
    String(s.total_queries - s.cited_queries),
    String(s.competitors.length),
    String(Math.round(s.visibility * 100)),
  ]);
  for (const c of s.competitors) values.add(String(c.citation_count));
  return values;
}

describe("no draft contains a fabricated metric", () => {
  it("holds across a spread of prospects and scores", async () => {
    const cases: { p: Prospect; s: InvisibilityScore }[] = [
      { p: prospect(), s: score() },
      {
        p: prospect({ id: "p2", name: "Bolt Systems", domain: "bolt.test", categories: ["web3 payments"] }),
        s: score({ visibility: 0.25, cited_queries: 3, total_queries: 12 }),
      },
      {
        p: prospect({ id: "p3", name: "Nimbus", domain: "nimbus.test" }),
        s: score({
          visibility: 0.05,
          cited_queries: 1,
          total_queries: 20,
          competitors: [
            { domain: "a.test", citation_count: 4 },
            { domain: "b.test", citation_count: 4 },
            { domain: "c.test", citation_count: 4 },
          ],
        }),
      },
      {
        p: prospect({ id: "p4", name: "Vector 9", domain: "vector9.test" }),
        s: score({ visibility: 0, cited_queries: 0, total_queries: 8, competitors: [], queries: [] }),
      },
      {
        p: prospect({ id: "p5", name: "Halcyon", domain: "halcyon.test" }),
        s: score({ visibility: 0.3, cited_queries: 6, total_queries: 20, measured_at: null }),
      },
    ];

    for (const { p, s } of cases) {
      const result = await pitch(p, s, baseFlags({ useModel: false }));
      assert.equal(result.decision.disposition, "send", `${p.id} should be pitchable`);
      const allowed = measuredValues(s);
      for (const text of [result.subject, result.body]) {
        for (const raw of numbersInCopy(text, p, s)) {
          assert.ok(
            allowed.has(raw.replace(/%$/, "")),
            `${p.id}: copy contains "${raw}", which is not in the measurement (${[...allowed].join(",")})`,
          );
        }
      }
    }
  });

  it("findFabricatedNumbers catches an invented statistic", () => {
    const p = prospect();
    const s = score();
    const allowed = allowedNumbersFor(p, s, SENDER);
    assert.deepEqual(findFabricatedNumbers("cited in 0 of 12 answers", allowed), []);
    assert.deepEqual(findFabricatedNumbers("you are losing 47% of buyers", allowed), ["47%"]);
    assert.deepEqual(findFabricatedNumbers("we drive 3.5x more leads", allowed), ["3.5"]);
  });

  it("does not mistake digits inside a domain or a date for a claim", () => {
    const p = prospect({ id: "p6", name: "Vector 9", domain: "vector9.test", categories: ["web3"] });
    const s = score();
    const allowed = allowedNumbersFor(p, s, SENDER);
    assert.deepEqual(
      findFabricatedNumbers(
        "Vector 9 (vector9.test) in web3, measured 2026-08-15T12:30:00.000Z",
        allowed,
      ),
      [],
    );
  });

  it("assertNoFabricatedMetrics throws, and there is no flag that disables it", () => {
    const p = prospect();
    const s = score();
    const allowed = allowedNumbersFor(p, s, SENDER);
    assert.throws(
      () => assertNoFabricatedMetrics("subject", "we found 88 missed leads", allowed),
      (err: unknown) => err instanceof CloserError && /88/.test(String(err)),
    );
  });

  it("treats a quoted price as a fabricated metric — Pricing owns that number", () => {
    const p = prospect();
    const s = score();
    const allowed = allowedNumbersFor(p, s, SENDER);
    assert.deepEqual(findFabricatedNumbers("placements start at 2000 cents", allowed), ["2000"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Degradation and overruling the model
// ─────────────────────────────────────────────────────────────────────────────

describe("model path", () => {
  it("degrades to the template with one line when no key is present", async () => {
    const lines: string[] = [];
    const result = await pitch(
      prospect(),
      score(),
      baseFlags({
        env: {},
        fetchImpl: fetchThatMustNotBeCalled(),
        logger: (m) => lines.push(m),
      }),
    );

    assert.equal(result.decision.copy_source, "template");
    assert.ok(
      result.decision.degraded.some((d) => d.includes("ANTHROPIC_API_KEY absent")),
      "the degradation must be recorded, not swallowed",
    );
    assert.equal(lines.filter((l) => l.includes("ANTHROPIC_API_KEY absent")).length, 1);
    assert.ok(result.body.length > 0, "a keyless run still produces a pitch");
  });

  it("never throws when the API errors", async () => {
    const result = await pitch(
      prospect(),
      score(),
      baseFlags({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fetchImpl: (): Promise<Response> =>
          Promise.resolve(new Response("nope", { status: 500 })),
      }),
    );
    assert.equal(result.decision.copy_source, "template");
    assert.ok(result.decision.degraded.some((d) => d.includes("HTTP 500")));
  });

  it("never throws when the network is down", async () => {
    const result = await pitch(
      prospect(),
      score(),
      baseFlags({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fetchImpl: (): Promise<Response> => Promise.reject(new Error("ECONNREFUSED")),
      }),
    );
    assert.equal(result.decision.copy_source, "template");
    assert.ok(result.decision.degraded.some((d) => d.includes("ECONNREFUSED")));
  });

  it("uses model copy when it survives every check", async () => {
    const p = prospect();
    const s = score();
    const body = [
      `${evidenceOpening(p, s)} We asked perplexity/sonar 12 buying-intent questions and rival.test came back in 9 of them.`,
      "",
      `A disclosed placement in an llms.txt is the shelf agents read. Every one carries [SPONSORED] and we measure whether the label survives.`,
      "",
      `Reply if fifteen minutes is worth it. ${OPT_OUT_SENTENCE}`,
    ].join("\n");
    const result = await pitch(
      p,
      s,
      baseFlags({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fetchImpl: modelReturning("Acme Robotics: 0 of 12 AI answers", body),
      }),
    );
    assert.equal(result.decision.copy_source, "model");
    assert.equal(result.subject, "Acme Robotics: 0 of 12 AI answers");
  });

  it("overrules a model that invents a statistic", async () => {
    const p = prospect();
    const s = score();
    const body = `${evidenceOpening(p, s)} You are losing 47% of your pipeline to this. ${OPT_OUT_SENTENCE}`;
    const result = await pitch(
      p,
      s,
      baseFlags({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fetchImpl: modelReturning("Acme Robotics: what we measured", body),
      }),
    );
    assert.equal(result.decision.copy_source, "template");
    assert.ok(result.decision.degraded.some((d) => d.includes("invented number")));
    assert.ok(!result.body.includes("47%"));
  });

  it("overrules a model that fakes urgency or shouts", async () => {
    const p = prospect();
    const s = score();
    const body = `${evidenceOpening(p, s)} ${OPT_OUT_SENTENCE}`;
    const result = await pitch(
      p,
      s,
      baseFlags({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fetchImpl: modelReturning("URGENT: act now before this expires today", body),
      }),
    );
    assert.equal(result.decision.copy_source, "template");
    assert.ok(result.decision.degraded.some((d) => d.includes("rejected")));
  });

  it("overrules a model that drops or buries the measured opening", async () => {
    const p = prospect();
    const s = score();
    const allowed = allowedNumbersFor(p, s, SENDER);
    const problems = checkModelDraft(
      { subject: "A note", body: `Hi there. We do ad placements. ${OPT_OUT_SENTENCE}` },
      p,
      s,
      allowed,
    );
    assert.ok(problems.some((x) => x.includes("dropped the measured opening sentence")));
  });

  it("overrules a model that fakes a reply thread", () => {
    const allowed = allowedNumbersFor(prospect(), score(), SENDER);
    const problems = findComplianceViolations(
      "Re: our conversation",
      `Body. ${OPT_OUT_SENTENCE}`,
      allowed,
    );
    assert.ok(problems.some((x) => x.includes("fakes a reply")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Could it have chosen otherwise?
// ─────────────────────────────────────────────────────────────────────────────

describe("decideAngle — a function of the evidence, not a constant", () => {
  it("names the rival when one domain dominates", () => {
    const verdict = decideAngle(score());
    assert.equal(verdict.angle, "competitor_framed");
    assert.equal(verdict.top_competitor?.domain, "rival.test");
    assert.ok(verdict.margin > 0);
    assert.match(verdict.flip_condition, new RegExp(String(COMPETITOR_CONCENTRATION_FLOOR)));
  });

  it("uses loss framing when citations are spread and they are absent", () => {
    const verdict = decideAngle(
      score({
        visibility: 0.05,
        cited_queries: 1,
        competitors: [
          { domain: "a.test", citation_count: 4 },
          { domain: "b.test", citation_count: 4 },
          { domain: "c.test", citation_count: 4 },
        ],
      }),
    );
    assert.equal(verdict.angle, "loss_framed");
    assert.equal(verdict.runner_up, "opportunity_framed");
  });

  it("uses opportunity framing when they are partly present", () => {
    const verdict = decideAngle(
      score({
        visibility: 0.25,
        cited_queries: 3,
        competitors: [
          { domain: "a.test", citation_count: 4 },
          { domain: "b.test", citation_count: 4 },
          { domain: "c.test", citation_count: 4 },
        ],
      }),
    );
    assert.equal(verdict.angle, "opportunity_framed");
    assert.equal(verdict.runner_up, "loss_framed");
  });

  it("sits on the right side of the loss/opportunity boundary", () => {
    const spread = [
      { domain: "a.test", citation_count: 4 },
      { domain: "b.test", citation_count: 4 },
      { domain: "c.test", citation_count: 4 },
    ];
    assert.equal(
      decideAngle(score({ visibility: LOSS_FRAME_CEILING, competitors: spread })).angle,
      "loss_framed",
    );
    assert.equal(
      decideAngle(score({ visibility: LOSS_FRAME_CEILING + 0.01, competitors: spread })).angle,
      "opportunity_framed",
    );
  });

  it("will not name a rival that does not dominate", () => {
    const verdict = decideAngle(
      score({
        competitors: [
          { domain: "a.test", citation_count: 3 },
          { domain: "b.test", citation_count: 3 },
          { domain: "c.test", citation_count: 3 },
        ],
      }),
    );
    assert.notEqual(verdict.angle, "competitor_framed");
  });

  it("produces different copy for different angles", () => {
    const p = prospect();
    const dominated = score();
    const spread = score({
      visibility: 0.25,
      cited_queries: 3,
      competitors: [
        { domain: "a.test", citation_count: 4 },
        { domain: "b.test", citation_count: 4 },
      ],
    });
    const a = renderTemplate(p, dominated, decideAngle(dominated), SENDER);
    const b = renderTemplate(p, spread, decideAngle(spread), SENDER);
    assert.notEqual(a.subject, b.subject);
    assert.notEqual(a.body, b.body);
    assert.ok(a.subject.includes("rival.test"));
    assert.ok(!b.subject.includes("rival.test"));
  });
});

describe("decideChannel — consent basis decides the route", () => {
  it("emails an address that was published as an invitation", () => {
    const verdict = decideChannel(contact({ source: "advertising_invite" }));
    assert.equal(verdict.channel, "email_direct");
  });

  it("prefers the form when the form is the invited route", () => {
    const verdict = decideChannel(
      contact({ source: "contact_form", form_url: "https://acme.test/contact" }),
    );
    assert.equal(verdict.channel, "contact_form");
  });

  it("defers a scraped address to a human, and pays for it in blockers", async () => {
    const verdict = decideChannel(contact({ source: "scraped" }));
    assert.equal(verdict.channel, "defer_to_human");
    assert.equal(verdict.runner_up, "email_direct");

    const result = await pitch(
      prospect({ contact: contact({ source: "scraped" }) }),
      score(),
      baseFlags({ useModel: false }),
    );
    assert.equal(result.decision.channel, "defer_to_human");
    assert.ok(
      result.decision.send_blockers.some((b) => b.includes("a person must approve contact")),
    );
  });

  it("defers an unknown-provenance address too", () => {
    assert.equal(decideChannel(contact({ source: "unknown" })).channel, "defer_to_human");
  });
});

describe("decideDisposition — reaches every outcome", () => {
  it("returns send, hold and decline on the same code path", () => {
    const send = decideDisposition(prospect(), score(), NOW);
    const hold = decideDisposition(prospect(), score({ source: "fixture" }), NOW);
    const decline = decideDisposition(prospect({ opted_out: true }), score(), NOW);
    assert.deepEqual(
      [send.disposition, hold.disposition, decline.disposition],
      ["send", "hold", "decline"],
    );
  });

  it("states a flip condition in the same units as the evidence", () => {
    const verdict = decideDisposition(prospect(), score({ total_queries: 2 }), NOW);
    assert.match(verdict.flip_condition, /total_queries had been at least 4 \(it was 2\)/);
  });
});

describe("the log shows an agent, not a constant function", () => {
  it("records more than one distinct choice per Closer decision type", async () => {
    const log = openDecisionLog({ logger: () => {} });
    const flags = baseFlags({ useModel: false, log });

    await pitch(prospect(), score(), flags); // competitor angle, email
    await pitch(
      prospect({ id: "p2", domain: "b.test", contact: contact({ source: "scraped" }) }),
      score({
        visibility: 0.25,
        cited_queries: 3,
        competitors: [
          { domain: "x.test", citation_count: 4 },
          { domain: "y.test", citation_count: 4 },
          { domain: "z.test", citation_count: 4 },
        ],
      }),
      flags,
    ); // opportunity angle, defer_to_human
    await pitch(
      prospect({
        id: "p3",
        domain: "c.test",
        contact: contact({ email: null, form_url: "https://c.test/contact", source: "contact_form" }),
      }),
      score({
        visibility: 0.05,
        cited_queries: 1,
        total_queries: 20,
        competitors: [
          { domain: "x.test", citation_count: 4 },
          { domain: "y.test", citation_count: 4 },
        ],
      }),
      flags,
    ); // loss angle, contact_form
    await pitch(prospect({ id: "p4", domain: "d.test", opted_out: true }), score(), flags);

    const stats = computeStats(log.entries());
    const closer = stats.by_agent.find((a) => a.agent === "Closer");
    assert.ok(closer !== undefined);
    assert.equal(closer.total, 10);
    // Ten decisions across three questions; a constant function would show a
    // handful of distinct choices. Anything below this and the agent is a stamp.
    assert.ok(
      closer.distinct_choices >= 7,
      `expected varied choices, got ${closer.distinct_choices}`,
    );
    assert.ok(stats.first_option_rate < 0.9, "position bias would mean the ordering decided");
    assert.equal(stats.chain.ok, true);
  });

  it("suffixes ids rather than colliding when a prospect is pitched twice", async () => {
    const log: DecisionSink = openDecisionLog({ logger: () => {} });
    const flags = baseFlags({ useModel: false, log });
    await pitch(prospect(), score(), flags);
    await pitch(prospect(), score(), flags);
    const ids = log.entries().map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "ids must stay unique");
    assert.ok(ids.includes("dec_closer_prospect_acme_gate"));
    assert.ok(ids.includes("dec_closer_prospect_acme_gate_2"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Disk: dry run by default
// ─────────────────────────────────────────────────────────────────────────────

describe("drafts on disk", () => {
  it("writes nothing when no draftDir is named", async () => {
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false }));
    assert.equal(result.decision.draft_path, null);
    assert.ok(result.decision.degraded.some((d) => d.includes("nothing written to disk")));
  });

  it("writes a draft marked DRY RUN when a directory is named", async () => {
    const dir = join(scratch(), "nested", "drafts");
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false, draftDir: dir }));

    assert.ok(result.decision.draft_path !== null);
    assert.ok(existsSync(result.decision.draft_path));
    const text = readFileSync(result.decision.draft_path, "utf8");
    assert.ok(text.startsWith("DRY RUN — NOT SENT"));
    assert.ok(text.includes("channel: email_direct"));
    assert.ok(text.includes("retrieve_run_0031"));
    assert.ok(text.includes(result.subject));
    assert.ok(text.includes(result.body));
  });

  it("does not overwrite a previous draft for the same prospect", async () => {
    const dir = scratch();
    const flags = baseFlags({ useModel: false, draftDir: dir });
    const first = await pitch(prospect(), score(), flags);
    const second = await pitch(prospect(), score(), flags);
    assert.notEqual(first.decision.draft_path, second.decision.draft_path);
    assert.equal(readdirSync(dir).length, 2);
  });

  it("records the write as an executed decision, with a reversal path", async () => {
    const dir = scratch();
    const result = await pitch(prospect(), score(), baseFlags({ useModel: false, draftDir: dir }));
    const gate = result.decision.entries[0];
    assert.ok(gate !== undefined);
    assert.equal(gate.executed, true);
    assert.match(gate.reversal_path, /Delete the draft at/);
    assert.match(gate.effect, /Nothing sent/);
  });
});
