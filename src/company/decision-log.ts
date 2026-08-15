/**
 * ADLAYER — the DecisionLog.
 *
 * This file is our answer to the one question the panel will actually ask:
 * "which agent ran the company?" It has to survive a skeptical reading by
 * people who have seen a hundred logs of foregone conclusions.
 *
 * ── WHAT THIS MODULE IS, AND IS NOT ──────────────────────────────────────────
 *
 * Be honest up front: this module is a LEDGER, not an agent. It makes no
 * decisions. It is therefore held to a different bar than the five agents in
 * PRD §2 — not "could it have chosen otherwise" but "does it make a fake
 * expensive, and does it hand a reader the tools to catch us."
 *
 * A decision log is the easiest artifact in this entire project to fake. You
 * write twenty entries by hand, every one an obvious call dressed as a
 * judgement, and it renders beautifully. So the design goal is not "record
 * decisions." It is: **make forging a convincing log more expensive than
 * building real agents, and make an unconvincing log self-evident — including
 * to us.**
 *
 * ── THE COIN-FLIP RESULT. READ THIS BEFORE BELIEVING ANY NUMBER BELOW ────────
 *
 * An earlier version of this file claimed forging was expensive. That claim was
 * FALSE and we proved it against ourselves. A 40-line agent whose every choice
 * is `Math.random()`, with templated options, templated rationales and a
 * templated flip condition, was run through `auditEntry()`. Result: 14 of 14
 * entries graded "decision", chain VERIFIED, zero warnings, one reversal, three
 * agents with 2-3 distinct choices each. It scored BETTER than the real
 * Prospector. Forging took four minutes.
 *
 * The reason is that everything `auditEntry()` originally checked was SHAPE: two
 * or more options, non-identical `expected_outcome` strings, a non-empty
 * `flip_condition` that is not verbatim the rationale, one evidence item with a
 * non-empty `ref`, forty characters of rationale. Nothing anywhere verified that
 * the chosen option was a FUNCTION of the evidence.
 *
 * That test is now in the suite (`decision-log.test.ts` → "a coin-flip agent")
 * and it still passes: a random agent still produces well-formed entries. We did
 * not delete the embarrassing result, we made it a regression test, because the
 * only defence against re-shipping shape-checking-as-proof is a test that fails
 * loudly the day someone claims otherwise again.
 *
 * ── WHAT ACTUALLY SEPARATES THE COIN-FLIP AGENT FROM A REAL ONE ──────────────
 *
 * MECHANISM REPLAY (`DecisionEntry.replay`, `verifyMechanism()`). An entry may
 * carry a pointer at the PURE FUNCTION that produced it, the exact input it was
 * called with, and the same input with the flip condition's stated value
 * substituted. The auditor then RE-RUNS that function twice and checks:
 *
 *     fn(replay.input)      === entry.chosen_option_id      ← the record matches the code
 *     fn(replay.flip_input) === entry.flip_to_option_id     ← the falsifier actually flips it
 *
 * A coin-flip agent cannot pass this. `Math.random()` does not reproduce, so the
 * first assertion fails outright; and if you make it deterministic to get past
 * that, the second assertion demands that a stated input change moves the output,
 * which is the definition of the choice being a function of the evidence. To fake
 * a mechanism-verified log you must write a decision function whose behaviour
 * matches every entry at two points — which is to say, you must build the agent.
 * That is the asymmetry the old header claimed and did not have.
 *
 * One loophole, found by running the forgery and closed: a `flip_input` that is
 * a COPY of `input` proves nothing, and worse, it lets a NON-DETERMINISTIC
 * function score `verified` by luck — call it twice on the same input, get two
 * different answers, and the second satisfies the flip. Identity is therefore
 * rejected before the second run, not after it.
 *
 * A refuted replay is FATAL (`DEFECTS.mechanismRefuted`): it means the record and
 * the code disagree, and the record is the thing that is wrong. A flip that does
 * not flip is also fatal (`DEFECTS.flipDoesNotFlip`): a falsifier that changes
 * nothing is decoration in the one field this module said a faker hates.
 *
 * What it still does NOT prove: that the pure function is a GOOD decision
 * procedure, or that its inputs were honestly measured. A verified mechanism says
 * "this agent really did decide this way", not "this agent was right".
 *
 * ── REF RESOLUTION ───────────────────────────────────────────────────────────
 *
 * `resolveEvidenceRef()` opens what an entry cites. A path into the repo either
 * exists or it does not; an `#anchor` either appears in that file or it does not.
 * URLs and Stripe ids are reported as UNVERIFIED rather than counted as resolved,
 * because this checker makes no network calls. `summarize()` prints the resolved
 * count next to the well-formed count so a reader can see how much of the
 * evidence is checkable from a clone of the repo alone.
 *
 * ── THE CENTRAL DISTINCTION: A DECISION vs A RUBBER STAMP ────────────────────
 *
 * A decision is not "an agent produced an output." A decision is a fork where
 * more than one option was defensible, one was taken, and the agent could have
 * been wrong. The three things that separate the two, all enforced here:
 *
 *   1. COUNTERFACTUALS, one per option. Every option carries
 *      `expected_outcome`: what we expect to observe if that option is taken.
 *      For the chosen option that is a falsifiable prediction. For a rejected
 *      option it is the counterfactual — the world we gave up. If every option
 *      predicts the same outcome, nothing was decided, and `auditEntry()` says
 *      so. This is the check that kills "options" that are strawmen.
 *
 *   2. A FLIP CONDITION. `flip_condition` states the concrete, checkable fact
 *      that would have sent the agent to a different option, and
 *      `flip_to_option_id` names which one. This is the field a faker hates.
 *      Writing it forces you to admit the decision function's actual shape, and
 *      a reader can hold it against the evidence: if the flip condition is a
 *      number and the evidence carries that number, the reader can see how
 *      close the call was. A decision with no flip condition is an output, not
 *      a decision, and is graded `rubber_stamp`.
 *
 *   3. EVIDENCE WITH PROVENANCE. Each evidence item names its source. Two of
 *      the five sources — `fixture` and `model_prior` — are WEAK: nothing in
 *      the world pushed back. A decision resting only on weak evidence could
 *      not have come out any other way, because there was nothing there to
 *      surprise it. `summarize()` counts those and prints the count.
 *
 * ── HOW A READER VERIFIES THE AGENT COULD HAVE CHOSEN OTHERWISE ──────────────
 *
 * Four independent routes, in increasing order of how hard they are to fake:
 *
 *   a) PER-ENTRY: read `flip_condition` against `evidence`. The condition is
 *      stated in terms of the same measured quantities the rationale used, so a
 *      reader can check whether the input was anywhere near the boundary.
 *
 *   b) ACROSS AN AGENT'S ENTRIES: `summarize()` reports, per agent, how many
 *      DISTINCT options it ever chose. An agent that has "decided" six times
 *      and picked the same shape of answer every time is a constant function
 *      wearing a costume — each entry can look fine while the agent is a rubber
 *      stamp. This check operates a level above the entry and is the one we
 *      would most like to fail quietly. It is printed instead.
 *
 *   c) POSITION BIAS: `chose_first_option` per entry, aggregated into a
 *      default-choice rate. If the agent always takes the first option it
 *      listed, the ordering is doing the deciding.
 *
 *   d) REVERSALS: `supersedes` links an entry to one it overturns. A log of
 *      twenty decisions and zero reversals is a log of a company that was never
 *      wrong, which is a claim no one believes. The summary flags it.
 *
 * ── HOW WE MAKE FORGING HARD FOR OURSELVES ───────────────────────────────────
 *
 * In increasing order of strength:
 *
 *   1. TAMPER EVIDENCE. Entries are chained: `entry_hash` is a SHA-256 over
 *      this entry's canonical form plus the previous entry's hash. Improving
 *      entry 3 at 18:30 to read better breaks entries 4..N. `verifyChain()`
 *      names the first broken index. Combined with the commit history of the
 *      .jsonl file, retro-fitting is visible. What this does NOT prove: that
 *      any decision was real when it was written. Chains stop edits, not lies.
 *
 *   2. MECHANISM REPLAY. See above. This is the only item on this list that a
 *      four-minute forgery cannot survive, and it is the reason the rest of the
 *      list is worth printing. Shape checks catch laziness; replay catches
 *      lying.
 *
 *   3. MACHINE-CHECKED EMPTINESS. `auditEntry()` names the specific ways a fake
 *      looks fake, `summarize()` prints them next to the entries, and the
 *      writer never silently drops a weak entry. We cannot ship theatre without
 *      our own tool labelling it in the output a judge reads.
 *
 *   4. SELF-INCRIMINATING STATISTICS. The summary leads with the numbers that
 *      would embarrass us: rubber-stamp count, default-choice rate,
 *      weak-evidence rate, zero-reversal warning, and how many decisions were
 *      made by a HUMAN rather than an agent. `"Human"` is a first-class value
 *      of `DecisionAgent` precisely so the log can say "we decided this one" in
 *      the same voice it says everything else. A log that admits five of
 *      nineteen were ours is why the other fourteen are worth reading.
 *
 *   5. EXTERNAL REFS. `DecisionEvidence.ref` points at something a judge can
 *      open independently — a Stripe charge id, a `PropagationCheck` id, a
 *      Terac submission id, a line of fixture.json. Faking those means faking
 *      the rest of the product, which is the whole product.
 *
 * None of this makes the log a proof. It makes it CHECKABLE, and it makes lying
 * more expensive than telling the truth. That is the honest claim, and it is
 * the one we make in the writeup.
 *
 * ── SAFETY POSTURE ───────────────────────────────────────────────────────────
 *
 * Dry-run by default, per the project rule: `openDecisionLog()` with no `path`
 * keeps everything in memory and touches no disk. Writing our own audit trail
 * is not an outward-facing side effect like serving to a publisher or charging
 * a card — but the caller still has to name the file, explicitly, before a byte
 * is written. Zero runtime dependencies: node stdlib only.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// THE TYPE. Three other agents import this. It does not change without telling
// them, exactly like src/contract.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bumped if the on-disk shape changes. Old lines stay readable and are flagged.
 * v2 added the optional `replay` pointer — a v1 line is still a valid entry, it
 * simply has no mechanism to re-run, and reports `absent` rather than failing.
 */
