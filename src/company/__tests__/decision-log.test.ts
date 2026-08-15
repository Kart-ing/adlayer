/**
 * ADLAYER — DecisionLog tests.
 *
 * This log is the artifact that answers "which agent ran the company", so the
 * tests are written from the position of someone trying to break it, not
 * someone trying to demonstrate it works.
 *
 * The five facts this file exists to prove:
 *
 *   1. The chain is tamper-EVIDENT. Editing, reordering, or splicing an entry
 *      after the fact is caught, and the report names the entry.
 *   2. A rubber stamp is DETECTED and RECORDED, never rejected. Refusing to log
 *      weak decisions is how weak decisions vanish from a record, which is the
 *      forgery this module exists to prevent.
 *   3. An incoherent draft THROWS. A chosen option that is not an option is a
 *      bug in calling code and must fail at write time, not render as a
 *      decision.
 *   4. `summarize()` incriminates its own log — position bias, weak evidence,
 *      constant-function agents, zero reversals, nothing executed.
 *   5. Dry run by default: with no path, no byte is written.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  DECISION_AGENTS,
  DECISION_LOG_VERSION,
  DEFECTS,
  MIN_RATIONALE_CHARS,
  DecisionLogError,
  auditEntry,
  canonicalize,
  computeStats,
  hashEntry,
  isEntryShaped,
  openDecisionLog,
  readLog,
  readLogWithDiagnostics,
  registerMechanism,
  registeredMechanisms,
  resolveEvidenceRef,
  summarize,
  summarizeFile,
  verifyChain,
  verifyMechanism,
  type DecisionDraft,
  type DecisionEntry,
} from "../decision-log.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Scratch space
// ─────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "adlayer-declog-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-15T14:20:00.000Z");
const clock = (): Date => NOW;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — one genuinely good decision, and the ways it goes bad
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A real Pricing call: two options that predict materially different worlds, a
 * falsifier stated in the same units as the evidence, and a measurement that
 * could have come back the other way.
 */
function goodDraft(overrides: Partial<DecisionDraft> = {}): DecisionDraft {
  return {
    id: "dec_pricing_acme_01",
    agent: "Pricing",
    question: "What do we charge Acme Gutters for the gutters.example placement?",
    context: "src/company/pricing.ts → pricePlacement()",
    options: [
      {
        id: "opt_cpm",
        summary: "$8 CPM, billed on measured propagation",
        expected_outcome:
          "Revenue scales with propagation but nothing is collected today; if sonar returns absent we bill $0.",
        supported_by: ["ev_visibility"],
        projected_value_cents: 0,
      },
      {
        id: "opt_flat",
        summary: "$20 flat, charged on serve",
        expected_outcome:
          "Exactly $2000 in cents lands today regardless of propagation, and we owe Acme a served block whether or not any engine picks it up.",
        supported_by: ["ev_visibility", "ev_category_demand"],
        projected_value_cents: 2000,
      },
    ],
    chosen_option_id: "opt_flat",
    rationale:
      "Acme is invisible on every query we measured, so a propagation-linked price would bill near zero today and prove nothing. A flat $20 collects a real charge before the 13:00 gate and keeps the money question separate from the measurement question.",
    evidence: [
      {
        id: "ev_visibility",
        claim: "Acme Gutters appears in 0 of 12 sonar answers for its own category queries.",
        source: "measurement",
        ref: "propagation:pc_acme_baseline_0001",
        value: 0,
        observed_at: "2026-08-15T12:40:00.000Z",
      },
      {
        id: "ev_category_demand",
        claim: "home_services is the only category with two competing advertisers in the pipeline.",
        source: "fixture",
        ref: "fixture.json#/sources/0",
        value: 2,
        observed_at: "2026-08-15T11:00:00.000Z",
      },
    ],
    flip_condition:
      "If Acme's measured visibility had been above 0 on any query, the CPM option bills a real number and we would have taken it.",
    flip_to_option_id: "opt_cpm",
    reversible: false,
    reversal_path:
      "Irreversible once charged: a Stripe refund returns the money but not the fact that we priced before measuring.",
    executed: true,
    effect: "Issued a $20 Stripe payment link and charged it.",
    supersedes: null,
    ...overrides,
  };
}