export const DECISION_LOG_VERSION = 2;

/**
 * Closed union on purpose. The five agents are the ones PRD §2 claims run the
 * company; an open `string` lets a typo ("Prospecter") silently split an agent's
 * row in the summary, and lets us quietly invent a sixth agent at 18:00 to pad
 * the org chart.
 *
 * `"Human"` is in the union because the honest thing to log is that humans made
 * some calls, and a log that cannot express that is a log that hides it.
 */
export type DecisionAgent =
  /** Which companies to approach, qualified by measured invisibility. */
  | "Prospector"
  /** What to say to them and whether to send it. */
  | "Closer"
  /** What to charge, and whether the deal is worth doing at that price. */
  | "Pricing"
  /** Whether a creative may be served. Hard veto. */
  | "Compliance"
  /** Which disclosure format ships, given what the humans in the Terac panel said. */
  | "Format"
  /** A person decided this. Recorded in the same log, deliberately. */
  | "Human";

export const DECISION_AGENTS: readonly DecisionAgent[] = [
  "Prospector",
  "Closer",
  "Pricing",
  "Compliance",
  "Format",
  "Human",
] as const;

/**
 * Where a fact came from. This is the field that separates a decision that
 * could have gone otherwise from one that could not have.
 */
export type EvidenceSource =
  /** Our own engine observed it at runtime — retrieve, propagation, render. */
  | "measurement"
  /** A third party told us — Stripe, Terac, Pioneer, an answer engine. */
  | "external_api"
  /** Seeded or demo data. Real shape, not a live observation. */
  | "fixture"
  /** A person said so. */
  | "human_input"
  /** The agent's own belief with nothing behind it. */
  | "model_prior";

/**
 * Sources that cannot surprise the agent. A decision resting only on these had
 * nothing to push back on it, so it could not have come out differently, so it
 * is not a decision. Counted and printed by `summarize()`.
 */
export const WEAK_EVIDENCE_SOURCES: readonly EvidenceSource[] = ["fixture", "model_prior"] as const;

export interface DecisionEvidence {
  /** Referenced by `DecisionOption.supported_by`. Unique within the entry. */
  id: string;
  /** The fact, in plain language. "Acme appears in 0 of 12 sonar answers." */
  claim: string;
  source: EvidenceSource;
  /**
   * A pointer a reader can independently resolve: a Stripe ref, a
   * PropagationCheck id, a URL, a path into fixture.json. `null` when there is
   * genuinely nothing to point at — which is itself information, and is why
   * this is nullable rather than an empty string.
   */
  ref: string | null;
  /** The number, if the claim has one. Kept separate so charts can read it. */
  value: string | number | boolean | null;
  /** ISO. When the fact was observed, which may predate the decision. */
  observed_at: string | null;
}

export interface DecisionOption {
  /** Unique within the entry. Referenced by `chosen_option_id`/`flip_to_option_id`. */
  id: string;
  /** What this option is, in one line. */
  summary: string;
  /**
   * THE COUNTERFACTUAL. What we expect to observe if this option is taken.
   * For the chosen option this is a prediction that reality can falsify. For a
   * rejected option it is the world we gave up, which is the thing that makes
   * the rejection legible as a choice rather than an omission.
   *
   * If every option in an entry predicts the same outcome, the entry did not
   * decide anything, and `auditEntry()` grades it a rubber stamp.
   */
  expected_outcome: string;
  /** Evidence ids that bear on this option, for or against. */
  supported_by: string[];
  /** Money at stake under this option, in cents. `null` when the call is not monetary. */
  projected_value_cents: number | null;
}

/**
 * A pointer at the pure function that actually made this choice, plus the exact
 * inputs, so an auditor can re-run it instead of reading about it.
 *
 * This is the field that separates a log written by an agent from a log written
 * about one. `fn` names a function registered with `registerMechanism()`;
 * `input` is what it was called with; `flip_input` is the SAME input with the
 * one value named in `flip_condition` substituted. Both are re-run by
 * `verifyMechanism()`, which asserts the first reproduces `chosen_option_id` and
 * the second produces `flip_to_option_id`.
 *
 * Everything here must survive `JSON.stringify` → `JSON.parse` unchanged, since
 * the auditor may be re-running an entry read off disk in a later process.
 * Functions, class instances, `Date`s and `undefined` do not qualify.
 */
export interface DecisionReplay {
  /** Registry key, e.g. "pricing.computeQuote". Names the code, not the agent. */
  fn: string;
  /** The exact argument the pure function received. JSON round-trippable. */
  input: unknown;
  /**
   * `input` with the flip condition's stated value substituted, so re-running
   * proves the falsifier is derived rather than written. `null` when the
   * decision genuinely had no alternative to flip to.
   */
  flip_input: unknown | null;
}

/**
 * One decision. This is the on-disk record — one per line of the .jsonl.
 *
 * Agents construct a `DecisionDraft` (this, minus the fields the log stamps);
 * the writer assigns `seq`, `schema_version` and the two hashes so that an
 * agent cannot mint its own position in the chain.
 */
export interface DecisionEntry {
  schema_version: number;
  /** Position in the chain, from 0. Assigned by the writer, never by the agent. */
  seq: number;
  /** Stable id chosen by the caller, e.g. "dec_pricing_acme_01". Unique in the log. */
  id: string;
  agent: DecisionAgent;
  /** ISO timestamp of the decision. */
  decided_at: string;
  /** The question, phrased as a question. Not a summary of the answer. */
  question: string;
  /** Where in the codebase this happened, so a reader can go read it. */
  context: string;
  /**
   * Every option actually on the table. A single-element list is allowed —
   * because the alternative is that we refuse to log it and the rubber stamp
   * disappears from the record, which is worse. It is graded `rubber_stamp`.
   */
  options: DecisionOption[];
  chosen_option_id: string;
  /** Why, in plain language a judge reads once and understands. */
  rationale: string;
  evidence: DecisionEvidence[];
  /**
   * THE FALSIFIER. The concrete, checkable condition under which this agent
   * would have chosen differently. State it in the same units as the evidence:
   * "if Acme's visibility score had been above 0.35". Not "if it seemed wrong".
   */
  flip_condition: string;
  /** Which option the flip condition leads to. `null` only when there was no alternative. */
  flip_to_option_id: string | null;
  /** Can this be undone after the fact? */
  reversible: boolean;
  /** How to undo it — or, when irreversible, exactly what is now unrecoverable. */
  reversal_path: string;
  /**
   * Did this decision change the world outside this log? Dry-run decisions
   * record `false` and describe in `effect` what they would have done. A log
   * where nothing was ever executed is a simulation, and the summary says so.
   */
  executed: boolean;
  /** What the choice did, or would have done. One line. */
  effect: string;
  /** Id of an earlier entry this one overturns or revisits. `null` if none. */
  supersedes: string | null;
  /**
   * OPTIONAL, and the strongest field in the record when present: re-runnable
   * proof that the choice was a function of the inputs. Absent on entries whose
   * agent has no pure core to point at — `summarize()` counts those separately
   * rather than treating an absence as a pass.
   */
  replay?: DecisionReplay | null;
  /** `entry_hash` of the previous entry. `null` for the first. Writer-assigned. */
  prev_hash: string | null;
  /** SHA-256 over the canonical form of this entry plus `prev_hash`. Writer-assigned. */
  entry_hash: string;
}

/** The log is an ordered list of entries. Exported so callers can name the shape. */
export type DecisionLog = DecisionEntry[];

/**
 * What an agent hands to the log. It cannot set `seq`, `schema_version`, or
 * either hash — those are the writer's, which is the whole point of the chain.
 * `decided_at` is optional and defaults to now.
 */