/** A second real decision by a different agent, so agent-level stats have shape. */
function complianceDraft(overrides: Partial<DecisionDraft> = {}): DecisionDraft {
  return {
    id: "dec_compliance_acme_01",
    agent: "Compliance",
    question: "May the Acme creative be served to gutters.example?",
    context: "src/serve/compliance.ts → reviewCreative()",
    options: [
      {
        id: "opt_approve",
        summary: "Approve and serve",
        expected_outcome: "The block reaches the live llms.txt and the propagation clock starts.",
        supported_by: ["ev_gliguard"],
        projected_value_cents: 2000,
      },
      {
        id: "opt_block",
        summary: "Block the creative",
        expected_outcome: "Nothing serves today, the propagation experiment does not run, and we return the copy to the advertiser.",
        supported_by: ["ev_gliguard"],
        projected_value_cents: 0,
      },
    ],
    chosen_option_id: "opt_approve",
    rationale:
      "GLiGuard returned clean across all three tasks and the rendered bytes carry [SPONSORED]. Both gates passed, so a block here would be a refusal without a reason.",
    evidence: [
      {
        id: "ev_gliguard",
        claim: "GLiGuard scored prompt_safety safe 0.99, jailbreak benign 0.97, toxicity benign 0.98.",
        source: "external_api",
        ref: "pioneer:inf_live_0031",
        value: 0.99,
        observed_at: "2026-08-15T12:55:00.000Z",
      },
    ],
    flip_condition:
      "Any GLiGuard label above 0.5, or a rendered block missing [SPONSORED], flips this to block. The disclosure gate has no threshold at all.",
    flip_to_option_id: "opt_block",
    reversible: true,
    reversal_path: "Pause the placement and rewrite the publisher's llms.txt without the block.",
    executed: true,
    effect: "Creative marked approved; render released to the serve path.",
    supersedes: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Write, read, chain
// ─────────────────────────────────────────────────────────────────────────────

describe("writer — append-only JSONL", () => {
  it("round-trips an entry through disk unchanged", () => {
    const path = join(scratch(), "decisions.jsonl");
    const log = openDecisionLog({ path, now: clock });
    const written = log.append(goodDraft());

    const read = readLog(path);
    assert.equal(read.length, 1);
    assert.deepEqual(read[0], written);
    assert.equal(written.seq, 0);
    assert.equal(written.prev_hash, null);
    assert.equal(written.schema_version, DECISION_LOG_VERSION);
    assert.equal(written.decided_at, NOW.toISOString());
  });

  it("creates the directory it was pointed at", () => {
    const path = join(scratch(), "nested", "deeper", "decisions.jsonl");
    openDecisionLog({ path, now: clock }).append(goodDraft());
    assert.ok(existsSync(path));
  });

  it("appends — one line per decision, never a rewrite", () => {
    const path = join(scratch(), "decisions.jsonl");
    const log = openDecisionLog({ path, now: clock });
    log.append(goodDraft());
    const bytesAfterFirst = readFileSync(path, "utf8");
    log.append(complianceDraft());

    const text = readFileSync(path, "utf8");
    assert.ok(text.startsWith(bytesAfterFirst), "the first line must be byte-identical after the second append");
    assert.equal(text.trimEnd().split("\n").length, 2);
  });

  it("chains the second entry to the first", () => {
    const path = join(scratch(), "decisions.jsonl");
    const log = openDecisionLog({ path, now: clock });
    const first = log.append(goodDraft());
    const second = log.append(complianceDraft());

    assert.equal(second.seq, 1);
    assert.equal(second.prev_hash, first.entry_hash);
    assert.equal(verifyChain([first, second]).ok, true);
  });

  it("two independent writers on the same file still chain correctly", () => {
    // Four agents log in one run. A writer that trusted an in-memory cursor
    // would stamp prev_hash: null on the second writer's first entry and break
    // the chain for a reason that has nothing to do with tampering.
    const path = join(scratch(), "decisions.jsonl");
    openDecisionLog({ path, now: clock }).append(goodDraft());
    const b = openDecisionLog({ path, now: clock }).append(complianceDraft());

    assert.equal(b.seq, 1);
    assert.equal(verifyChain(readLog(path)).ok, true);
  });

  it("rejects a duplicate entry id across writers", () => {
    const path = join(scratch(), "decisions.jsonl");
    openDecisionLog({ path, now: clock }).append(goodDraft());
    assert.throws(
      () => openDecisionLog({ path, now: clock }).append(goodDraft()),
      (err: unknown) => err instanceof DecisionLogError && /duplicate entry id/.test(err.message),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tamper evidence — the thing the chain actually buys us
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyChain — retroactive polish is visible", () => {
  function threeEntries(): DecisionEntry[] {
    const path = join(scratch(), "decisions.jsonl");
    const log = openDecisionLog({ path, now: clock });
    log.append(goodDraft());
    log.append(complianceDraft());
    log.append(
      complianceDraft({
        id: "dec_compliance_acme_02",
        supersedes: "dec_compliance_acme_01",
        chosen_option_id: "opt_block",
        flip_to_option_id: "opt_approve",
      }),
    );
    return readLog(path);
  }

  it("verifies a clean log", () => {
    const result = verifyChain(threeEntries());
    assert.equal(result.ok, true);
    assert.equal(result.broken_at, -1);
    assert.equal(result.entries_checked, 3);
  });

  it("catches an entry improved after the fact, and names it", () => {
    const entries = threeEntries();
    const target = entries[1];
    assert.ok(target !== undefined);
    // Exactly the 18:30 temptation: make the rationale read better.
    entries[1] = { ...target, rationale: `${target.rationale} This was obviously correct.` };

    const result = verifyChain(entries);
    assert.equal(result.ok, false);
    assert.equal(result.broken_at, 1);
    assert.match(result.detail ?? "", /was edited after it was written/);
    assert.match(result.detail ?? "", /dec_compliance_acme_01/);
  });

  it("catches a re-hashed edit, because the NEXT entry still points at the old hash", () => {
    // The sophisticated forgery: edit the entry AND recompute its own hash.
    const entries = threeEntries();
    const target = entries[1];
    assert.ok(target !== undefined);
    const { entry_hash: _drop, ...body } = target;
    const forgedBody = { ...body, rationale: "A far more impressive rationale, written later." };
    entries[1] = { ...forgedBody, entry_hash: hashEntry(forgedBody) };

    const result = verifyChain(entries);
    assert.equal(result.ok, false, "re-hashing one entry must not repair the chain");
    assert.equal(result.broken_at, 2, "the break surfaces at the entry that links to it");
    assert.match(result.detail ?? "", /links to/);
  });

  it("catches an entry spliced out of the middle", () => {
    const entries = threeEntries();
    const kept = [entries[0], entries[2]].filter((e): e is DecisionEntry => e !== undefined);
    const result = verifyChain(kept);
    assert.equal(result.ok, false);
    assert.equal(result.broken_at, 1);
    assert.match(result.detail ?? "", /inserted, removed or reordered/);
  });

  it("catches reordering", () => {
    const entries = threeEntries();
    const [a, b, c] = entries;
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    const result = verifyChain([a, c, b]);
    assert.equal(result.ok, false);
    assert.equal(result.broken_at, 1);
  });

  it("catches a hand-appended entry that never went through the writer", () => {
    const path = join(scratch(), "decisions.jsonl");
    const log = openDecisionLog({ path, now: clock });
    log.append(goodDraft());
    const forged: DecisionEntry = {
      ...goodDraft({ id: "dec_forged_01" }),
      schema_version: DECISION_LOG_VERSION,
      seq: 1,
      decided_at: NOW.toISOString(),
      prev_hash: "0".repeat(64),
      entry_hash: "f".repeat(64),
    };
    writeFileSync(path, `${JSON.stringify(forged)}\n`, { encoding: "utf8", flag: "a" });

    const result = verifyChain(readLog(path));
    assert.equal(result.ok, false);
    assert.equal(result.broken_at, 1);
  });
});

describe("canonicalize", () => {
  it("is insensitive to key order, so the chain measures content and not insertion order", () => {
    assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("keeps array order significant — options are ordered and position bias is a real signal", () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });

  it("pins undefined to null so a dropped field cannot silently keep the same hash", () => {
    assert.equal(canonicalize({ a: undefined }), canonicalize({ a: null }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Coherence throws; weakness is recorded
// ─────────────────────────────────────────────────────────────────────────────

describe("assertCoherentDraft — incoherent drafts throw", () => {
  const path = (): string => join(scratch(), "decisions.jsonl");

  function rejects(draft: DecisionDraft, pattern: RegExp): void {
    assert.throws(
      () => openDecisionLog({ path: path(), now: clock }).append(draft),
      (err: unknown) => err instanceof DecisionLogError && pattern.test(err.message),
    );
  }

  it("rejects a chosen option that is not one of the options", () => {
    rejects(goodDraft({ chosen_option_id: "opt_nonexistent" }), /not one of its options/);
  });

  it("rejects a flip target that is not one of the options", () => {
    rejects(goodDraft({ flip_to_option_id: "opt_ghost" }), /would flip to/);
  });

  it("rejects flipping to the option it already chose", () => {
    rejects(goodDraft({ flip_to_option_id: "opt_flat" }), /already chose/);
  });

  it("rejects an option citing evidence that is not in the entry", () => {
    const draft = goodDraft();
    const first = draft.options[0];
    assert.ok(first !== undefined);
    draft.options[0] = { ...first, supported_by: ["ev_imaginary"] };
    rejects(draft, /cites evidence "ev_imaginary"/);
  });

  it("rejects duplicate option ids", () => {
    const draft = goodDraft();
    const first = draft.options[0];
    assert.ok(first !== undefined);
    draft.options.push({ ...first });
    rejects(draft, /duplicate option id/);
  });

  it("rejects an agent outside the closed union", () => {
    rejects(goodDraft({ agent: "Prospecter" as never }), /unknown agent/);
  });

  it("rejects an entry with no options at all", () => {
    rejects(goodDraft({ options: [] }), /no options at all/);
  });

  it("rejects an entry with no question", () => {
    rejects(goodDraft({ question: "   " }), /no question/);
  });

  it("nothing is written when a draft is rejected", () => {
    const p = path();
    assert.throws(() => openDecisionLog({ path: p, now: clock }).append(goodDraft({ chosen_option_id: "x" })));
    assert.equal(existsSync(p), false);
  });
});

describe("weak decisions are recorded, not rejected", () => {
  it("logs a rubber stamp and grades it a rubber stamp", () => {
    // Refusing to write this is how it disappears from the record. It gets
    // written, and the summary calls it what it is.
    const path = join(scratch(), "decisions.jsonl");
    const stamp: DecisionDraft = {
      id: "dec_stamp_01",
      agent: "Closer",
      question: "Should we send the pitch?",
      context: "src/company/closer.ts",
      options: [
        { id: "opt_send", summary: "Send it", expected_outcome: "The email goes out.", supported_by: [], projected_value_cents: null },
      ],
      chosen_option_id: "opt_send",
      rationale: "Seemed right.",
      evidence: [],
      flip_condition: "",
      flip_to_option_id: null,
      reversible: false,
      reversal_path: "",
      executed: false,
      effect: "Would have queued an email.",
      supersedes: null,
    };
    const entry = openDecisionLog({ path, now: clock }).append(stamp);
    const audit = auditEntry(entry);

    assert.equal(audit.strength, "rubber_stamp");
    assert.ok(audit.defects.includes(DEFECTS.singleOption));
    assert.ok(audit.defects.includes(DEFECTS.noFlipCondition));
    assert.ok(audit.defects.includes(DEFECTS.noEvidence));
    assert.ok(audit.defects.includes(DEFECTS.thinRationale));
    assert.ok(audit.defects.includes(DEFECTS.missingReversalPath));
    assert.equal(readLog(path).length, 1, "the rubber stamp is still on the record");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. auditEntry — every way a fake looks fake
// ─────────────────────────────────────────────────────────────────────────────

describe("auditEntry", () => {
  /** Stamp a draft into an entry without going near the disk. */
  function entryOf(draft: DecisionDraft): DecisionEntry {
    return openDecisionLog({ now: clock }).append(draft);
  }

  it("passes a real decision with no defects", () => {
    const audit = auditEntry(entryOf(goodDraft()));
    assert.deepEqual(audit.defects, []);
    assert.equal(audit.strength, "decision");
    assert.equal(audit.distinct_outcomes, 2);
    assert.equal(audit.chose_first_option, false);
    assert.equal(audit.weak_evidence_only, false);
  });

  it("catches options that predict the same world — two names for one option", () => {
    const draft = goodDraft();
    const [a, b] = draft.options;
    assert.ok(a !== undefined && b !== undefined);
    draft.options = [a, { ...b, expected_outcome: a.expected_outcome }];
    const audit = auditEntry(entryOf(draft));

    assert.ok(audit.defects.includes(DEFECTS.identicalOutcomes));
    assert.equal(audit.strength, "rubber_stamp");
    assert.equal(audit.distinct_outcomes, 1);
  });

  it("ignores punctuation and case when comparing counterfactuals", () => {
    const draft = goodDraft();
    const [a, b] = draft.options;
    assert.ok(a !== undefined && b !== undefined);
    draft.options = [a, { ...b, expected_outcome: `${a.expected_outcome.toUpperCase()}!!!` }];
    assert.ok(auditEntry(entryOf(draft)).defects.includes(DEFECTS.identicalOutcomes));
  });

  it("catches an option with no counterfactual at all", () => {
    const draft = goodDraft();
    const [a, b] = draft.options;
    assert.ok(a !== undefined && b !== undefined);
    draft.options = [a, { ...b, expected_outcome: "  " }];
    assert.ok(auditEntry(entryOf(draft)).defects.includes(DEFECTS.missingCounterfactual));
  });

  it("catches a flip condition that just restates the rationale", () => {
    const draft = goodDraft();
    const audit = auditEntry(entryOf({ ...draft, flip_condition: draft.rationale }));
    assert.ok(audit.defects.includes(DEFECTS.circularFlipCondition));
    assert.equal(audit.strength, "rubber_stamp");
  });

  it("catches a decision resting only on fixture and model-prior evidence", () => {
    const draft = goodDraft();
    draft.evidence = draft.evidence.map((e) => ({ ...e, source: "model_prior" as const }));
    const audit = auditEntry(entryOf(draft));

    assert.ok(audit.defects.includes(DEFECTS.weakEvidenceOnly));
    assert.equal(audit.weak_evidence_only, true);
    assert.equal(audit.strength, "rubber_stamp", "nothing in the world could have surprised it");
  });

  it("catches evidence a reader cannot independently open", () => {
    const draft = goodDraft();
    draft.evidence = draft.evidence.map((e) => ({ ...e, ref: null }));
    const audit = auditEntry(entryOf(draft));
    assert.ok(audit.defects.includes(DEFECTS.noResolvableEvidence));
    assert.equal(audit.strength, "weak", "unresolvable refs are thin, not fatal");
  });

  it("catches evidence that no option actually uses", () => {
    const draft = goodDraft();
    draft.options = draft.options.map((o) => ({ ...o, supported_by: [] }));
    assert.ok(auditEntry(entryOf(draft)).defects.includes(DEFECTS.evidenceUnlinked));
  });

  it("catches a rationale too short to be an explanation", () => {
    const draft = goodDraft({ rationale: "Best price." });
    assert.ok(draft.rationale.length < MIN_RATIONALE_CHARS);
    assert.ok(auditEntry(entryOf(draft)).defects.includes(DEFECTS.thinRationale));
  });

  it("catches an irreversible decision with no account of what is unrecoverable", () => {
    const draft = goodDraft({ reversible: false, reversal_path: "" });
    assert.ok(auditEntry(entryOf(draft)).defects.includes(DEFECTS.missingReversalPath));
  });

  it("reports position bias when the first option was taken", () => {
    const draft = goodDraft({ chosen_option_id: "opt_cpm", flip_to_option_id: "opt_flat" });
    assert.equal(auditEntry(entryOf(draft)).chose_first_option, true);
  });

  it("never throws on a hand-mangled entry read off disk", () => {
    const broken = { ...openDecisionLog({ now: clock }).append(goodDraft()) } as unknown as DecisionEntry;
    // Simulate a hand-edited line: fields the type promised are simply gone.
    (broken as unknown as Record<string, unknown>)["options"] = null;
    (broken as unknown as Record<string, unknown>)["evidence"] = undefined;
    (broken as unknown as Record<string, unknown>)["rationale"] = 42;
    (broken as unknown as Record<string, unknown>)["flip_condition"] = null;

    const audit = auditEntry(broken);
    assert.equal(audit.strength, "rubber_stamp");
    assert.ok(audit.defects.includes(DEFECTS.noEvidence));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Reader — malformed lines are reported, never silently dropped
// ─────────────────────────────────────────────────────────────────────────────

describe("reader", () => {
  it("returns an empty log for a file that does not exist", () => {
    assert.deepEqual(readLog(join(scratch(), "absent.jsonl")), []);
  });

  it("reports unparseable lines with their line numbers instead of hiding them", () => {
    const path = join(scratch(), "decisions.jsonl");
    const log = openDecisionLog({ path, now: clock });
    log.append(goodDraft());
    writeFileSync(path, "{not json\n", { encoding: "utf8", flag: "a" });
    log.append(complianceDraft());

    const read = readLogWithDiagnostics(path);
    assert.equal(read.entries.length, 2);
    assert.equal(read.malformed.length, 1);
    assert.equal(read.malformed[0]?.line, 2);
  });

  it("reports a line that parses but is not an entry", () => {
    const path = join(scratch(), "decisions.jsonl");
    openDecisionLog({ path, now: clock }).append(goodDraft());
    writeFileSync(path, `${JSON.stringify({ hello: "world" })}\n`, { encoding: "utf8", flag: "a" });

    const read = readLogWithDiagnostics(path);
    assert.equal(read.malformed.length, 1);
    assert.equal(read.malformed[0]?.reason, "not a DecisionEntry");
  });

  it("isEntryShaped rejects the obvious non-entries", () => {
    assert.equal(isEntryShaped(null), false);
    assert.equal(isEntryShaped([]), false);
    assert.equal(isEntryShaped("x"), false);
    assert.equal(isEntryShaped({ id: "a" }), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Dry run by default
// ─────────────────────────────────────────────────────────────────────────────

describe("safety posture", () => {
  it("writes nothing when no path is given", () => {
    const dir = scratch();
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft());

    assert.equal(log.path, null);
    assert.equal(log.entries().length, 1);
    assert.deepEqual(readLog(join(dir, "decisions.jsonl")), []);
  });

  it("dryRun leaves a named file untouched and says so in one line", () => {
    const path = join(scratch(), "decisions.jsonl");
    const lines: string[] = [];
    const log = openDecisionLog({ path, dryRun: true, now: clock, logger: (m) => lines.push(m) });
    log.append(goodDraft());

    assert.equal(existsSync(path), false);
    assert.equal(log.path, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /dry run/);
  });

  it("a memory log still chains its entries", () => {
    const log = openDecisionLog({ now: clock });
    const a = log.append(goodDraft());
    const b = log.append(complianceDraft());
    assert.equal(b.prev_hash, a.entry_hash);
    assert.equal(verifyChain(log.entries()).ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. summarize — the log incriminates itself
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize", () => {
  it("says so plainly when there is nothing to show", () => {
    const text = summarize([]);
    assert.match(text, /No decisions recorded/);
    assert.doesNotMatch(text, /decisions ·/);
  });

  it("leads with who decided, and shows the falsifier for each decision", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft());
    log.append(complianceDraft());
    const text = summarize(log.entries());

    assert.match(text, /WHO RAN THE COMPANY/);
    assert.match(text, /Pricing/);
    assert.match(text, /Compliance/);
    assert.match(text, /WHAT WOULD HAVE CHANGED EACH ANSWER/);
    assert.match(text, /WRONG IF/);
    assert.match(text, /chain VERIFIED across 2 entries/);
    assert.match(text, /IRREVERSIBLE/);
    assert.match(text, /EXECUTED/);
  });

  it("names its own rubber stamps rather than filtering them out", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft());
    log.append({
      ...complianceDraft({ id: "dec_stamp_02" }),
      flip_condition: "",
      flip_to_option_id: null,
      evidence: [],
      options: [
        {
          id: "opt_only",
          summary: "Approve",
          expected_outcome: "It ships.",
          supported_by: [],
          projected_value_cents: null,
        },
      ],
      chosen_option_id: "opt_only",
    });

    const text = summarize(log.entries());
    assert.match(text, /1 rubber stamp/);
    assert.match(text, /RUBBER STAMPS by our own test/);
    assert.match(text, new RegExp(DEFECTS.noFlipCondition));
    assert.match(text, /dec_stamp_02/);
  });

  it("flags an agent that decided three times and chose the same thing every time", () => {
    const log = openDecisionLog({ now: clock });
    for (let i = 0; i < 3; i++) {
      log.append(complianceDraft({ id: `dec_compliance_${i}` }));
    }
    const stats = computeStats(log.entries());
    assert.equal(stats.by_agent[0]?.distinct_choices, 1);
    assert.ok(stats.warnings.some((w) => /constant function/.test(w)));
    assert.match(summarize(log.entries()), /constant function/);
  });

  it("flags position bias when every decision took the first option listed", () => {
    const log = openDecisionLog({ now: clock });
    for (let i = 0; i < 4; i++) {
      log.append(
        complianceDraft({
          id: `dec_bias_${i}`,
          chosen_option_id: "opt_approve",
          flip_to_option_id: "opt_block",
        }),
      );
    }
    const stats = computeStats(log.entries());
    assert.equal(stats.first_option_rate, 1);
    assert.ok(stats.warnings.some((w) => /FIRST option listed/.test(w)));
  });

  it("flags a log where nothing was ever executed", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft({ executed: false }));
    const stats = computeStats(log.entries());
    assert.ok(stats.warnings.some((w) => /simulation of an agent-run company/.test(w)));
  });

  it("flags a log with no reversals once it is big enough to be suspicious", () => {
    const log = openDecisionLog({ now: clock });
    for (let i = 0; i < 8; i++) log.append(goodDraft({ id: `dec_${i}` }));
    const stats = computeStats(log.entries());
    assert.equal(stats.reversals, 0);
    assert.ok(stats.warnings.some((w) => /zero reversals/.test(w)));
  });

  it("counts a reversal and shows it as the agent changing its mind on the record", () => {
    const log = openDecisionLog({ now: clock });
    log.append(complianceDraft());
    log.append(
      complianceDraft({
        id: "dec_compliance_acme_02",
        chosen_option_id: "opt_block",
        flip_to_option_id: "opt_approve",
        supersedes: "dec_compliance_acme_01",
      }),
    );
    const stats = computeStats(log.entries());
    assert.equal(stats.reversals, 1);
    assert.equal(stats.by_agent[0]?.distinct_choices, 2);
    assert.match(summarize(log.entries()), /REVERSES dec_compliance_acme_01/);
  });

  it("flags an entry superseding an id that is not in the log", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft({ supersedes: "dec_that_never_existed" }));
    assert.ok(computeStats(log.entries()).warnings.some((w) => /is not in this log/.test(w)));
  });

  it("reports human decisions as human, in the same ledger", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft());
    log.append(
      goodDraft({
        id: "dec_human_01",
        agent: "Human",
        question: "Do we cut the Band track?",
      }),
    );
    const stats = computeStats(log.entries());
    assert.equal(stats.human_decisions, 1);
    assert.equal(stats.agent_decisions, 1);
    assert.match(summarize(log.entries()), /were decided by a person/);
  });

  it("says every decision was human when that is the truth", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft({ agent: "Human" }));
    assert.ok(computeStats(log.entries()).warnings.some((w) => /no agent ran anything/.test(w)));
  });

  it("surfaces a broken chain at the top of the summary", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft());
    log.append(complianceDraft());
    const entries = log.entries();
    const target = entries[0];
    assert.ok(target !== undefined);
    entries[0] = { ...target, rationale: "rewritten later" };

    const text = summarize(entries);
    assert.match(text, /chain BROKEN at entry 0/);
    assert.match(text, /CHAIN BROKEN/);
  });

  it("always carries the section admitting what it does not prove", () => {
    const log = openDecisionLog({ now: clock });
    log.append(goodDraft());
    const text = summarize(log.entries());

    assert.match(text, /WHAT THIS LOG DOES NOT PROVE/);
    assert.match(text, /does not/);
    assert.match(text, /we wrote both the agents/);
    assert.match(text, /position bias/);
  });

  it("carries malformed-line count from the file through to the summary", () => {
    const path = join(scratch(), "decisions.jsonl");
    openDecisionLog({ path, now: clock }).append(goodDraft());
    writeFileSync(path, "garbage\n", { encoding: "utf8", flag: "a" });

    const text = summarizeFile(path);
    assert.match(text, /unreadable line/);
  });

  it("caps the detail block so it stays a 30-second read", () => {
    const log = openDecisionLog({ now: clock });
    for (let i = 0; i < 20; i++) log.append(goodDraft({ id: `dec_${i}` }));
    const text = summarize(log.entries(), { maxDetail: 5 });
    assert.match(text, /… 15 more in the log file/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The union is closed, and stays closed
// ─────────────────────────────────────────────────────────────────────────────

describe("DecisionAgent", () => {
  it("is exactly the org in PRD §2, plus Human", () => {
    assert.deepEqual([...DECISION_AGENTS], [
      "Prospector",
      "Closer",
      "Pricing",
      "Compliance",
      "Format",
      "Human",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. THE COIN-FLIP AGENT — the result that falsified this module's own claim
//
// An earlier version of decision-log.ts claimed forging a convincing log was
// more expensive than building real agents. A reviewer disproved it in four
// minutes with a 40-line agent whose every choice is `Math.random()`, templated
// options, a templated rationale and a templated flip condition: 14 of 14
// entries graded "decision", chain VERIFIED, zero warnings.
//
// That result is preserved here rather than deleted, because the only defence
// against re-shipping shape-checking-as-proof is a test that FAILS the day
// someone claims the shape checks catch a forgery. They do not, and this test
// asserts they do not.
// ─────────────────────────────────────────────────────────────────────────────

describe("a coin-flip agent", () => {
  /** 40 lines. Every choice is a coin flip. Every field is a template. */
  function coinFlipEntries(n: number, withReplay: { fn: string } | null = null): DecisionEntry[] {
    const sink = openDecisionLog({ now: clock });
    const agents = ["Prospector", "Closer", "Pricing"] as const;
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      const chosen = roll < 0.5 ? "opt_a" : "opt_b";
      const agent = agents[i % agents.length] as DecisionEntry["agent"];
      sink.append({
        id: `forged_${i}`,
        agent,
        question: `Question number ${i}?`,
        context: "src/company/forgery.ts → flip()",
        options: [
          {
            id: "opt_a",
            summary: `Option A for decision ${i}`,
            expected_outcome: `Outcome A follows for decision ${i}, and revenue moves up.`,
            supported_by: ["ev_0"],
            projected_value_cents: 2000,
          },
          {
            id: "opt_b",
            summary: `Option B for decision ${i}`,
            expected_outcome: `Outcome B follows for decision ${i}, and revenue moves down.`,
            supported_by: ["ev_0"],
            projected_value_cents: 0,
          },
        ],
        chosen_option_id: chosen,
        rationale:
          `Decision ${i} was taken on the measured signal, which crossed the threshold we ` +
          `set in advance, so the option above was the defensible one to take here.`,
        evidence: [
          {
            id: "ev_0",
            claim: `Signal ${i} measured at ${roll.toFixed(3)}.`,
            source: "measurement",
            ref: "src/company/decision-log.ts#auditEntry",
            value: roll,
            observed_at: "2026-08-15T14:00:00.000Z",
          },
        ],
        flip_condition: `If signal ${i} had been on the other side of 0.5, the other option wins.`,
        flip_to_option_id: chosen === "opt_a" ? "opt_b" : "opt_a",
        replay: withReplay === null ? null : { fn: withReplay.fn, input: { i }, flip_input: { i } },
        reversible: true,
        reversal_path: "Re-run the forgery.",
        executed: true,
        effect: `Decision ${i} applied.`,
        supersedes: null,
      });
    }
    return sink.entries();
  }

  it("passes EVERY shape check — this is the finding, not a bug", () => {
    const entries = coinFlipEntries(14);
    const stats = computeStats(entries);

    assert.equal(stats.total, 14);
    assert.equal(stats.rubber_stamps, 0, "shape checks cannot see a coin flip");
    assert.equal(stats.real, 14, "all 14 grade well-formed");
    assert.equal(stats.chain.ok, true);
  });

  it("reaches ZERO mechanism-verified entries, which is the check it cannot pass", () => {
    const stats = computeStats(coinFlipEntries(14));
    assert.equal(stats.mechanism_verified, 0);
    assert.equal(stats.mechanism_absent, 14);
  });

  it("makes the summary say out loud that well-formed is all it measured", () => {
    const text = summarize(coinFlipEntries(14), { detail: false });
    // The headline must not claim these "hold up".
    assert.match(text, /14 well-formed/);
    assert.match(text, /shape only — a random agent passes this line/);
    assert.doesNotMatch(text, /14 hold up/);
    // And the warning must fire: nothing here was re-run.
    assert.match(text, /0 of 14 decisions had their decision function re-run/);
    assert.match(text, /WELL-FORMEDNESS, which a coin-flip agent also passes/);
  });

  it("is REFUTED the moment it claims a mechanism, because Math.random does not reproduce", () => {
    registerMechanism("forgery.flip", () => (Math.random() < 0.5 ? "opt_a" : "opt_b"));
    const entries = coinFlipEntries(20, { fn: "forgery.flip" });
    const stats = computeStats(entries);
    // Two independent reasons this cannot verify:
    //   1. `Math.random()` does not reproduce a recorded choice — refuted.
    //   2. The forger's flip_input is a copy of the input, so nothing was
    //      substituted. That is checked BEFORE the second run, which closes the
    //      loophole where a non-deterministic function "flips" by luck.
    assert.equal(stats.mechanism_verified, 0, "a forgery must never reach verified");
    assert.equal(stats.mechanism_refuted, 20, "every forged entry is caught");
    assert.match(summarize(entries, { detail: false }), /CONTRADICTED by re-running/);
  });

  it("cannot escape by going deterministic — a falsifier that does not falsify is fatal", () => {
    // The obvious next move for a forger: make the function constant so the
    // first assertion passes. The second assertion then demands that the stated
    // flip value CHANGES the answer, which is the definition of the choice
    // being a function of the evidence.
    registerMechanism("forgery.constant", () => "opt_a");
    const sink = openDecisionLog({ now: clock });
    const entry = sink.append({
      ...goodDraft({ id: "forged_constant" }),
      options: [
        {
          id: "opt_a",
          summary: "A",
          expected_outcome: "World A, with revenue up.",
          supported_by: ["ev_visibility"],
          projected_value_cents: 100,
        },
        {
          id: "opt_b",
          summary: "B",
          expected_outcome: "World B, with revenue down.",
          supported_by: ["ev_visibility"],
          projected_value_cents: 0,
        },
      ],
      chosen_option_id: "opt_a",
      flip_to_option_id: "opt_b",
      replay: { fn: "forgery.constant", input: { x: 1 }, flip_input: { x: 2 } },
    });

    const audit = auditEntry(entry);
    assert.equal(audit.mechanism, "flip_did_not_flip");
    assert.ok(audit.defects.includes(DEFECTS.flipDoesNotFlip));
    assert.equal(audit.strength, "rubber_stamp", "a decorative falsifier is fatal, not cosmetic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Mechanism replay — the auditor runs the code, not the write-up
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyMechanism", () => {
  /** A real decision function: the choice is a function of the input. */
  const realFn = (raw: unknown): string => {
    const v = Number((raw as { visibility?: number } | null)?.visibility ?? 1);
    return v < 0.4 ? "opt_a" : "opt_b";
  };

  function replayDraft(replay: DecisionDraft["replay"]): DecisionEntry {
    return openDecisionLog({ now: clock }).append({
      ...goodDraft({ id: `replay_${Math.random().toString(36).slice(2)}` }),
      options: [
        {
          id: "opt_a",
          summary: "A",
          expected_outcome: "World A, revenue up.",
          supported_by: ["ev_visibility"],
          projected_value_cents: 100,
        },
        {
          id: "opt_b",
          summary: "B",
          expected_outcome: "World B, revenue down.",
          supported_by: ["ev_visibility"],
          projected_value_cents: 0,
        },
      ],
      chosen_option_id: "opt_a",
      flip_to_option_id: "opt_b",
      replay,
    });
  }

  it("verifies when the code reproduces the choice AND the flip input flips it", () => {
    registerMechanism("test.real", realFn);
    const check = verifyMechanism(
      replayDraft({ fn: "test.real", input: { visibility: 0.1 }, flip_input: { visibility: 0.9 } }),
    );
    assert.equal(check.status, "verified");
    assert.equal(check.replayed_choice, "opt_a");
    assert.equal(check.replayed_flip_choice, "opt_b");
  });

  it("REFUTES a record the code disagrees with", () => {
    registerMechanism("test.real", realFn);
    // The entry says opt_a, but at visibility 0.9 the code says opt_b.
    const check = verifyMechanism(
      replayDraft({ fn: "test.real", input: { visibility: 0.9 }, flip_input: { visibility: 0.1 } }),
    );
    assert.equal(check.status, "refuted");
    assert.match(check.detail, /the record and the code disagree/);
  });

  it("refuses to bank a half-check when no flip input was recorded", () => {
    registerMechanism("test.real", realFn);
    const check = verifyMechanism(
      replayDraft({ fn: "test.real", input: { visibility: 0.1 }, flip_input: null }),
    );
    assert.equal(check.status, "flip_did_not_flip");
    assert.match(check.detail, /nothing shows the choice depends on the evidence/);
  });

  it("reports `unregistered` rather than passing an entry it could not run", () => {
    const check = verifyMechanism(
      replayDraft({ fn: "test.never_registered", input: {}, flip_input: {} }),
    );
    assert.equal(check.status, "unregistered");
    assert.equal(auditEntry(replayDraft({ fn: "test.never_registered", input: {}, flip_input: {} })).defects.length, 0,
      "an unarmed check is not a defect — penalising it would push agents to fake a replay");
  });

  it("reports `absent` when there is no replay pointer, and does not count it as a pass", () => {
    assert.equal(verifyMechanism(replayDraft(null)).status, "absent");
    const stats = computeStats([replayDraft(null)]);
    assert.equal(stats.mechanism_verified, 0);
    assert.equal(stats.mechanism_absent, 1);
  });

  it("survives a decision function that throws on its own recorded input", () => {
    registerMechanism("test.throws", () => {
      throw new Error("boom");
    });
    const check = verifyMechanism(replayDraft({ fn: "test.throws", input: {}, flip_input: {} }));
    assert.equal(check.status, "refuted");
    assert.match(check.detail, /boom/);
  });

  it("lists what is runnable in this process, so a reader can see the check was armed", () => {
    registerMechanism("test.real", realFn);
    assert.ok(registeredMechanisms().includes("test.real"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Ref resolution — does the evidence point at anything a reader can open?
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveEvidenceRef", () => {
  const root = "/Users/kartikeypandey/Documents/0Human";

  it("opens a repo file that exists", () => {
    const r = resolveEvidenceRef("src/contract.ts", root);
    assert.equal(r.kind, "repo_path");
    assert.equal(r.resolved, true);
  });

  it("checks the anchor, not just the file", () => {
    assert.equal(resolveEvidenceRef("src/contract.ts#DISCLOSURE_TAG", root).resolved, true);
    const stale = resolveEvidenceRef("src/contract.ts#NOT_A_REAL_SYMBOL", root);
    assert.equal(stale.resolved, false);
    assert.match(stale.detail, /the anchor is stale/);
  });

  it("reports a repo path that does not exist as pointing at nothing", () => {
    const r = resolveEvidenceRef("src/company/does-not-exist.ts", root);
    assert.equal(r.resolved, false);
    assert.equal(r.kind, "repo_path");
    assert.match(r.detail, /points at nothing/);
  });

  it("resolves a JSON pointer into fixture.json, and catches one that misses", () => {
    assert.equal(resolveEvidenceRef("fixture.json#/score", root).resolved, true);
    assert.equal(resolveEvidenceRef("fixture.json#/no_such_key", root).resolved, false);
  });

  it("never claims to have opened a URL or a Stripe id", () => {
    const url = resolveEvidenceRef("https://stripe.com/x", root);
    assert.equal(url.kind, "url");
    assert.equal(url.resolved, false);
    const stripe = resolveEvidenceRef("ch_3QabcdEFGH12345", root);
    assert.equal(stripe.kind, "stripe_id");
    assert.equal(stripe.resolved, false);
  });

  it("marks a fabricated repo ref as a DEFECT on the entry that cites it", () => {
    const entry = openDecisionLog({ now: clock }).append(
      goodDraft({
        id: "fabricated_ref",
        evidence: [
          {
            id: "ev_visibility",
            claim: "Measured somewhere.",
            source: "measurement",
            ref: "src/company/invented-file.ts",
            value: 0,
            observed_at: "2026-08-15T12:40:00.000Z",
          },
        ],
        options: [
          {
            id: "opt_cpm",
            summary: "A",
            expected_outcome: "World A, revenue up.",
            supported_by: ["ev_visibility"],
            projected_value_cents: 0,
          },
          {
            id: "opt_flat",
            summary: "B",
            expected_outcome: "World B, revenue down.",
            supported_by: ["ev_visibility"],
            projected_value_cents: 2000,
          },
        ],
      }),
    );
    const audit = auditEntry(entry, { root });
    assert.ok(audit.defects.includes(DEFECTS.refPointsAtNothing));
    assert.equal(audit.refs_broken, 1);
    assert.equal(audit.refs_resolved, 0);
  });

  it("prints the resolved count next to the well-formed count", () => {
    const sink = openDecisionLog({ now: clock });
    sink.append(goodDraft());
    const text = summarize(sink.entries(), { detail: false, root });
    assert.match(text, /cite something this checker opened/);
    assert.match(text, /refs resolved/);
  });
});