export type DecisionDraft = Omit<
  DecisionEntry,
  "schema_version" | "seq" | "prev_hash" | "entry_hash" | "decided_at"
> & { decided_at?: string };

// ─────────────────────────────────────────────────────────────────────────────
// MECHANISM REPLAY — the check that a coin-flip agent cannot pass.
//
// Everything else in this module inspects the RECORD. This section runs the
// CODE. An agent registers the pure function behind its choice; entries carry
// the inputs; the auditor re-runs the function and compares.
//
// The registry is process-local and populated by importing the agent modules.
// A summary produced by a process that imported only this file therefore reports
// `unregistered`, not `verified` — an auditor that cannot run the function must
// say so rather than pass the entry by default.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pure decision function, as the auditor sees it: inputs in, the id of the
 * chosen option out. Returning `null` means "these inputs are not something I
 * can decide on", which the auditor reports rather than treating as a match.
 *
 * It MUST be pure and total. A verifier that throws is caught and reported as
 * a refutation with the error text, because a decision function that dies on
 * its own recorded inputs is a defect either way.
 */
export type MechanismFn = (input: unknown) => string | null;

const MECHANISMS = new Map<string, MechanismFn>();

/**
 * Register the pure core behind an agent's decisions. Called at module scope by
 * each agent, so importing the agent is what arms the check for its entries.
 */
export function registerMechanism(name: string, fn: MechanismFn): void {
  MECHANISMS.set(name, fn);
}

/** Names currently runnable in this process. Printed in the summary. */
export function registeredMechanisms(): string[] {
  return [...MECHANISMS.keys()].sort();
}

/** Test hook. Nothing in the product calls this. */
export function clearMechanismsForTests(): void {
  MECHANISMS.clear();
}

export type MechanismStatus =
  /** Re-ran the code: it reproduced the choice, and the flip input flipped it. */
  | "verified"
  /**
   * The choice reproduced, but re-running at the flip input produced the SAME
   * option. The falsifier is decorative — this entry claims a condition that
   * would have changed the answer, and it would not have.
   */
  | "flip_did_not_flip"
  /** The code produced a different option than the record claims. The record lies. */
  | "refuted"
  /** The entry names a function this process has not registered. Not checked. */
  | "unregistered"
  /** The entry carries no replay pointer. Nothing to run. */
  | "absent";

export interface MechanismCheck {
  entry_id: string;
  status: MechanismStatus;
  fn: string | null;
  /** What the function actually returned for `replay.input`. */
  replayed_choice: string | null;
  /** What it returned for `replay.flip_input`. */
  replayed_flip_choice: string | null;
  detail: string;
}

/**
 * Re-run the decision. Never throws — it is handed entries off disk, and an
 * auditor that dies on bad input cannot report bad input.
 */
export function verifyMechanism(entry: DecisionEntry): MechanismCheck {
  const base = (
    status: MechanismStatus,
    detail: string,
    extra: Partial<MechanismCheck> = {},
  ): MechanismCheck => ({
    entry_id: entry?.id ?? "(no id)",
    status,
    fn: extra.fn ?? null,
    replayed_choice: extra.replayed_choice ?? null,
    replayed_flip_choice: extra.replayed_flip_choice ?? null,
    detail,
  });

  const replay = entry?.replay;
  if (replay === undefined || replay === null || typeof replay.fn !== "string") {
    return base("absent", "no replay pointer — only the record was checked, not the code that wrote it");
  }
  const fn = MECHANISMS.get(replay.fn);
  if (fn === undefined) {
    return base(
      "unregistered",
      `"${replay.fn}" is not registered in this process — import the agent module to arm this check`,
      { fn: replay.fn },
    );
  }

  const run = (input: unknown): { ok: true; value: string | null } | { ok: false; error: string } => {
    try {
      return { ok: true, value: fn(input) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const primary = run(replay.input);
  if (!primary.ok) {
    return base("refuted", `re-running ${replay.fn} on the recorded input threw: ${primary.error}`, {
      fn: replay.fn,
    });
  }
  if (primary.value !== entry.chosen_option_id) {
    return base(
      "refuted",
      `${replay.fn} on the recorded input chooses "${primary.value ?? "null"}", but this entry records "${entry.chosen_option_id}" — the record and the code disagree`,
      { fn: replay.fn, replayed_choice: primary.value },
    );
  }

  if (replay.flip_input === null || replay.flip_input === undefined) {
    // Reproducing the choice is real work, but without a flip input we have not
    // shown the choice DEPENDS on anything. Report it as unverified rather than
    // banking a half-check as a pass.
    return base(
      "flip_did_not_flip",
      `${replay.fn} reproduced the choice, but no flip input was recorded, so nothing shows the choice depends on the evidence`,
      { fn: replay.fn, replayed_choice: primary.value },
    );
  }

  // A "flip input" identical to the input is not a falsifier, it is the same
  // call twice. Without this check a NON-DETERMINISTIC function can score
  // `verified` by luck: run it twice on the same input, get two different
  // answers, and the second one satisfies the flip. That is the opposite of
  // what this check exists to prove, so identity is rejected before the run.
  if (canonicalize(replay.flip_input) === canonicalize(replay.input)) {
    return base(
      "flip_did_not_flip",
      `${replay.fn}'s flip input is identical to its recorded input — nothing was substituted, so this proves the choice depends on nothing`,
      { fn: replay.fn, replayed_choice: primary.value },
    );
  }

  const flipped = run(replay.flip_input);
  if (!flipped.ok) {
    return base("refuted", `re-running ${replay.fn} on the flip input threw: ${flipped.error}`, {
      fn: replay.fn,
      replayed_choice: primary.value,
    });
  }
  if (flipped.value === entry.chosen_option_id) {
    return base(
      "flip_did_not_flip",
      `${replay.fn} returns "${entry.chosen_option_id}" at the flip condition's own stated value too — the falsifier does not falsify`,
      { fn: replay.fn, replayed_choice: primary.value, replayed_flip_choice: flipped.value },
    );
  }
  const expectedFlip = entry.flip_to_option_id;
  if (typeof expectedFlip === "string" && flipped.value !== expectedFlip) {
    // It DID change — the decision is a real function of the input — but it
    // landed somewhere other than the entry claims. That is a defect in the
    // record, not in the agent, and the distinction is worth printing.
    return base(
      "refuted",
      `${replay.fn} at the flip condition chooses "${flipped.value ?? "null"}", but this entry says it would flip to "${expectedFlip}"`,
      { fn: replay.fn, replayed_choice: primary.value, replayed_flip_choice: flipped.value },
    );
  }

  return base(
    "verified",
    `re-ran ${replay.fn}: recorded input → "${primary.value ?? "null"}", flip input → "${flipped.value ?? "null"}"`,
    { fn: replay.fn, replayed_choice: primary.value, replayed_flip_choice: flipped.value },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REF RESOLUTION — does the evidence point at anything a reader can open?
//
// `auditEntry()` originally checked only that `ref` was a non-empty string. A
// non-empty string is not a pointer. This opens what can be opened, from a
// clone of the repo and nothing else, and is explicit about what it cannot
// check rather than counting it as checked.
// ─────────────────────────────────────────────────────────────────────────────

export type RefKind =
  /** A path into this repository. Existence is checkable here. */
  | "repo_path"
  /** A JSON pointer into fixture.json. The pointed-at node is checkable here. */
  | "fixture_path"
  /** An http(s) URL. Real, but this checker makes no network calls. */
  | "url"
  /** A Stripe-shaped id. Checkable in the Stripe dashboard, not from here. */
  | "stripe_id"
  /** An internal handle like `prospect:acme`. Meaningful, not independently openable. */
  | "opaque"
  /** No ref at all. */
  | "none";

export interface RefResolution {
  ref: string | null;
  kind: RefKind;
  /** True only when this process opened it and found it. Never true for URLs. */
  resolved: boolean;
  detail: string;
}

/** Cheap memo so a 40-entry log does not stat the same file 40 times. */
const refCache = new Map<string, RefResolution>();

/** Test hook — the cache is keyed on path and would survive a fixture rewrite. */
export function clearRefCacheForTests(): void {
  refCache.clear();
}

const STRIPE_ID = /^(ch|pi|cs|plink|price|prod|cus|sub|in|txn|py|re)_[A-Za-z0-9]{6,}$/;

/**
 * Resolve one evidence ref. Never throws, never makes a network call.
 *
 * The repo-path form accepts the shapes our agents actually emit:
 *   src/company/pricing.ts#CATEGORY_DEMAND     → file exists AND contains the anchor
 *   src/company/prospector.ts probeVisibility() → file exists, trailing text ignored
 *   fixture.json#/publishers/0                  → JSON pointer resolves inside fixture.json
 */
export function resolveEvidenceRef(ref: string | null, root: string = process.cwd()): RefResolution {
  const raw = typeof ref === "string" ? ref.trim() : "";
  if (raw === "") return { ref: null, kind: "none", resolved: false, detail: "no ref" };

  const cacheKey = `${root} ${raw}`;
  const hit = refCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const out = ((): RefResolution => {
    if (/^https?:\/\//i.test(raw)) {
      return {
        ref: raw,
        kind: "url",
        resolved: false,
        detail: "external URL — this checker makes no network calls, so open it yourself",
      };
    }
    if (STRIPE_ID.test(raw)) {
      return {
        ref: raw,
        kind: "stripe_id",
        resolved: false,
        detail: "Stripe id — resolvable in the dashboard with the read-only key, not from here",
      };
    }

    // Split "path#anchor" / "path → tail" / "path (tail)" into a path and a hint.
    const head = raw.split(/\s+(?:→|->|@)\s+/)[0] ?? raw;
    const [pathPart = "", anchor] = head.split("#", 2);
    const cleanPath = pathPart.trim().replace(/[(),;]+$/, "").split(/\s+/)[0] ?? "";
    if (!/\.(ts|tsx|js|mjs|json|md|txt|jsonl)$/i.test(cleanPath)) {
      return {
        ref: raw,
        kind: "opaque",
        resolved: false,
        detail: "internal handle — meaningful inside this run, not independently openable",
      };
    }

    const abs = isAbsolute(cleanPath) ? cleanPath : resolvePath(root, cleanPath);
    if (!existsSync(abs)) {
      return {
        ref: raw,
        kind: /fixture\.json$/i.test(cleanPath) ? "fixture_path" : "repo_path",
        resolved: false,
        detail: `${cleanPath} does not exist — this evidence points at nothing`,
      };
    }

    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      return {
        ref: raw,
        kind: "repo_path",
        resolved: false,
        detail: `${cleanPath} exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const anchorText = (anchor ?? "").trim();
    if (/fixture\.json$/i.test(cleanPath) && anchorText.startsWith("/")) {
      const found = resolveJsonPointer(text, anchorText);
      return {
        ref: raw,
        kind: "fixture_path",
        resolved: found,
        detail: found
          ? `${cleanPath}${anchorText} resolves`
          : `${cleanPath} exists but has nothing at ${anchorText}`,
      };
    }
    if (anchorText !== "") {
      const found = text.includes(anchorText);
      return {
        ref: raw,
        kind: "repo_path",
        resolved: found,
        detail: found
          ? `${cleanPath} exists and contains "${anchorText}"`
          : `${cleanPath} exists but does not contain "${anchorText}" — the anchor is stale`,
      };
    }
    return { ref: raw, kind: "repo_path", resolved: true, detail: `${cleanPath} exists` };
  })();

  refCache.set(cacheKey, out);
  return out;
}

function resolveJsonPointer(text: string, pointer: string): boolean {
  let node: unknown;
  try {
    node = JSON.parse(text);
  } catch {
    return false;
  }
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
      node = node[index];
    } else if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) return false;
      node = record[segment];
    } else {
      return false;
    }
  }
  return node !== undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit — the rubber-stamp detector.
//
// This runs over entries we wrote ourselves. Its job is to catch us. Every
// defect below is a specific, mechanical way a fabricated or lazy entry differs
// from a real one, and every one of them is printed in `summarize()` rather
// than filtered out of it.
// ─────────────────────────────────────────────────────────────────────────────

export type DecisionStrength =
  /** Options were real, a falsifier exists, evidence could have surprised it. */
  | "decision"
  /** A real fork, but the record is thin enough that a reader should discount it. */
  | "weak"
  /** No fork, no falsifier, or no evidence. Not a decision. */
  | "rubber_stamp";

export const DEFECTS = {
  /** One option is not a choice. */
  singleOption: "single_option",
  /** Every option predicts the same result, so the options are decoration. */
  identicalOutcomes: "options_predict_identical_outcomes",
  /** An option has no stated counterfactual. */
  missingCounterfactual: "option_missing_expected_outcome",
  /** No falsifier: nothing would have changed the answer. */
  noFlipCondition: "no_flip_condition",
  /** The falsifier does not name an alternative to flip to. */
  noFlipTarget: "flip_condition_has_no_target_option",
  /** The falsifier just restates the chosen path. Not a condition. */
  circularFlipCondition: "flip_condition_restates_the_choice",
  /** Nothing was cited. There was nothing to be wrong about. */
  noEvidence: "no_evidence",
  /** All evidence is fixture or model_prior — nothing in the world pushed back. */
  weakEvidenceOnly: "evidence_is_all_fixture_or_prior",
  /** No evidence item resolves to anything a reader can open. */
  noResolvableEvidence: "no_evidence_ref_a_reader_can_check",
  /** A ref names a file in this repo, and that file is not there. */
  refPointsAtNothing: "evidence_ref_does_not_resolve",
  /** Re-running the agent's own decision function contradicts this record. */
  mechanismRefuted: "replay_contradicts_the_record",
  /** Re-running at the flip condition's own value does not change the choice. */
  flipDoesNotFlip: "flip_condition_does_not_change_the_choice",
  /** Rationale too short to be an explanation. */
  thinRationale: "rationale_too_short",
  /** Irreversible, but no account of what is now unrecoverable. */
  missingReversalPath: "reversal_path_not_stated",
  /** Options are cited but no option references any evidence. */
  evidenceUnlinked: "no_option_references_any_evidence",
} as const;

export type Defect = (typeof DEFECTS)[keyof typeof DEFECTS];

/** Below this, a "rationale" is a stub, not an explanation. */
export const MIN_RATIONALE_CHARS = 40;

export interface EntryAudit {
  entry_id: string;
  seq: number;
  agent: DecisionAgent;
  strength: DecisionStrength;
  defects: Defect[];
  /** The chosen option was the first one listed. Aggregated into position bias. */
  chose_first_option: boolean;
  /** Nothing in the world could have surprised this decision. */
  weak_evidence_only: boolean;
  /** Count of distinct predicted outcomes across options. 1 means no real fork. */
  distinct_outcomes: number;
  /** Result of re-running the agent's own decision function. See `verifyMechanism`. */
  mechanism: MechanismStatus;
  /** Human-readable account of that replay, printed under the entry. */
  mechanism_detail: string;
  /** Evidence refs this process opened and found. */
  refs_resolved: number;
  /** Evidence refs naming a repo file that is not there. */
  refs_broken: number;
  /** Evidence refs real but not checkable from here — URLs, Stripe ids, handles. */
  refs_unverifiable: number;
  /**
   * The option menu this entry offered, as a stable signature. Two entries with
   * the same signature are the same KIND of decision, which is the only level at
   * which "chose the same option every time" means anything.
   */
  option_menu: string;
}

/** Sorted option ids, joined. The equivalence class for the constant-function check. */
export function optionMenu(entry: DecisionEntry): string {
  const ids = (Array.isArray(entry?.options) ? entry.options : [])
    .map((o) => String(o?.id ?? ""))
    .filter((id) => id !== "")
    .sort();
  return ids.join("|");
}

/** Lowercase, strip punctuation, collapse whitespace. For comparing prose. */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Grade one entry. Never throws: it is handed entries read off disk, which may
 * have been written by an older version or hand-edited, and an auditor that
 * dies on bad input is an auditor that cannot report bad input.
 */
export interface AuditOptions {
  /** Repo root that evidence refs are resolved against. Defaults to cwd. */
  root?: string;
}

// `auditOptions`, not `options`: the body already binds `options` to the
// entry's option list, and a parameter of the same name would be shadowed by it
// — silently in TypeScript, and as a temporal-dead-zone throw at runtime.
export function auditEntry(entry: DecisionEntry, auditOptions: AuditOptions = {}): EntryAudit {
  const root = auditOptions.root ?? process.cwd();
  const defects: Defect[] = [];
  const options = Array.isArray(entry.options) ? entry.options : [];
  const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];

  // 1. Was there a fork at all?
  if (options.length < 2) defects.push(DEFECTS.singleOption);

  const outcomes = options.map((o) => normalizeText(String(o?.expected_outcome ?? "")));
  if (outcomes.some((o) => o === "")) defects.push(DEFECTS.missingCounterfactual);
  const distinctOutcomes = new Set(outcomes.filter((o) => o !== "")).size;
  // Two options that predict the same world are one option with two names.
  if (options.length >= 2 && distinctOutcomes <= 1) {
    defects.push(DEFECTS.identicalOutcomes);
  }

  // 2. Is there a falsifier, and does it point somewhere?
  const flip = String(entry.flip_condition ?? "").trim();
  if (flip === "") {
    defects.push(DEFECTS.noFlipCondition);
  } else if (normalizeText(flip) === normalizeText(String(entry.rationale ?? ""))) {
    // "We would have chosen differently if we had chosen differently."
    defects.push(DEFECTS.circularFlipCondition);
  }
  const flipTarget = entry.flip_to_option_id;
  const flipTargetValid =
    typeof flipTarget === "string" &&
    flipTarget !== entry.chosen_option_id &&
    options.some((o) => o?.id === flipTarget);
  if (options.length >= 2 && !flipTargetValid) defects.push(DEFECTS.noFlipTarget);

  // 3. Could anything have surprised it?
  if (evidence.length === 0) {
    defects.push(DEFECTS.noEvidence);
  } else {
    const allWeak = evidence.every((e) =>
      WEAK_EVIDENCE_SOURCES.includes(e?.source as EvidenceSource),
    );
    if (allWeak) defects.push(DEFECTS.weakEvidenceOnly);
    if (!evidence.some((e) => typeof e?.ref === "string" && e.ref.trim() !== "")) {
      defects.push(DEFECTS.noResolvableEvidence);
    }
    if (!options.some((o) => Array.isArray(o?.supported_by) && o.supported_by.length > 0)) {
      defects.push(DEFECTS.evidenceUnlinked);
    }
  }

  // 3b. Do the refs point at anything? A ref naming a file in this repo either
  // resolves or it does not, and "does not" is a fabricated pointer, which is
  // the cheapest tell there is. URLs and Stripe ids are counted as unverifiable
  // rather than as passes — this checker makes no network calls.
  const resolutions = evidence.map((e) => resolveEvidenceRef(e?.ref ?? null, root));
  const refsResolved = resolutions.filter((r) => r.resolved).length;
  const refsBroken = resolutions.filter(
    (r) => !r.resolved && (r.kind === "repo_path" || r.kind === "fixture_path"),
  ).length;
  const refsUnverifiable = resolutions.filter(
    (r) => !r.resolved && (r.kind === "url" || r.kind === "stripe_id" || r.kind === "opaque"),
  ).length;
  if (refsBroken > 0) defects.push(DEFECTS.refPointsAtNothing);

  // 4. Is the record readable and complete?
  if (String(entry.rationale ?? "").trim().length < MIN_RATIONALE_CHARS) {
    defects.push(DEFECTS.thinRationale);
  }
  if (!entry.reversible && String(entry.reversal_path ?? "").trim() === "") {
    defects.push(DEFECTS.missingReversalPath);
  }

  // 5. Run the code. This is the only check here that a coin-flip agent with
  // well-formed templates cannot pass — see the header. `absent` and
  // `unregistered` are NOT defects: most entries have no pure core to point at,
  // and penalising their absence would push agents to fake a replay. They are
  // counted in the summary instead, where a reader can see how much of the log
  // was actually re-run.
  const mechanism = verifyMechanism(entry);
  if (mechanism.status === "refuted") defects.push(DEFECTS.mechanismRefuted);
  if (mechanism.status === "flip_did_not_flip") defects.push(DEFECTS.flipDoesNotFlip);

  const weakEvidenceOnly =
    evidence.length === 0 ||
    evidence.every((e) => WEAK_EVIDENCE_SOURCES.includes(e?.source as EvidenceSource));

  // Grading. A rubber stamp is an entry that fails on the FORK or the
  // FALSIFIER or the EVIDENCE — the three things that make being wrong
  // possible. Everything else is a thin record of a real decision, which we
  // downgrade to "weak" and still show.
  //
  // The two replay defects are fatal for a different reason than the rest: they
  // are not thin records, they are records CONTRADICTED by the code they claim
  // to describe. An entry whose replay refutes it is worse than an entry with no
  // replay, and it must not be able to outrank one.
  const fatal: Defect[] = [
    DEFECTS.singleOption,
    DEFECTS.identicalOutcomes,
    DEFECTS.noFlipCondition,
    DEFECTS.circularFlipCondition,
    DEFECTS.noEvidence,
    DEFECTS.weakEvidenceOnly,
    DEFECTS.mechanismRefuted,
    DEFECTS.flipDoesNotFlip,
  ];
  const strength: DecisionStrength = defects.some((d) => fatal.includes(d))
    ? "rubber_stamp"
    : defects.length > 0
      ? "weak"
      : "decision";

  const first = options[0];
  return {
    entry_id: entry.id,
    seq: entry.seq,
    agent: entry.agent,
    strength,
    defects,
    chose_first_option: first !== undefined && first.id === entry.chosen_option_id,
    weak_evidence_only: weakEvidenceOnly,
    distinct_outcomes: distinctOutcomes,
    mechanism: mechanism.status,
    mechanism_detail: mechanism.detail,
    refs_resolved: refsResolved,
    refs_broken: refsBroken,
    refs_unverifiable: refsUnverifiable,
    option_menu: optionMenu(entry),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing — canonical form and the chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order.
 * Without this, two structurally identical entries hash differently depending
 * on property insertion order and the chain is noise.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
    return out;
  }
  // undefined would vanish from JSON.stringify inside an object and silently
  // change the hash. Pin it to null so the canonical form is total.
  return value === undefined ? null : value;
}

/**
 * Hash of an entry: everything except `entry_hash` itself, including `seq` and
 * `prev_hash`. Reordering entries, editing any field, or splicing an entry out
 * of the middle all change downstream hashes.
 */
export function hashEntry(entry: Omit<DecisionEntry, "entry_hash">): string {
  return createHash("sha256").update(canonicalize(entry)).digest("hex");
}

export interface ChainVerification {
  ok: boolean;
  entries_checked: number;
  /** Index of the first entry whose hash or link does not hold. -1 when clean. */
  broken_at: number;
  /** Plain-language account of the break, for the summary. */
  detail: string | null;
}

/**
 * Recompute the whole chain. This is the check that makes retroactive polish
 * visible: improve entry 3's rationale at 18:30 and entries 4..N stop verifying.
 */
export function verifyChain(entries: readonly DecisionEntry[]): ChainVerification {
  let prev: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.seq !== i) {
      return {
        ok: false,
        entries_checked: i,
        broken_at: i,
        detail: `entry "${entry.id}" claims seq ${entry.seq} but sits at position ${i} — an entry was inserted, removed or reordered`,
      };
    }
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        entries_checked: i,
        broken_at: i,
        detail: `entry "${entry.id}" links to ${entry.prev_hash ?? "null"} but the previous entry hashes to ${prev ?? "null"}`,
      };
    }
    const { entry_hash, ...body } = entry;
    const recomputed = hashEntry(body);
    if (recomputed !== entry_hash) {
      return {
        ok: false,
        entries_checked: i,
        broken_at: i,
        detail: `entry "${entry.id}" was edited after it was written — recorded hash ${entry_hash.slice(0, 12)}…, actual content hashes to ${recomputed.slice(0, 12)}…`,
      };
    }
    prev = entry_hash;
  }
  return { ok: true, entries_checked: entries.length, broken_at: -1, detail: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The writer — append-only, JSONL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a draft is INCOHERENT — not when it is weak.
 *
 * The line matters and is deliberate. A weak decision is recorded and graded,
 * because refusing to log a rubber stamp is how rubber stamps disappear from
 * the record, and a log that only contains our good decisions is the exact
 * forgery this module exists to prevent. A draft whose `chosen_option_id` names
 * no option, or that reuses an id already in the log, is not weak — it is
 * unreadable, and it means calling code has a bug that a test must catch now.
 */
export class DecisionLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionLogError";
  }
}

/** Structural coherence only. Quality is `auditEntry()`'s job, not this one's. */
export function assertCoherentDraft(draft: DecisionDraft, existingIds: ReadonlySet<string>): void {
  const fail = (m: string): never => {
    throw new DecisionLogError(`refusing to log an incoherent decision: ${m}`);
  };

  if (typeof draft.id !== "string" || draft.id.trim() === "") fail("entry has no id");
  if (existingIds.has(draft.id)) fail(`duplicate entry id "${draft.id}"`);
  if (!DECISION_AGENTS.includes(draft.agent)) {
    fail(`unknown agent "${String(draft.agent)}" — DecisionAgent is a closed union on purpose`);
  }
  if (typeof draft.question !== "string" || draft.question.trim() === "") {
    fail(`entry "${draft.id}" has no question`);
  }
  if (!Array.isArray(draft.options) || draft.options.length === 0) {
    fail(`entry "${draft.id}" has no options at all`);
  }
  // Cast wide on purpose. This function is the boundary between typed callers
  // and a JSONL file anyone can hand-edit, so it must survive fields that the
  // type system was promised would be there and are not.
  const options = draft.options as (DecisionOption | undefined)[];
  const optionIds = new Set<string>();
  for (const option of options) {
    if (option === undefined || typeof option.id !== "string" || option.id.trim() === "") {
      fail(`entry "${draft.id}" has an option with no id`);
      continue;
    }
    if (optionIds.has(option.id)) fail(`entry "${draft.id}" has duplicate option id "${option.id}"`);
    optionIds.add(option.id);
  }
  if (!optionIds.has(draft.chosen_option_id)) {
    fail(`entry "${draft.id}" chose "${draft.chosen_option_id}", which is not one of its options`);
  }
  if (draft.flip_to_option_id !== null) {
    if (!optionIds.has(draft.flip_to_option_id)) {
      fail(`entry "${draft.id}" would flip to "${draft.flip_to_option_id}", which is not one of its options`);
    }
    if (draft.flip_to_option_id === draft.chosen_option_id) {
      fail(`entry "${draft.id}" would flip to the option it already chose — that is not a counterfactual`);
    }
  }
  const evidenceIds = new Set<string>();
  for (const item of (draft.evidence ?? []) as (DecisionEvidence | undefined)[]) {
    if (item === undefined || typeof item.id !== "string" || item.id.trim() === "") {
      fail(`entry "${draft.id}" has an evidence item with no id`);
      continue;
    }
    if (evidenceIds.has(item.id)) fail(`entry "${draft.id}" has duplicate evidence id "${item.id}"`);
    evidenceIds.add(item.id);
  }
  for (const option of options) {
    for (const ref of option?.supported_by ?? []) {
      if (!evidenceIds.has(ref)) {
        fail(`entry "${draft.id}" option "${option?.id}" cites evidence "${ref}", which is not in this entry`);
      }
    }
  }
}

export interface OpenLogOptions {
  /**
   * File to append to. OMIT IT and the log runs in memory and touches no disk —
   * dry-run by default, per the project rule. Naming a path is the explicit
   * opt-in to a side effect.
   */
  path?: string | null;
  /** Force memory-only even when a path is given. */
  dryRun?: boolean;
  /** Injected in tests for deterministic timestamps. */
  now?: () => Date;
  logger?: (message: string) => void;
}

/**
 * What agents are handed. Both backings implement it, so a caller never knows
 * or cares whether it is writing to disk.
 */
export interface DecisionSink {
  append(draft: DecisionDraft): DecisionEntry;
  entries(): DecisionEntry[];
  /** null when memory-backed. */
  readonly path: string | null;
}

/**
 * Read the tip from disk on every append rather than trusting an in-memory
 * cursor. Four agents may be logging in the same run, and possibly in separate
 * processes; a stale cursor writes a bad `prev_hash` and breaks the chain for a
 * reason that has nothing to do with tampering, which would destroy the
 * chain's evidential value with a false positive. Re-reading is O(n) per append
 * on a log of a few dozen lines. Correctness wins that trade easily.
 *
 * KNOWN LIMIT, stated rather than hidden: read-then-append is not atomic across
 * PROCESSES. Two processes appending in the same instant can both read the same
 * tip and both claim seq N. That does not corrupt anything silently — it is
 * exactly what `verifyChain()` reports as a break, and the fix is to re-log the
 * loser. A false "tampered" report is the safe direction for this failure to
 * fall, and within one process appends are serialised by the event loop.
 */
export function openDecisionLog(options: OpenLogOptions = {}): DecisionSink {
  const now = options.now ?? ((): Date => new Date());
  const log = options.logger ?? ((m: string): void => console.log(m));
  const memoryOnly = options.dryRun === true || options.path === undefined || options.path === null;
  const path = memoryOnly ? null : String(options.path);
  const buffer: DecisionEntry[] = [];

  if (memoryOnly && options.path !== undefined && options.path !== null) {
    log(`[adlayer:decision-log] dry run — decisions held in memory, ${String(options.path)} untouched`);
  }

  const currentEntries = (): DecisionEntry[] => (path === null ? [...buffer] : readLog(path));

  return {
    path,
    entries: currentEntries,
    append(draft: DecisionDraft): DecisionEntry {
      const existing = currentEntries();
      assertCoherentDraft(draft, new Set(existing.map((e) => e.id)));

      const tip = existing.length > 0 ? existing[existing.length - 1] : undefined;
      const { decided_at, ...rest } = draft;
      const body: Omit<DecisionEntry, "entry_hash"> = {
        ...rest,
        schema_version: DECISION_LOG_VERSION,
        seq: existing.length,
        decided_at: decided_at ?? now().toISOString(),
        prev_hash: tip?.entry_hash ?? null,
      };
      const entry: DecisionEntry = { ...body, entry_hash: hashEntry(body) };

      if (path === null) {
        buffer.push(entry);
      } else {
        const dir = dirname(path);
        if (dir !== "" && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        // Append-only. There is deliberately no code path in this module that
        // opens the log for writing with any other flag.
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
      }
      return entry;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────────────

export interface LogRead {
  entries: DecisionEntry[];
  /** Lines that did not parse or did not look like entries, with line numbers. */
  malformed: { line: number; reason: string; raw: string }[];
}

/**
 * A malformed line is REPORTED, never silently skipped. Quietly dropping
 * garbage is how a log with three unreadable entries renders as a clean log of
 * the ones that happened to survive.
 */
export function readLogWithDiagnostics(path: string): LogRead {
  if (!existsSync(path)) return { entries: [], malformed: [] };
  const text = readFileSync(path, "utf8");
  const entries: DecisionEntry[] = [];
  const malformed: LogRead["malformed"] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      malformed.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err),
        raw: raw.slice(0, 200),
      });
      continue;
    }
    if (!isEntryShaped(parsed)) {
      malformed.push({ line: i + 1, reason: "not a DecisionEntry", raw: raw.slice(0, 200) });
      continue;
    }
    entries.push(parsed);
  }
  return { entries, malformed };
}

export function readLog(path: string): DecisionEntry[] {
  return readLogWithDiagnostics(path).entries;
}

/**
 * Shape check, not a validity check. It answers "is this line an entry at all",
 * so a truncated write or a stray file does not surface as a decision. Content
 * quality is `auditEntry()`; integrity is `verifyChain()`.
 */
export function isEntryShaped(value: unknown): value is DecisionEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["seq"] === "number" &&
    typeof v["agent"] === "string" &&
    typeof v["question"] === "string" &&
    typeof v["chosen_option_id"] === "string" &&
    typeof v["entry_hash"] === "string" &&
    Array.isArray(v["options"]) &&
    Array.isArray(v["evidence"])
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary — what the judge reads
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentStats {
  agent: DecisionAgent;
  total: number;
  real: number;
  weak: number;
  rubber_stamps: number;
  /**
   * How many DISTINCT options this agent ever chose, POOLED across every kind
   * of decision it makes. Kept because it is the headline number, but it is the
   * WEAKER of the two: an agent that qualifies prospects and also ranks them
   * pools two menus, so it can score 5 distinct choices while being a constant
   * function inside each. `menus` below is the check that actually bites.
   */
  distinct_choices: number;
  /**
   * Per option-menu breakdown. Entries offering the same set of option ids are
   * the same KIND of decision; that is the only level at which "chose the same
   * option every time" is evidence of a constant function.
   */
  menus: { menu: string; total: number; distinct_choices: number }[];
  /** Entries whose pure decision function was re-run and reproduced the record. */
  mechanism_verified: number;
  /** Entries whose replay contradicted the record, or whose falsifier did not flip. */
  mechanism_refuted: number;
  irreversible: number;
  executed: number;
}

export interface LogStats {
  total: number;
  first_at: string | null;
  last_at: string | null;
  chain: ChainVerification;
  malformed_lines: number;
  by_agent: AgentStats[];
  real: number;
  weak: number;
  rubber_stamps: number;
  /** Share of decisions that took the first option listed. Position bias. */
  first_option_rate: number;
  /** Share resting only on fixture / model_prior. */
  weak_evidence_rate: number;
  /** Decisions that actually changed something outside the log. */
  executed: number;
  irreversible: number;
  /** Entries that overturn an earlier one. Zero across a big log is suspicious. */
  reversals: number;
  human_decisions: number;
  agent_decisions: number;
  /**
   * MECHANISM. `real` above counts entries that are WELL-FORMED. These count
   * entries whose decision function was actually re-run. The gap between the two
   * is the gap between "the record looks right" and "the code agrees".
   */
  mechanism_verified: number;
  mechanism_refuted: number;
  /** Named a function this process has not registered — check not armed. */
  mechanism_unregistered: number;
  /** Carried no replay pointer at all. Only the record was checked. */
  mechanism_absent: number;
  /** Decision functions runnable in this process, for the reader's benefit. */
  mechanisms_available: string[];
  /** Evidence refs across the whole log. */
  refs_total: number;
  /** Refs this process opened and found — repo files and fixture pointers. */
  refs_resolved: number;
  /** Refs naming a repo file that is not there. Fabricated or stale. */
  refs_broken: number;
  /** Entries with at least one ref that resolves from a clone of this repo. */
  entries_with_resolved_ref: number;
  /** Machine-readable versions of the warnings printed in the summary. */
  warnings: string[];
  audits: EntryAudit[];
}

export function computeStats(
  entries: readonly DecisionEntry[],
  malformedLines = 0,
  auditOptions: AuditOptions = {},
): LogStats {
  const audits = entries.map((e) => auditEntry(e, auditOptions));
  const byId = new Map<string, EntryAudit>();
  for (const a of audits) byId.set(a.entry_id, a);

  const agents: AgentStats[] = [];
  for (const agent of DECISION_AGENTS) {
    const mine = entries.filter((e) => e.agent === agent);
    if (mine.length === 0) continue;
    const myAudits = mine.map((e) => byId.get(e.id)).filter((a): a is EntryAudit => a !== undefined);

    // Group by option menu. Two entries offering {approach, reject, defer} are
    // the same decision repeated; an entry offering {rank_by_strength, ...} is a
    // different question, and pooling the two hides a constant function inside
    // each of them behind a healthy-looking total.
    const byMenu = new Map<string, string[]>();
    for (const e of mine) {
      const menu = optionMenu(e);
      byMenu.set(menu, [...(byMenu.get(menu) ?? []), e.chosen_option_id]);
    }

    agents.push({
      agent,
      total: mine.length,
      real: myAudits.filter((a) => a.strength === "decision").length,
      weak: myAudits.filter((a) => a.strength === "weak").length,
      rubber_stamps: myAudits.filter((a) => a.strength === "rubber_stamp").length,
      distinct_choices: new Set(mine.map((e) => e.chosen_option_id)).size,
      menus: [...byMenu.entries()]
        .map(([menu, chosen]) => ({
          menu,
          total: chosen.length,
          distinct_choices: new Set(chosen).size,
        }))
        .sort((a, b) => b.total - a.total || a.menu.localeCompare(b.menu)),
      mechanism_verified: myAudits.filter((a) => a.mechanism === "verified").length,
      mechanism_refuted: myAudits.filter(
        (a) => a.mechanism === "refuted" || a.mechanism === "flip_did_not_flip",
      ).length,
      irreversible: mine.filter((e) => !e.reversible).length,
      executed: mine.filter((e) => e.executed).length,
    });
  }

  const total = entries.length;
  const rate = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 1000) / 1000);
  const stats: LogStats = {
    total,
    first_at: entries[0]?.decided_at ?? null,
    last_at: entries[total - 1]?.decided_at ?? null,
    chain: verifyChain(entries),
    malformed_lines: malformedLines,
    by_agent: agents,
    real: audits.filter((a) => a.strength === "decision").length,
    weak: audits.filter((a) => a.strength === "weak").length,
    rubber_stamps: audits.filter((a) => a.strength === "rubber_stamp").length,
    first_option_rate: rate(audits.filter((a) => a.chose_first_option).length),
    weak_evidence_rate: rate(audits.filter((a) => a.weak_evidence_only).length),
    executed: entries.filter((e) => e.executed).length,
    irreversible: entries.filter((e) => !e.reversible).length,
    reversals: entries.filter((e) => e.supersedes !== null).length,
    human_decisions: entries.filter((e) => e.agent === "Human").length,
    agent_decisions: entries.filter((e) => e.agent !== "Human").length,
    mechanism_verified: audits.filter((a) => a.mechanism === "verified").length,
    mechanism_refuted: audits.filter(
      (a) => a.mechanism === "refuted" || a.mechanism === "flip_did_not_flip",
    ).length,
    mechanism_unregistered: audits.filter((a) => a.mechanism === "unregistered").length,
    mechanism_absent: audits.filter((a) => a.mechanism === "absent").length,
    mechanisms_available: registeredMechanisms(),
    refs_total: entries.reduce((n, e) => n + (Array.isArray(e.evidence) ? e.evidence.length : 0), 0),
    refs_resolved: audits.reduce((n, a) => n + a.refs_resolved, 0),
    refs_broken: audits.reduce((n, a) => n + a.refs_broken, 0),
    entries_with_resolved_ref: audits.filter((a) => a.refs_resolved > 0).length,
    warnings: [],
    audits,
  };

  stats.warnings = deriveWarnings(stats, entries);
  return stats;
}

/**
 * The warnings a hostile reader would raise, raised by us first.
 *
 * Every line here is a criticism we expect from the panel. Printing them
 * ourselves is not modesty — it is the mechanism. A log that flags its own
 * three rubber stamps is a log whose other eleven entries are worth reading,
 * and a log that flags nothing is asking to be taken on faith.
 */
function deriveWarnings(stats: LogStats, entries: readonly DecisionEntry[]): string[] {
  const w: string[] = [];

  if (!stats.chain.ok) {
    w.push(`CHAIN BROKEN at entry ${stats.chain.broken_at}: ${stats.chain.detail ?? "unknown"}`);
  }
  if (stats.malformed_lines > 0) {
    w.push(`${stats.malformed_lines} unreadable line(s) in the log file — entries are missing from this summary`);
  }
  if (stats.rubber_stamps > 0) {
    w.push(`${stats.rubber_stamps} of ${stats.total} entries are RUBBER STAMPS by our own test — no real fork, no falsifier, or no evidence`);
  }
  if (stats.total >= 4 && stats.first_option_rate >= 0.9) {
    w.push(`${Math.round(stats.first_option_rate * 100)}% of decisions took the FIRST option listed — the ordering may be doing the deciding, not the agent`);
  }
  if (stats.weak_evidence_rate >= 0.5 && stats.total >= 4) {
    w.push(`${Math.round(stats.weak_evidence_rate * 100)}% of decisions rest only on fixture or model-prior evidence — nothing in the world could have surprised them`);
  }
  // The constant-function check, scoped to the option MENU rather than pooled.
  // Pooling was too weak: an agent that qualifies prospects (3 options) and also
  // ranks them (3 different options) shows up with several distinct choices
  // while being a constant function inside each question it is asked.
  for (const a of stats.by_agent) {
    if (a.agent === "Human") continue;
    for (const m of a.menus) {
      if (m.total >= 3 && m.distinct_choices === 1) {
        w.push(
          `${a.agent} was asked the same ${m.menu.split("|").length}-option question ${m.total} times and gave the same answer every time — inside this menu it is a constant function, not an agent (menu: ${m.menu})`,
        );
      }
    }
  }
  if (stats.mechanism_refuted > 0) {
    w.push(
      `${stats.mechanism_refuted} entr(y/ies) were CONTRADICTED by re-running the agent's own decision function — the record and the code disagree, and the record is what is wrong`,
    );
  }
  if (stats.total >= 4 && stats.mechanism_verified === 0) {
    w.push(
      `0 of ${stats.total} decisions had their decision function re-run (${stats.mechanism_absent} carry no replay pointer, ${stats.mechanism_unregistered} name code this process did not load) — everything below is WELL-FORMEDNESS, which a coin-flip agent also passes`,
    );
  }
  if (stats.refs_broken > 0) {
    w.push(
      `${stats.refs_broken} evidence ref(s) name a file in this repo that does not exist — those pointers are stale or invented`,
    );
  }
  if (stats.total >= 4 && stats.entries_with_resolved_ref === 0) {
    w.push(
      `no entry cites anything this checker could open — every ref is a URL, an external id or an internal handle, so nothing here is verifiable from a clone of the repo alone`,
    );
  }
  if (stats.total >= 8 && stats.reversals === 0) {
    w.push(`${stats.total} decisions and zero reversals — a company that was never wrong is not a company anyone believes`);
  }
  if (stats.total > 0 && stats.executed === 0) {
    w.push("nothing in this log was executed — every decision ran dry, so this is a simulation of an agent-run company, not one");
  }
  if (stats.agent_decisions === 0 && stats.total > 0) {
    w.push("every decision in this log was made by a human — no agent ran anything");
  }
  const orphans = entries.filter(
    (e) => e.supersedes !== null && !entries.some((o) => o.id === e.supersedes),
  );
  if (orphans.length > 0) {
    w.push(`${orphans.length} entr(y/ies) supersede an id that is not in this log — the record is incomplete`);
  }
  return w;
}

export interface SummaryOptions {
  /** Include the per-decision detail block. Default true. */
  detail?: boolean;
  /** Cap on decisions shown in detail. Default 12 — a 30-second read. */
  maxDetail?: number;
  malformedLines?: number;
  /** Repo root that evidence refs are resolved against. Defaults to cwd. */
  root?: string;
}

/**
 * The 30-second read.
 *
 * Structured as: who ran what, then the falsifiers (the part that proves the
 * decisions could have gone otherwise), then what this log does NOT prove. The
 * last section is not a disclaimer — it is the reason to believe the first two.
 */
export function summarize(entries: readonly DecisionEntry[], options: SummaryOptions = {}): string {
  const stats = computeStats(entries, options.malformedLines ?? 0, { root: options.root });
  const out: string[] = [];
  const rule = "─".repeat(78);

  out.push("ADLAYER — AGENT DECISION LOG");
  out.push(rule);

  if (stats.total === 0) {
    out.push("No decisions recorded. Nothing here claims otherwise.");
    return out.join("\n");
  }

  const chainLine = stats.chain.ok
    ? `chain VERIFIED across ${stats.chain.entries_checked} entries`
    : `chain BROKEN at entry ${stats.chain.broken_at}`;
  out.push(
    `${stats.total} decisions · ${stats.by_agent.length} actors · ${chainLine}`,
  );
  out.push(`${stats.first_at ?? "?"} → ${stats.last_at ?? "?"}`);
  // "well-formed", not "hold up". Well-formed is all the shape checks measure,
  // and a coin-flip agent passes them — see the header and the regression test.
  // The line that carries weight is the one under it.
  out.push(
    `${stats.real} well-formed · ${stats.weak} thin · ${stats.rubber_stamps} rubber stamp${stats.rubber_stamps === 1 ? "" : "s"} (shape only — a random agent passes this line)`,
  );
  out.push(
    `${stats.mechanism_verified} MECHANISM-VERIFIED (decision function re-run, choice reproduced, falsifier flipped it) · ` +
      `${stats.mechanism_refuted} refuted · ${stats.mechanism_absent + stats.mechanism_unregistered} not re-run`,
  );
  out.push(
    `${stats.entries_with_resolved_ref} of ${stats.total} cite something this checker opened · ` +
      `${stats.refs_resolved}/${stats.refs_total} refs resolved · ${stats.refs_broken} point at nothing`,
  );
  out.push(
    `${stats.executed} executed · ${stats.irreversible} irreversible · ${stats.reversals} reversed a previous call`,
  );
  out.push("");

  // ── Who ran the company ────────────────────────────────────────────────────
  out.push("WHO RAN THE COMPANY");
  const nameWidth = Math.max(...stats.by_agent.map((a) => a.agent.length), 10);
  for (const a of stats.by_agent) {
    const parts = [
      `${String(a.total).padStart(2)} decision${a.total === 1 ? "" : "s"}`,
      `${a.real} real`,
    ];
    // Only meaningful once an agent has decided more than once: one decision
    // trivially has one distinct choice, and printing it invites the reader to
    // read a constant function into a single data point.
    if (a.total >= 2) {
      // Per-menu, worst first — the pooled number flatters an agent that answers
      // several different questions, and this one does not.
      const menus = a.menus
        .filter((m) => m.total >= 2)
        .map((m) => `${m.distinct_choices}/${m.total}`)
        .join(", ");
      parts.push(
        `${a.distinct_choices} distinct choice${a.distinct_choices === 1 ? "" : "s"}` +
          (menus === "" ? "" : ` (per question: ${menus})`),
      );
    }
    if (a.mechanism_verified > 0 || a.mechanism_refuted > 0) {
      parts.push(`${a.mechanism_verified} replayed`);
    }
    parts.push(`${a.executed} executed`, `${a.irreversible} irreversible`);
    if (a.rubber_stamps > 0) parts.push(`${a.rubber_stamps} RUBBER STAMP`);
    out.push(`  ${a.agent.padEnd(nameWidth)}  ${parts.join(" · ")}`);
  }
  if (stats.human_decisions > 0) {
    out.push(
      `  (${stats.human_decisions} of ${stats.total} were decided by a person. Logged in the same ledger, on purpose.)`,
    );
  }
  out.push("");

  // ── The falsifiers ─────────────────────────────────────────────────────────
  if (options.detail !== false) {
    out.push("WHAT WOULD HAVE CHANGED EACH ANSWER");
    out.push("  (the counterfactual is the decision; without it there was no choice)");
    const limit = options.maxDetail ?? 12;
    const audits = new Map(stats.audits.map((a) => [a.entry_id, a]));
    for (const entry of entries.slice(0, limit)) {
      const audit = audits.get(entry.id);
      const chosen = entry.options.find((o) => o.id === entry.chosen_option_id);
      const flipTo = entry.options.find((o) => o.id === entry.flip_to_option_id);
      const mark =
        audit?.strength === "rubber_stamp" ? "!!" : audit?.strength === "weak" ? " ?" : "  ";
      out.push("");
      out.push(`${mark} [${entry.id}] ${entry.agent} — ${entry.question}`);
      out.push(`     chose    ${chosen?.summary ?? entry.chosen_option_id}`);
      if (flipTo !== undefined) {
        out.push(`     over     ${flipTo.summary}${entry.options.length > 2 ? ` (+${entry.options.length - 2} more)` : ""}`);
      }
      out.push(`     because  ${truncate(entry.rationale, 160)}`);
      out.push(`     WRONG IF ${truncate(entry.flip_condition, 160) || "— no falsifier stated —"}`);
      if (audit !== undefined && audit.mechanism !== "absent") {
        const tag =
          audit.mechanism === "verified"
            ? "REPLAY ✓"
            : audit.mechanism === "unregistered"
              ? "replay –"
              : "REPLAY ✗";
        out.push(`     ${tag} ${truncate(audit.mechanism_detail, 150)}`);
      }
      out.push(`     evidence ${describeEvidence(entry, options.root)}`);
      out.push(
        `     ${entry.executed ? "EXECUTED" : "dry run"} · ${entry.reversible ? "reversible" : "IRREVERSIBLE"} · ${truncate(entry.reversal_path, 90)}`,
      );
      if (entry.supersedes !== null) {
        out.push(`     REVERSES ${entry.supersedes} — the agent changed its mind on the record`);
      }
      if (audit !== undefined && audit.defects.length > 0) {
        out.push(`     DEFECTS  ${audit.defects.join(", ")}`);
      }
    }
    if (entries.length > limit) {
      out.push("");
      out.push(`  … ${entries.length - limit} more in the log file.`);
    }
    out.push("");
  }

  // ── What this does not prove ───────────────────────────────────────────────
  out.push("WHAT THIS LOG DOES NOT PROVE");
  out.push(
    "  The hash chain proves no entry was edited after it was written. It does not",
  );
  out.push(
    "  prove any decision was real when it was written — we wrote both the agents",
  );
  out.push("  and the log.");
  out.push("");
  out.push(
    "  WE FORGED THIS LOG OURSELVES TO FIND OUT. A 40-line agent whose every choice",
  );
  out.push(
    "  is Math.random(), with templated options and a templated falsifier, scores 14",
  );
  out.push(
    "  of 14 \"well-formed\", chain verified, zero warnings. Every shape check in this",
  );
  out.push(
    "  tool passes it. That test is in the suite and it still passes, so treat the",
  );
  out.push(
    "  well-formed count as a floor on effort, not as evidence of judgement.",
  );
  out.push("");
  out.push(
    "  The MECHANISM-VERIFIED count is the one the forgery cannot reach: it re-runs",
  );
  out.push(
    "  the agent's own pure decision function on the recorded inputs, then re-runs it",
  );
  out.push(
    "  with the flip condition's stated value substituted, and requires the choice to",
  );
  out.push(
    "  reproduce and then to change. It still does not prove the decision was GOOD.",
  );
  out.push("");
  out.push("  Judge it on the numbers below, which are computed against us:");
  out.push(
    `    · ${stats.mechanism_verified} of ${stats.total} had their decision function re-run and reproduced`,
  );
  out.push(
    `    · ${stats.entries_with_resolved_ref} of ${stats.total} cite at least one ref this checker opened from the repo`,
  );
  out.push(
    `    · ${Math.round(stats.first_option_rate * 100)}% took the first option listed (position bias)`,
  );
  out.push(
    `    · ${Math.round(stats.weak_evidence_rate * 100)}% rest only on fixture / model-prior evidence`,
  );
  out.push(
    `    · ${stats.rubber_stamps} of ${stats.total} fail our own rubber-stamp test`,
  );
  out.push(
    `    · ${stats.executed} of ${stats.total} actually changed something outside this log`,
  );
  if (stats.mechanisms_available.length > 0) {
    out.push(
      `    · decision functions runnable here: ${stats.mechanisms_available.join(", ")}`,
    );
  } else {
    out.push(
      "    · no decision functions were loaded in this process, so no replay could run",
    );
  }
  if (stats.warnings.length > 0) {
    out.push("");
    out.push("  WARNINGS WE RAISED ON OURSELVES");
    for (const warning of stats.warnings) out.push(`    ! ${warning}`);
  } else {
    out.push("");
    out.push("  No self-check fired. That is not a clean bill of health — it means the");
    out.push("  checks in auditEntry() did not catch anything, and they are ours too.");
  }

  return out.join("\n");
}

function describeEvidence(entry: DecisionEntry, root?: string): string {
  if (entry.evidence.length === 0) return "NONE — nothing here could have been surprised";
  const counts = new Map<EvidenceSource, number>();
  for (const item of entry.evidence) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([source, n]) => `${source}×${n}`);
  // Mark each printed ref with whether this process actually opened it. "✓" is
  // earned by a file that exists; "?" means real but not checkable from here.
  const refs = entry.evidence
    .map((e) => resolveEvidenceRef(e.ref, root ?? process.cwd()))
    .filter((r) => r.ref !== null)
    .map((r) => `${r.resolved ? "✓" : "?"}${r.ref ?? ""}`);
  const tail = refs.length > 0 ? `  → ${refs.slice(0, 3).join(", ")}` : "  (nothing a reader can open)";
  return `${parts.join(" ")}${tail}`;
}

function truncate(value: string, max: number): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Read a log file and summarize it in one call — what the CLI and dashboard use. */
export function summarizeFile(path: string, options: SummaryOptions = {}): string {
  const read = readLogWithDiagnostics(path);
  return summarize(read.entries, { ...options, malformedLines: read.malformed.length });
}
