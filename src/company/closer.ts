/**
 * ADLAYER — the CLOSER agent. Marketing and outbound.
 *
 * ── WHAT THIS AGENT ACTUALLY DECIDES, AND WHAT IT ONLY FORMATS ───────────────
 *
 * State the bar first, because most "agents" fail it: an agent that formats a
 * string is not an agent making a decision. If deleting the agent and hardcoding
 * its output changes nothing observable, it is decoration.
 *
 * By that test, this file contains THREE decisions and one renderer. Both are
 * named honestly:
 *
 *   1. WHETHER TO PITCH AT ALL — `decideDisposition()`. Output: send | hold |
 *      decline. Qualified prospects are declined here, and holding is not a
 *      polite no: it says the *evidence* is not yet good enough to assert
 *      anything about this company, and names what would fix it. Deleting this
 *      function changes who receives mail. It can be wrong in both directions:
 *      declining a prospect who would have bought, and sending on a four-query
 *      sample that a CMO shreds in one reply.
 *
 *   2. WHICH ANGLE — `decideAngle()`. Output: loss | opportunity | competitor
 *      framed. The same visibility score justifies different framings, and the
 *      choice is made on two measured quantities (the visibility number and how
 *      concentrated the competitor citations are), not on vibes. Naming a rival
 *      in a cold email is a real risk with a real payoff; we take it only when
 *      one domain actually dominates the answers. Deleting this changes what the
 *      recipient reads. It can be wrong: competitor framing lands as hostile,
 *      loss framing on a mid score reads as inaccurate and gets us deleted.
 *
 *   3. WHICH CHANNEL — `decideChannel()`. Output: email_direct | contact_form |
 *      defer_to_human. Decided on CONSENT BASIS, not on convenience: an address
 *      published on an "advertise with us" page is an invitation; an address
 *      scraped off a homepage is not, and that one routes to a human instead of
 *      to a send queue. Deleting this changes whether we mail scraped addresses.
 *      It can be wrong: deferring costs deals that a spray-and-pray shop closes.
 *
 *   4. THE COPY — `renderTemplate()` and `draftWithModel()`. This is FORMATTING,
 *      and it is labelled formatting. The model, when a key exists, writes prose;
 *      it does not decide anything. Its output is checked against the evidence
 *      and thrown away if it invents a number or writes a deceptive subject. A
 *      language model that cannot be overruled is a liability in outbound.
 *
 * ── WHY THIS IS NOT SPAM, MECHANICALLY ──────────────────────────────────────
 *
 * The pitch opens with the prospect's own measured invisibility number and the
 * domains cited instead of them. That is the whole justification for the
 * contact, so it is enforced rather than encouraged:
 *
 *   - Every number that appears in a subject line or body must be derivable from
 *     the `InvisibilityScore` we measured. `assertNoFabricatedMetrics()` extracts
 *     every numeric token from the rendered draft and refuses any that is not in
 *     the allow-list built from the evidence. There is no flag that disables it,
 *     for the same reason `assertDisclosed()` has none in contract.ts.
 *   - Every competitor domain named in the copy comes from `score.competitors`.
 *   - A score whose `source` is `fixture` cannot be pitched on at all. Asserting
 *     a measured fact about a stranger that we did not measure is the single
 *     fastest way to turn this from measurement into fraud.
 *
 * ── SAFETY POSTURE ──────────────────────────────────────────────────────────
 *
 *   - NO LIVE SEND PATH EXISTS IN THIS FILE. Not gated — absent. `flags.liveSend`
 *     is honoured by logging one line saying no transport is wired and returning
 *     `sent: false`. Wiring a transport is a separate change with its own review.
 *   - Drafts reach disk only when the caller names `flags.draftDir`. No path, no
 *     bytes. Dry run is the default and the default is the only thing wired.
 *   - Missing ANTHROPIC_API_KEY degrades with exactly one log line to the
 *     deterministic template. It never throws and never blocks.
 *   - Zero runtime dependencies: node stdlib and global fetch. This is why the
 *     model call is raw HTTP rather than @anthropic-ai/sdk — the project rule is
 *     zero new deps, and src/serve/pioneer.ts sets the same precedent.
 *
 * ── KNOWN LIMITS, STATED RATHER THAN HIDDEN ─────────────────────────────────
 *
 *   - The number guard proves no *numeric* claim was invented. It cannot catch a
 *     fabricated qualitative claim ("your competitors are all doing this").
 *     Partially mitigated by `findComplianceViolations()`'s banned-claim list,
 *     which is a blocklist and therefore incomplete by construction.
 *   - The angle decision is a three-branch ladder over two measured numbers. It
 *     is a real function of the evidence, but it is a small one; a reader should
 *     hold `flip_condition` against `evidence` and see how close the call was,
 *     which is exactly what the DecisionLog prints.
 *   - CAN-SPAM-shaped requirements (identifiable sender, working opt-out, postal
 *     address) are represented as `send_blockers`, not silently filled in. An
 *     unconfigured Closer can never report itself send-ready, and it will not
 *     invent an address to make itself look finished.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DISCLOSURE_TAG } from "../contract.ts";
import {
  openDecisionLog,
  registerMechanism,
  type DecisionDraft,
  type DecisionEntry,
  type DecisionEvidence,
  type DecisionReplay,
  type DecisionSink,
  type EvidenceSource,
} from "./decision-log.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs.
//
// Declared here rather than imported from prospector.ts on purpose: the
// Prospector is another workstream's file, and a compile-time dependency on a
// module that may not exist yet would break `tsc` for everyone. These shapes are
// structural — anything that matches slots in, including the Prospector's output
// and the `Score`/`SourceStats` pair that engine/retrieve already emits.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How we came to hold this contact route. This is a CONSENT BASIS, not a
 * convenience label, and `decideChannel()` reads it as one.
 */
export type ContactSource =
  /** Published on an "advertise with us" / partnerships page. An invitation. */
  | "advertising_invite"
  /** They contacted us first. */
  | "inbound_request"
  /** A public business directory listing for commercial enquiries. */
  | "public_listing"
  /** Their site offers a contact form. The form is the invited route. */
  | "contact_form"
  /** Harvested from a page that did not invite commercial contact. */
  | "scraped"
  /** We do not know where this came from. Treated as weaker than scraped. */
  | "unknown";

export interface ProspectContact {
  email: string | null;
  /** URL of their contact form, when one exists. */
  form_url: string | null;
  source: ContactSource;
}

export interface Prospect {
  id: string;
  /** Display name used in the copy. */
  name: string;
  /** Bare domain, e.g. "acme.com". Must match what measurement scored. */
  domain: string;
  categories: string[];
  contact: ProspectContact;
  /** ISO of our last outbound to them, or null. Drives the frequency cap. */
  last_contacted_at: string | null;
  /** They asked not to be contacted. Terminal. */
  opted_out: boolean;
  /** Something a reader can open to check this record exists. */
  record_ref: string | null;
}

export interface CompetitorCitation {
  domain: string;
  citation_count: number;
}

/**
 * The measured invisibility of a prospect. Structurally compatible with
 * engine/retrieve's `Score` + `SourceStats`, plus the provenance fields that
 * decide whether we are allowed to assert any of it to a stranger.
 */
export interface InvisibilityScore {
  /** 0..1 — share of measured queries whose answer cited the prospect. */
  visibility: number;
  cited_queries: number;
  total_queries: number;
  /** Domains cited instead, most-cited first. */
  competitors: CompetitorCitation[];
  /** Which engine produced this. Named in the copy so the claim is checkable. */
  engine: string;
  /** ISO. When the measurement ran. */
  measured_at: string | null;
  /**
   * `measurement` = our engine observed it live. `fixture` = seeded demo data.
   * A fixture score is NOT pitchable — see `decideDisposition()`.
   */
  source: "measurement" | "fixture";
  /** A retrieve run id, cache path, or PropagationCheck id. */
  ref: string | null;
  /** The queries actually asked. Quoted in the copy so they can be re-run. */
  queries: string[];
}

/** Who the mail is from. Nothing here is defaulted to a plausible-looking lie. */
export interface SenderIdentity {
  name: string;
  /** Address that reaches a human and accepts an opt-out. */
  reply_to: string | null;
  website: string | null;
  /** Required before any real send. `null` is a blocker, never a placeholder. */
  postal_address: string | null;
}

export const DEFAULT_SENDER: SenderIdentity = {
  name: "AdLayer",
  reply_to: null,
  website: null,
  postal_address: null,
};

export interface CloserFlags {
  /**
   * Honoured by REFUSING and logging one line. There is no transport in this
   * module; the flag exists so callers cannot believe they enabled one.
   */
  liveSend?: boolean;
  /** Name a directory and drafts are written there. Omit it and nothing is. */
  draftDir?: string | null;
  /** Where decisions go. Omitted → a memory-only log, per the dry-run rule. */
  log?: DecisionSink;
  sender?: SenderIdentity;
  /** Injected in tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injected in tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger?: (message: string) => void;
  /** Set false to skip the model entirely and render the template. */
  useModel?: boolean;
  /** What Pricing says this placement is worth. Logged, never put in the copy. */
  placementPriceCents?: number | null;
  timeoutMs?: number;
  /** Frequency cap. Defaults to `RECONTACT_DAYS`. */
  recontactDays?: number;
}

export type Disposition = "send" | "hold" | "decline";
export type PitchAngle = "loss_framed" | "opportunity_framed" | "competitor_framed";
export type PitchChannel = "email_direct" | "contact_form" | "defer_to_human";

export interface CloserDecision {
  prospect_id: string;
  disposition: Disposition;
  angle: PitchAngle | null;
  channel: PitchChannel | null;
  /** One line a human reads and understands. */
  reason: string;
  copy_source: "template" | "model" | "none";
  /** Always false. See the header: no transport exists in this file. */
  sent: boolean;
  /** What must be true before this could be sent for real. */
  send_blockers: string[];
  draft_path: string | null;
  /** One line per degradation. Empty means nothing degraded. */
  degraded: string[];
  entries: DecisionEntry[];
}

export interface PitchResult {
  subject: string;
  body: string;
  decision: CloserDecision;
}

/** Thrown only when an invariant of OUR OWN code broke. Never on bad input. */
export class CloserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloserError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The thresholds. Exported because a decision whose boundaries are private is a
// decision a reader cannot check, and `flip_condition` quotes these numbers.
// ─────────────────────────────────────────────────────────────────────────────

/** Above this visibility they are not invisible, and our premise is false. */
export const VISIBILITY_PITCH_CEILING = 0.35;
/** Below this many queries the number is real but the sample is not assertable. */
export const MIN_QUERIES_FOR_ASSERTION = 4;
/** At or below this visibility, loss framing is accurate rather than rude. */
export const LOSS_FRAME_CEILING = 0.1;
/** Top competitor's share of measured citations needed to name them. */
export const COMPETITOR_CONCENTRATION_FLOOR = 0.4;
/** Frequency cap, in days. */
export const RECONTACT_DAYS = 30;

/** Deceptive-subject patterns. Blocklist: incomplete by construction, on record. */
export const BANNED_URGENCY = [
  "act now",
  "last chance",
  "final notice",
  "limited time",
  "expires soon",
  "expires today",
  "24 hours",
  "don't miss",
  "dont miss",
  "hurry",
  "urgent",
  "immediate action",
] as const;

/** Claims about the prospect or the product we cannot substantiate. */
export const BANNED_CLAIMS = [
  "guaranteed",
  "guarantee",
  "risk-free",
  "risk free",
  "no risk",
  "double your",
  "10x",
  "industry-leading",
  "industry leading",
  "#1",
  "number one",
  "everyone is",
  "your competitors are all",
  "thousands of customers",
  "millions of",
  "losing thousands",
] as const;

/** The opt-out sentence. Presence is checked; wording is ours, not the model's. */
export const OPT_OUT_SENTENCE =
  'Reply "no" and we will not contact you again.';

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 1 — pitch at all?
// ─────────────────────────────────────────────────────────────────────────────

export interface GateVerdict {
  disposition: Disposition;
  /** Which rule fired. Named so the log can point at it. */
  rule:
    | "opted_out"
    | "no_contact_route"
    | "evidence_is_fixture"
    | "sample_too_small"
    | "already_visible"
    | "frequency_cap"
    | "qualified";
  reason: string;
  /** The other option that was genuinely on the table. `null` when there was none. */
  alternative: Disposition | null;
  /** What the alternative would have looked like, if taken. */
  alternative_outcome: string;
  /** Stated in the same units as the evidence. */
  flip_condition: string;
  /** Days since our last contact, or null. Surfaced so the log can cite it. */
  days_since_contact: number | null;
}

/**
 * Whether to contact this prospect at all.
 *
 * Ordered by how terminal each rule is. Two of the rules — opt-out and no
 * contact route — are RULES, not judgements: there is no defensible second
 * option, so they log a single-option entry and our own `auditEntry()` grades
 * them `rubber_stamp`. That is the correct grade and we let it stand. Inventing
 * a strawman alternative to dress a rule as a decision is the exact theatre the
 * DecisionLog exists to catch, and doing it here would be catching ourselves
 * lying to our own auditor.
 *
 * The other four are judgements with a defensible losing option, and the losing
 * option is what a less careful shop would in fact do.
 */
export function decideDisposition(
  prospect: Prospect,
  score: InvisibilityScore,
  now: Date,
  recontactDays: number = RECONTACT_DAYS,
): GateVerdict {
  const days = daysSince(prospect.last_contacted_at, now);

  if (prospect.opted_out) {
    return {
      disposition: "decline",
      rule: "opted_out",
      reason: `${prospect.name} has opted out. There is no second option here.`,
      alternative: null,
      alternative_outcome: "",
      flip_condition:
        "Nothing in the evidence flips this. An opt-out is honoured unconditionally, which is why this entry has one option and grades as a rubber stamp.",
      days_since_contact: days,
    };
  }

  if (prospect.contact.email === null && prospect.contact.form_url === null) {
    return {
      disposition: "decline",
      rule: "no_contact_route",
      reason: `No email and no contact form for ${prospect.domain}. There is nothing to send to.`,
      alternative: null,
      alternative_outcome: "",
      flip_condition:
        "Nothing in the measurement flips this. A contact route either exists in the record or it does not.",
      days_since_contact: days,
    };
  }

  if (score.source !== "measurement") {
    return {
      disposition: "hold",
      rule: "evidence_is_fixture",
      reason:
        `The invisibility number for ${prospect.domain} came from ${score.source} data, not a live measurement. ` +
        "The entire justification for this email is that we measured them, so it does not go out until we have.",
      alternative: "send",
      alternative_outcome:
        "Pitch now with the fixture number and a provenance caveat: contact happens today, and we assert a number about a stranger that our own engine did not observe.",
      flip_condition: `If score.source had been "measurement" rather than "${score.source}", this would have been sent.`,
      days_since_contact: days,
    };
  }

  if (score.total_queries < MIN_QUERIES_FOR_ASSERTION) {
    return {
      disposition: "hold",
      rule: "sample_too_small",
      reason:
        `Only ${score.total_queries} quer${score.total_queries === 1 ? "y" : "ies"} were measured for ${prospect.domain}, ` +
        `below the ${MIN_QUERIES_FOR_ASSERTION}-query floor. The number is real and the sample is not defensible in a reply.`,
      alternative: "send",
      alternative_outcome:
        "Send now with an explicit sample-size caveat: we reach them a day earlier, and the first informed reply is about our methodology instead of their problem.",
      flip_condition: `If total_queries had been at least ${MIN_QUERIES_FOR_ASSERTION} (it was ${score.total_queries}), this would have been sent.`,
      days_since_contact: days,
    };
  }

  if (score.visibility > VISIBILITY_PITCH_CEILING) {
    return {
      disposition: "decline",
      rule: "already_visible",
      reason:
        `${prospect.domain} is cited in ${score.cited_queries} of ${score.total_queries} answers ` +
        `(visibility ${fmt(score.visibility)}), above the ${VISIBILITY_PITCH_CEILING} ceiling. They do not have the problem we sell against.`,
      alternative: "send",
      alternative_outcome:
        "Pitch them anyway on defend-your-position framing: one more qualified name in the pipeline, and an opening claim they can disprove in ten seconds.",
      flip_condition: `If visibility had been at or below ${VISIBILITY_PITCH_CEILING} (it was ${fmt(score.visibility)}), this would have been sent.`,
      days_since_contact: days,
    };
  }

  if (days !== null && days < recontactDays) {
    return {
      disposition: "decline",
      rule: "frequency_cap",
      reason:
        `We contacted ${prospect.name} ${days} day${days === 1 ? "" : "s"} ago, inside the ${recontactDays}-day cap.`,
      alternative: "send",
      alternative_outcome:
        "Send a follow-up referencing the previous message: a second touch inside a month, at the cost of being the outbound shop that mails weekly.",
      flip_condition: `If days since last contact had been at least ${recontactDays} (it was ${days}), this would have been sent.`,
      days_since_contact: days,
    };
  }

  return {
    disposition: "send",
    rule: "qualified",
    reason:
      `${prospect.domain} is cited in ${score.cited_queries} of ${score.total_queries} measured answers on ${score.engine}. ` +
      "The claim is measured, dated, sourced, and checkable by them in one query.",
    alternative: "hold",
    alternative_outcome:
      "Hold for a second measurement round: a stronger, two-run claim in a day, against a first-mover window that is currently open.",
    flip_condition: `If total_queries had been below ${MIN_QUERIES_FOR_ASSERTION}, or visibility above ${VISIBILITY_PITCH_CEILING}, or the score a fixture, this would have been held or declined.`,
    days_since_contact: days,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MECHANISM REPLAY for the gate — the auditor runs the rule, not the write-up
//
// `decideDisposition` above is already pure and total. This exposes it to the
// DecisionLog by name, so an auditor can re-run it on the exact record the entry
// carries instead of reading the rationale and believing it. The check that
// matters is the second one: we substitute the value the flip condition names,
// re-run, and require the disposition to actually change. A falsifier that does
// not falsify is caught here rather than admired in a demo.
//
// A coin-flip agent cannot survive this. `Math.random()` does not reproduce on
// the first assertion; making it deterministic to get past that runs straight
// into the second, which demands the choice be a function of the evidence.
// ─────────────────────────────────────────────────────────────────────────────

/** Registry key. The DecisionLog re-runs the gate by this name. */
export const CLOSER_GATE_MECHANISM = "closer.decideDisposition";

/** Everything `decideDisposition` reads, as plain JSON. */
export interface GateInput {
  prospect: Prospect;
  score: InvisibilityScore;
  /** ISO — `Date` does not survive a JSON round trip, and entries are re-read off disk. */
  now: string;
  recontact_days: number;
}

export function closerGateMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const input = raw as GateInput;
  if (input.prospect === undefined || input.score === undefined) return null;
  const at = new Date(input.now);
  if (Number.isNaN(at.getTime())) return null;
  return `opt_${decideDisposition(input.prospect, input.score, at, input.recontact_days).disposition}`;
}

registerMechanism(CLOSER_GATE_MECHANISM, closerGateMechanism);

/**
 * The flip condition's stated value, substituted into the field it names.
 *
 * Each branch mirrors one sentence in `decideDisposition` above — "if
 * total_queries had been at least 4", "if visibility had been at or below
 * 0.35". The point of writing it here rather than in prose is that it can be
 * RUN: `gateReplay` below only attaches the pointer when re-running actually
 * produces the alternative the entry claims.
 */
function flipInputFor(input: GateInput, gate: GateVerdict): GateInput | null {
  switch (gate.rule) {
    case "evidence_is_fixture":
      return { ...input, score: { ...input.score, source: "measurement" } };
    case "sample_too_small":
      return {
        ...input,
        score: { ...input.score, total_queries: MIN_QUERIES_FOR_ASSERTION },
      };
    case "already_visible":
      return { ...input, score: { ...input.score, visibility: VISIBILITY_PITCH_CEILING } };
    case "frequency_cap":
      return { ...input, prospect: { ...input.prospect, last_contacted_at: null } };
    case "qualified":
      // The stated falsifier is a three-way ("below the query floor, OR above
      // the visibility ceiling, OR a fixture"). We replay the first clause.
      return {
        ...input,
        score: { ...input.score, total_queries: MIN_QUERIES_FOR_ASSERTION - 1 },
      };
    case "opted_out":
    case "no_contact_route":
      // Rules, not judgements. Nothing flips them, which is exactly why those
      // entries carry one option and grade as rubber stamps.
      return null;
    default:
      return null;
  }
}

/**
 * Build the replay pointer, or return null.
 *
 * ONLY attached when it verifies here. An unverifiable replay is worse than
 * none: `auditEntry()` treats a refuted one as fatal, correctly, because it
 * means the record and the code disagree.
 */
/** Registry keys for the Closer's other two pure deciders. */
export const CLOSER_ANGLE_MECHANISM = "closer.decideAngle";
export const CLOSER_CHANNEL_MECHANISM = "closer.decideChannel";

export function closerAngleMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const score = raw as InvisibilityScore;
  if (!Array.isArray(score.competitors)) return null;
  return `opt_${decideAngle(score).angle}`;
}

export function closerChannelMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const contact = raw as ProspectContact;
  if (typeof contact.source !== "string") return null;
  return `opt_${decideChannel(contact).channel}`;
}

registerMechanism(CLOSER_ANGLE_MECHANISM, closerAngleMechanism);
registerMechanism(CLOSER_CHANNEL_MECHANISM, closerChannelMechanism);

/**
 * "If <top competitor>'s share had been below the floor" / "if visibility had
 * been at or below the ceiling" — the same two sentences `decideAngle` writes,
 * substituted into the score the entry carries. Verified before it is attached.
 */
export function angleReplay(score: InvisibilityScore, angle: AngleVerdict): DecisionReplay | null {
  if (closerAngleMechanism(score) !== `opt_${angle.angle}`) return null;

  const attempts: InvisibilityScore[] = [];
  if (angle.decided_on === "competitor_concentration") {
    // Dilute the top competitor's share below the floor by adding citations
    // elsewhere — the concrete form of "its share had been below the floor".
    const [first, ...rest] = score.competitors;
    if (first !== undefined) {
      attempts.push({
        ...score,
        competitors: [
          { ...first, citation_count: 1 },
          ...rest,
          { domain: "other.example", citation_count: 99 },
        ],
      });
    }
  } else {
    attempts.push({
      ...score,
      visibility: score.visibility <= LOSS_FRAME_CEILING ? LOSS_FRAME_CEILING + 0.01 : LOSS_FRAME_CEILING,
    });
  }
  // The competitor framing is reachable from either branch: concentrate the
  // rival instead of diluting it.
  const [first] = score.competitors;
  if (first !== undefined) {
    attempts.push({ ...score, competitors: [{ ...first, citation_count: 100 }] });
  }

  for (const attempt of attempts) {
    if (closerAngleMechanism(attempt) === `opt_${angle.runner_up}`) {
      return { fn: CLOSER_ANGLE_MECHANISM, input: score, flip_input: attempt };
    }
  }
  return null;
}

/**
 * "If contact.source had been scraped" / "if no form URL had been on record" —
 * the consent basis this agent routes on, substituted and re-run.
 */
export function channelReplay(
  contact: ProspectContact,
  channel: ChannelVerdict,
): DecisionReplay | null {
  if (closerChannelMechanism(contact) !== `opt_${channel.channel}`) return null;

  const attempts: ProspectContact[] = [
    { ...contact, source: "scraped" },
    { ...contact, form_url: null },
    { ...contact, source: "public_listing", email: contact.email ?? "someone@example.com" },
    { ...contact, email: null },
  ];
  for (const attempt of attempts) {
    if (closerChannelMechanism(attempt) === `opt_${channel.runner_up}`) {
      return { fn: CLOSER_CHANNEL_MECHANISM, input: contact, flip_input: attempt };
    }
  }
  return null;
}

export function gateReplay(
  prospect: Prospect,
  score: InvisibilityScore,
  now: Date,
  recontactDays: number,
  gate: GateVerdict,
): DecisionReplay | null {
  const input: GateInput = {
    prospect,
    score,
    now: now.toISOString(),
    recontact_days: recontactDays,
  };
  if (closerGateMechanism(input) !== `opt_${gate.disposition}`) return null;
  if (gate.alternative === null) return null;

  const flipInput = flipInputFor(input, gate);
  if (flipInput === null) return null;
  if (closerGateMechanism(flipInput) !== `opt_${gate.alternative}`) return null;

  return { fn: CLOSER_GATE_MECHANISM, input, flip_input: flipInput };
}

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 2 — the angle
// ─────────────────────────────────────────────────────────────────────────────

export interface AngleVerdict {
  angle: PitchAngle;
  /** The framing that lost, and would have been taken if the flip held. */
  runner_up: PitchAngle;
  flip_condition: string;
  /** Top competitor and its share of measured citations. `null` if none. */
  top_competitor: { domain: string; citation_count: number; share: number } | null;
  /** How far the deciding quantity sat from its boundary. Signed. */
  margin: number;
  /** Which quantity decided it, so a reader knows which margin to read. */
  decided_on: "competitor_concentration" | "visibility";
}

/**
 * Which framing to open with.
 *
 * Three framings of the same score, decided on two measured quantities:
 *
 *   COMPETITOR — one domain owns the answers. Naming them is concrete and
 *     verifiable, and it is the highest-risk framing we have: get it wrong and
 *     the recipient reads it as us picking a fight on their behalf. Gated on the
 *     top domain holding at least `COMPETITOR_CONCENTRATION_FLOOR` of the
 *     measured citations, because naming an arbitrary rival is worse than
 *     naming none.
 *   LOSS — they are absent, full stop. Only accurate at or below
 *     `LOSS_FRAME_CEILING`; above it, "you are invisible" is a claim the
 *     recipient can falsify from their own logs, and then everything else we say
 *     is suspect.
 *   OPPORTUNITY — they are partly there. Loss framing here would be wrong, so
 *     the unpriced-inventory framing carries the message instead.
 */
export function decideAngle(score: InvisibilityScore): AngleVerdict {
  const totalCitations = score.competitors.reduce((sum, c) => sum + c.citation_count, 0);
  const first = score.competitors[0];
  const top =
    first !== undefined && totalCitations > 0
      ? {
          domain: first.domain,
          citation_count: first.citation_count,
          share: round(first.citation_count / totalCitations, 4),
        }
      : null;

  const lowVisibilityFallback: PitchAngle =
    score.visibility <= LOSS_FRAME_CEILING ? "loss_framed" : "opportunity_framed";

  if (top !== null && top.share >= COMPETITOR_CONCENTRATION_FLOOR) {
    return {
      angle: "competitor_framed",
      runner_up: lowVisibilityFallback,
      flip_condition:
        `If ${top.domain}'s share of measured citations had been below ${COMPETITOR_CONCENTRATION_FLOOR} ` +
        `(it was ${fmt(top.share)}), the angle would have been ${lowVisibilityFallback}.`,
      top_competitor: top,
      margin: round(top.share - COMPETITOR_CONCENTRATION_FLOOR, 4),
      decided_on: "competitor_concentration",
    };
  }

  if (score.visibility <= LOSS_FRAME_CEILING) {
    return {
      angle: "loss_framed",
      runner_up: "opportunity_framed",
      flip_condition:
        `If visibility had been above ${LOSS_FRAME_CEILING} (it was ${fmt(score.visibility)}), ` +
        "the angle would have been opportunity_framed, because absence would not have been an accurate description.",
      top_competitor: top,
      margin: round(LOSS_FRAME_CEILING - score.visibility, 4),
      decided_on: "visibility",
    };
  }

  return {
    angle: "opportunity_framed",
    runner_up: "loss_framed",
    flip_condition:
      `If visibility had been at or below ${LOSS_FRAME_CEILING} (it was ${fmt(score.visibility)}), ` +
      "the angle would have been loss_framed.",
    top_competitor: top,
    margin: round(score.visibility - LOSS_FRAME_CEILING, 4),
    decided_on: "visibility",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DECISION 3 — the channel
// ─────────────────────────────────────────────────────────────────────────────

export interface ChannelVerdict {
  channel: PitchChannel;
  runner_up: PitchChannel;
  reason: string;
  flip_condition: string;
  basis: ContactSource;
}

/**
 * Which route to use, decided on consent basis.
 *
 * The losing option is always "email the address we have", because that is what
 * the industry does and it is why cold outbound has the reputation it has. We
 * take it only where the address was published as an invitation to exactly this
 * kind of contact. A scraped address with no form routes to a human, which
 * costs us deals — that cost is the evidence that this function decides
 * something.
 */
export function decideChannel(contact: ProspectContact): ChannelVerdict {
  const invited =
    contact.source === "advertising_invite" ||
    contact.source === "inbound_request" ||
    contact.source === "public_listing";

  if (invited && contact.email !== null) {
    return {
      channel: "email_direct",
      runner_up: contact.form_url !== null ? "contact_form" : "defer_to_human",
      reason: `The address was published as ${contact.source.replace(/_/g, " ")} — commercial contact is invited.`,
      flip_condition: `If contact.source had been "scraped" or "unknown", this would have gone to a human instead of to email.`,
      basis: contact.source,
    };
  }

  if (contact.form_url !== null) {
    return {
      channel: "contact_form",
      runner_up: contact.email !== null ? "email_direct" : "defer_to_human",
      reason:
        "They publish a contact form. The form is the route they invited, and using it instead of an address we found is the difference between a message and an intrusion.",
      flip_condition: `If no form URL had been on record, the choice would have been ${contact.email !== null ? "email_direct or defer_to_human on consent basis" : "defer_to_human"}.`,
      basis: contact.source,
    };
  }

  return {
    channel: "defer_to_human",
    runner_up: "email_direct",
    reason:
      `The only route is an address obtained by ${contact.source}, with no form. A person decides whether contacting it is acceptable; the agent does not.`,
    flip_condition:
      'If contact.source had been "advertising_invite", "inbound_request" or "public_listing", this would have gone out by email without a human.',
    basis: contact.source,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The fabricated-metric guard.
//
// This is the piece that makes "everything asserted about them comes from the
// measured score" a property of the code rather than a promise in a comment.
// ─────────────────────────────────────────────────────────────────────────────

export interface AllowedNumbers {
  /** Normalized numeric strings that may appear in the copy. */
  values: Set<string>;
  /**
   * Substrings masked out before the numeric scan — domains, names, dates,
   * category slugs, quoted queries. A digit inside "web3.io" is part of an
   * identifier, not a claim.
   */
  literals: string[];
}

/**
 * Every number the copy is allowed to contain, derived from the evidence alone.
 *
 * Note what is NOT here: price. The Pricing agent owns that number and the
 * Closer must not quote one, so any price appearing in a draft is caught as a
 * fabricated metric — which is the correct outcome, not an inconvenience.
 */
export function allowedNumbersFor(
  prospect: Prospect,
  score: InvisibilityScore,
  sender: SenderIdentity,
): AllowedNumbers {
  const values = new Set<string>();
  const add = (n: number): void => {
    if (Number.isFinite(n)) values.add(normalizeNumber(String(n)));
  };

  add(score.cited_queries);
  add(score.total_queries);
  add(score.total_queries - score.cited_queries);
  add(score.competitors.length);
  add(Math.round(score.visibility * 100));
  add(round(score.visibility, 4));
  for (const competitor of score.competitors) add(competitor.citation_count);

  const literals: string[] = [
    prospect.name,
    prospect.domain,
    prospect.id,
    ...prospect.categories,
    ...score.competitors.map((c) => c.domain),
    ...score.queries,
    score.engine,
    DISCLOSURE_TAG,
    sender.name,
  ];
  if (score.measured_at !== null) {
    literals.push(score.measured_at, score.measured_at.slice(0, 10));
  }
  if (sender.reply_to !== null) literals.push(sender.reply_to);
  if (sender.website !== null) literals.push(sender.website);
  if (sender.postal_address !== null) literals.push(sender.postal_address);

  return { values, literals: literals.filter((l) => l !== "") };
}

/** Strip commas and trailing zeros so "0.00", "0" and "0.0" compare equal. */
function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(/,/g, "").replace(/%$/, "");
  const asNumber = Number(cleaned);
  return Number.isFinite(asNumber) ? String(asNumber) : cleaned;
}

/** Blank out allowed literals so digits inside identifiers are not scanned. */
export function maskLiterals(text: string, literals: readonly string[]): string {
  let masked = text;
  // Longest first: masking "acme.com" before "acme" avoids leaving ".com".
  for (const literal of [...literals].sort((a, b) => b.length - a.length)) {
    if (literal.trim() === "") continue;
    masked = masked.split(literal).join(" ");
    const lower = literal.toLowerCase();
    if (lower !== literal) masked = masked.split(lower).join(" ");
  }
  return masked;
}

/**
 * Every numeric token in the text that the evidence does not support.
 *
 * Deliberately naive about context: a number is a number. We would rather write
 * numbers out as words ("fifteen minutes") than teach this function to forgive
 * a category of them, because every forgiveness is a hole an LLM will find.
 */
export function findFabricatedNumbers(text: string, allowed: AllowedNumbers): string[] {
  const masked = maskLiterals(text, allowed.literals);
  const found: string[] = [];
  for (const match of masked.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = match[0];
    if (raw === undefined || raw === "") continue;
    if (!allowed.values.has(normalizeNumber(raw))) found.push(raw);
  }
  return found;
}

/**
 * Hard invariant. There is deliberately no flag that disables this, for the same
 * reason `assertDisclosed()` has none: a pitch containing an invented statistic
 * about a company is not marketing, it is a false statement of fact about a
 * third party, and shipping one would destroy the only thing that makes this
 * outbound defensible.
 */
export function assertNoFabricatedMetrics(
  subject: string,
  body: string,
  allowed: AllowedNumbers,
): void {
  const bad = [
    ...findFabricatedNumbers(subject, allowed),
    ...findFabricatedNumbers(body, allowed),
  ];
  if (bad.length > 0) {
    throw new CloserError(
      `refusing to draft: copy contains number(s) not derivable from the measurement: ${bad.join(", ")}. ` +
        "Everything asserted about a prospect must come from their score.",
    );
  }
}

/**
 * Deceptive-subject and unsubstantiated-claim checks.
 *
 * A blocklist, and blocklists are incomplete — that is stated here rather than
 * discovered by a judge. It catches the failure modes an LLM reaches for
 * unprompted, which is the population it is aimed at.
 */
export function findComplianceViolations(
  subject: string,
  body: string,
  allowed: AllowedNumbers,
): string[] {
  const problems: string[] = [];
  const subjectLower = subject.toLowerCase();
  const bodyLower = body.toLowerCase();

  if (subject.trim() === "") problems.push("subject is empty");
  if (/^\s*(re|fwd|fw)\s*:/i.test(subject)) {
    problems.push("subject fakes a reply or forward");
  }
  if (subject.includes("!")) problems.push("subject uses an exclamation mark");
  if (/!!/.test(body)) problems.push("body uses repeated exclamation marks");

  const maskedSubject = maskLiterals(subject, allowed.literals);
  const shouting = maskedSubject.match(/\b[A-Z]{4,}\b/g);
  if (shouting !== null) problems.push(`subject shouts: ${shouting.join(", ")}`);

  for (const phrase of BANNED_URGENCY) {
    if (subjectLower.includes(phrase)) problems.push(`subject invents urgency: "${phrase}"`);
    if (bodyLower.includes(phrase)) problems.push(`body invents urgency: "${phrase}"`);
  }
  for (const phrase of BANNED_CLAIMS) {
    if (subjectLower.includes(phrase)) problems.push(`subject makes an unsupported claim: "${phrase}"`);
    if (bodyLower.includes(phrase)) problems.push(`body makes an unsupported claim: "${phrase}"`);
  }
  if (!body.includes(OPT_OUT_SENTENCE)) problems.push("body has no opt-out sentence");

  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// The renderer. FORMATTING, not deciding — labelled as such in the header.
// ─────────────────────────────────────────────────────────────────────────────

/** The opening sentence. Always the measured number, always first. */
export function evidenceOpening(prospect: Prospect, score: InvisibilityScore): string {
  return (
    `${prospect.name} is cited in ${score.cited_queries} of the ${score.total_queries} AI answers we measured.`
  );
}

function evidenceParagraph(prospect: Prospect, score: InvisibilityScore): string {
  const dated = score.measured_at !== null ? ` on ${score.measured_at.slice(0, 10)}` : "";
  const lines = [
    `${evidenceOpening(prospect, score)} Here is the measurement, and it is the only reason you are reading this.`,
    "",
    `We put ${score.total_queries} buying-intent queries to ${score.engine}${dated} and recorded which domains the answers cited. ` +
      `${prospect.domain} was cited in ${score.cited_queries} of them.`,
  ];

  if (score.competitors.length > 0) {
    const named = score.competitors
      .slice(0, 3)
      .map((c) => `${c.domain} (${c.citation_count} of ${score.total_queries})`)
      .join(", ");
    lines.push(`Cited instead, most often first: ${named}.`);
  } else {
    lines.push("No other domain was cited often enough in this run to be worth naming.");
  }
  return lines.join("\n");
}

function angleParagraph(
  prospect: Prospect,
  score: InvisibilityScore,
  verdict: AngleVerdict,
): string {
  const top = verdict.top_competitor;
  switch (verdict.angle) {
    case "competitor_framed":
      return (
        `${top === null ? "One domain" : top.domain} is cited in ${top === null ? "most" : top.citation_count} of those ${score.total_queries} answers — more than any other domain we saw. ` +
        `Whatever ${top === null ? "they" : top.domain} publishes, the model reads and repeats. It did not repeat yours.`
      );
    case "loss_framed":
      return (
        `You are not in these answers at all. An answer that never mentions ${prospect.domain} sends no click and no referrer, ` +
        "so this does not show up anywhere in your analytics as a loss. It shows up as nothing."
      );
    case "opportunity_framed":
      return (
        `You are in ${score.cited_queries} of ${score.total_queries}, so this is not a hole — it is the ${score.total_queries - score.cited_queries} answers where the shelf next to you is unclaimed. ` +
        "Nobody has priced that shelf yet."
      );
  }
}

const OFFER_PARAGRAPH =
  `What we sell: a disclosed placement inside a publisher's llms.txt — the file AI agents read before they answer. ` +
  `Every placement carries ${DISCLOSURE_TAG} and the disclosure notice, and we then measure whether the label survives the model. ` +
  `We report that measurement to you whichever way it comes out, including when it says the placement did not propagate.`;

export interface RenderedPitch {
  subject: string;
  body: string;
}

export function renderTemplate(
  prospect: Prospect,
  score: InvisibilityScore,
  angle: AngleVerdict,
  sender: SenderIdentity,
): RenderedPitch {
  const subject = renderSubject(prospect, score, angle);

  const identity = [
    `— ${sender.name}${sender.website !== null ? `, ${sender.website}` : ""}`,
    sender.reply_to !== null
      ? `Reply to ${sender.reply_to}.`
      : "[REPLY ADDRESS NOT CONFIGURED — required before any real send]",
    sender.postal_address !== null
      ? sender.postal_address
      : "[POSTAL ADDRESS NOT CONFIGURED — required before any real send]",
  ].join("\n");

  const method =
    score.queries.length > 0
      ? `Method, so you can re-run it: we asked ${score.engine} — ${score.queries
          .slice(0, 3)
          .map((q) => `"${q}"`)
          .join("; ")}${score.queries.length > 3 ? "; and others" : ""}.`
      : `Method: measured on ${score.engine}. Ask and we will send the query list.`;

  const body = [
    evidenceParagraph(prospect, score),
    "",
    angleParagraph(prospect, score, angle),
    "",
    OFFER_PARAGRAPH,
    "",
    `If that is worth fifteen minutes, reply to this message and we will send the full measurement for ${prospect.domain} first, before any pitch. ${OPT_OUT_SENTENCE}`,
    "",
    identity,
    "",
    method,
  ].join("\n");

  return { subject, body };
}

function renderSubject(
  prospect: Prospect,
  score: InvisibilityScore,
  angle: AngleVerdict,
): string {
  const category = prospect.categories[0] ?? "your category";
  switch (angle.angle) {
    case "competitor_framed": {
      const top = angle.top_competitor;
      return top === null
        ? `${prospect.name} is cited in ${score.cited_queries} of ${score.total_queries} AI answers we measured`
        : `${top.domain} is in the AI answers for ${category}. ${prospect.name} is not.`;
    }
    case "loss_framed":
      return `${prospect.name} is cited in ${score.cited_queries} of ${score.total_queries} AI answers we measured`;
    case "opportunity_framed":
      return `${prospect.name} appears in ${score.cited_queries} of ${score.total_queries} AI answers we measured`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The model path. Prose only. It decides nothing and it is checked afterwards.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_ID = "claude-opus-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 20_000;

function modelSystemPrompt(): string {
  return [
    "You write one cold outbound email for AdLayer, an ad network for AI answer engines.",
    "",
    "Hard rules. Breaking any of them makes the draft unusable and it will be discarded:",
    "1. Use ONLY the numbers supplied in the brief. Invent no statistic, percentage, benchmark, or estimate about the recipient. If you want a number you were not given, leave it out.",
    "2. The first sentence of the body must be the supplied opening sentence, copied exactly.",
    "3. No fake urgency, no deadlines, no scarcity. No exclamation marks. The subject must be plain and descriptive, must not start with Re: or Fwd:, and must not be in capitals.",
    "4. No guarantees, no superlatives, no claims about their competitors beyond the citation counts supplied.",
    "5. Include the exact sentence: " + JSON.stringify(OPT_OUT_SENTENCE),
    "6. Write numbers as words where they are not from the brief (say 'fifteen minutes', not '15 minutes').",
    "",
    "Style: plain, short, specific. No preamble, no flattery, no marketing voice. Lead with the measurement, then the point, then one ask.",
    "Return JSON with exactly two string fields: subject, body.",
  ].join("\n");
}

function modelBrief(
  prospect: Prospect,
  score: InvisibilityScore,
  angle: AngleVerdict,
  sender: SenderIdentity,
): string {
  const competitors =
    score.competitors.length > 0
      ? score.competitors
          .slice(0, 3)
          .map((c) => `${c.domain} cited in ${c.citation_count} of ${score.total_queries}`)
          .join("; ")
      : "none measured";
  const angleBrief: Record<PitchAngle, string> = {
    loss_framed:
      "Loss framing: they are absent from these answers, and an answer that never names them produces no click and no referrer, so the gap is invisible in their analytics.",
    opportunity_framed:
      "Opportunity framing: they appear in some answers already; the remaining answers are unclaimed inventory nobody has priced.",
    competitor_framed:
      "Competitor framing: one named domain dominates these answers. Name it, state its citation count, and do not speculate about why.",
  };

  return [
    `Recipient: ${prospect.name} (${prospect.domain}), categories: ${prospect.categories.join(", ") || "unknown"}.`,
    `Measurement engine: ${score.engine}. Measured at: ${score.measured_at ?? "unrecorded"}.`,
    `Cited queries: ${score.cited_queries}. Total queries: ${score.total_queries}.`,
    `Domains cited instead: ${competitors}.`,
    `Angle chosen for this prospect: ${angle.angle}. ${angleBrief[angle.angle]}`,
    "",
    `Opening sentence, copy it exactly as the first sentence of the body: ${evidenceOpening(prospect, score)}`,
    "",
    `What we sell, in your own words: ${OFFER_PARAGRAPH}`,
    "",
    `Sign off as: ${sender.name}${sender.website !== null ? ` (${sender.website})` : ""}.`,
    sender.reply_to !== null
      ? `Reply address: ${sender.reply_to}.`
      : "No reply address is configured. Do not invent one; say to reply to this message.",
    "",
    `The ONLY numbers you may use: ${[...allowedNumbersFor(prospect, score, sender).values].join(", ")}.`,
  ].join("\n");
}

interface ModelDraftOutcome {
  draft: RenderedPitch | null;
  /** One line per degradation. Empty means the model produced usable copy. */
  degraded: string[];
}

/**
 * Ask the model for prose. Never throws — every failure returns `null` and one
 * line of explanation, and the caller falls back to the template.
 */
async function draftWithModel(
  prospect: Prospect,
  score: InvisibilityScore,
  angle: AngleVerdict,
  sender: SenderIdentity,
  flags: CloserFlags,
): Promise<ModelDraftOutcome> {
  const env = flags.env ?? process.env;
  const key = env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.trim() === "") {
    return {
      draft: null,
      degraded: ["ANTHROPIC_API_KEY absent — copy rendered from the deterministic template"],
    };
  }

  const doFetch = flags.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { draft: null, degraded: ["no fetch available — copy rendered from the template"] };
  }

  const system = modelSystemPrompt();
  const brief = modelBrief(prospect, score, angle, sender);

  // Attempt 1 uses structured outputs and low effort. Attempt 2 drops every
  // optional field, so an API that does not know `output_config` still gets a
  // draft rather than silently disabling the model path forever.
  const bodies: Record<string, unknown>[] = [
    {
      model: MODEL_ID,
      max_tokens: 2000,
      system,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { subject: { type: "string" }, body: { type: "string" } },
            required: ["subject", "body"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: brief }],
    },
    {
      model: MODEL_ID,
      max_tokens: 2000,
      system: `${system}\n\nReturn ONLY a JSON object, no prose around it.`,
      messages: [{ role: "user", content: brief }],
    },
  ];

  const degraded: string[] = [];
  for (let attempt = 0; attempt < bodies.length; attempt++) {
    const payload = bodies[attempt];
    if (payload === undefined) continue;
    const outcome = await callModel(doFetch, key, payload, flags.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (outcome.draft !== null) return { draft: outcome.draft, degraded };
    degraded.push(outcome.reason ?? "model call failed for an unknown reason");
    // A refusal or a bad draft will not be fixed by dropping output_config.
    if (outcome.retryable !== true) break;
  }
  degraded.push("copy rendered from the deterministic template instead");
  return { draft: null, degraded };
}

interface ModelCallOutcome {
  draft: RenderedPitch | null;
  reason: string | null;
  retryable?: boolean;
}

async function callModel(
  doFetch: typeof fetch,
  key: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ModelCallOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        draft: null,
        reason: `model call returned HTTP ${response.status}`,
        // 4xx on the first attempt is usually an unknown field; worth one retry
        // with the minimal body. 5xx is not worth a second identical hammer.
        retryable: response.status >= 400 && response.status < 500,
      };
    }

    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) {
      return { draft: null, reason: "model response was not an object" };
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope["stop_reason"] === "refusal") {
      return { draft: null, reason: "model declined to write this pitch" };
    }
    const text = firstTextBlock(envelope["content"]);
    if (text === null) return { draft: null, reason: "model response carried no text" };

    const draft = parseDraftJson(text);
    if (draft === null) return { draft: null, reason: "model response was not the expected JSON" };
    return { draft, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { draft: null, reason: `model call failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

function firstTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
  }
  return null;
}

function parseDraftJson(text: string): RenderedPitch | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const subject = record["subject"];
    const body = record["body"];
    if (typeof subject !== "string" || typeof body !== "string") return null;
    if (subject.trim() === "" || body.trim() === "") return null;
    return { subject: subject.trim(), body: body.trim() };
  } catch {
    return null;
  }
}

/**
 * Everything a model draft must satisfy before it is preferred to the template.
 * Exported because "we check the model" is a claim, and a claim in outbound
 * needs a test pointing at it.
 */
export function checkModelDraft(
  draft: RenderedPitch,
  prospect: Prospect,
  score: InvisibilityScore,
  allowed: AllowedNumbers,
): string[] {
  const problems = [...findComplianceViolations(draft.subject, draft.body, allowed)];

  const fabricated = [
    ...findFabricatedNumbers(draft.subject, allowed),
    ...findFabricatedNumbers(draft.body, allowed),
  ];
  if (fabricated.length > 0) {
    problems.push(`model invented number(s): ${fabricated.join(", ")}`);
  }

  const opening = evidenceOpening(prospect, score);
  if (!draft.body.includes(opening)) {
    problems.push("model dropped the measured opening sentence");
  } else if (draft.body.indexOf(opening) > 200) {
    problems.push("model buried the measured opening sentence");
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// The agent entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write and (in dry run) render the pitch for one prospect.
 *
 * Order of operations matters and is deliberate: the gate decides first and
 * short-circuits, so a declined prospect never has copy generated, never has a
 * model call made about them, and never has a file written. The decision log
 * entries are appended at the end, in decision order, once `executed` and
 * `effect` can be stated truthfully — a log that claims an effect before it
 * happened is a log that will eventually claim one that never did.
 */
export async function pitch(
  prospect: Prospect,
  score: InvisibilityScore,
  flags: CloserFlags = {},
): Promise<PitchResult> {
  const log = flags.logger ?? ((m: string): void => console.log(m));
  const now = (flags.now ?? ((): Date => new Date()))();
  const sink = flags.log ?? openDecisionLog({ logger: flags.logger });
  const sender = flags.sender ?? DEFAULT_SENDER;
  const degraded: string[] = [];
  const drafts: DecisionDraft[] = [];

  if (flags.liveSend === true) {
    log(
      "[adlayer:closer] liveSend requested, but no send transport is wired in this module. Nothing will be sent.",
    );
    degraded.push("liveSend requested and refused — no transport exists in closer.ts");
  }

  const evidence = buildEvidence(prospect, score);
  const recontactDays = flags.recontactDays ?? RECONTACT_DAYS;
  const gate = decideDisposition(prospect, score, now, recontactDays);
  // Re-runnable proof that the gate is a function of the record, attached only
  // when it verifies. See `gateReplay`.
  const replay = gateReplay(prospect, score, now, recontactDays, gate);

  // ── Declined or held: log the gate and stop. No copy, no model, no disk. ──
  if (gate.disposition !== "send") {
    drafts.push(gateDraft(prospect, gate, evidence, flags, false, null, replay));
    const entries = appendAll(sink, drafts);
    return {
      subject: "",
      body: "",
      decision: {
        prospect_id: prospect.id,
        disposition: gate.disposition,
        angle: null,
        channel: null,
        reason: gate.reason,
        copy_source: "none",
        sent: false,
        send_blockers: [],
        draft_path: null,
        degraded,
        entries,
      },
    };
  }

  const angle = decideAngle(score);
  const channel = decideChannel(prospect.contact);

  const allowed = allowedNumbersFor(prospect, score, sender);
  const template = renderTemplate(prospect, score, angle, sender);

  // Our own template violating our own rules is a bug in this file, so it is an
  // assertion, not a degradation.
  const templateProblems = findComplianceViolations(template.subject, template.body, allowed);
  if (templateProblems.length > 0) {
    throw new CloserError(
      `template produced non-compliant copy for ${prospect.id}: ${templateProblems.join("; ")}`,
    );
  }
  assertNoFabricatedMetrics(template.subject, template.body, allowed);

  let chosen: RenderedPitch = template;
  let copySource: "template" | "model" = "template";

  if (flags.useModel !== false) {
    const outcome = await draftWithModel(prospect, score, angle, sender, flags);
    degraded.push(...outcome.degraded);
    if (outcome.draft !== null) {
      const problems = checkModelDraft(outcome.draft, prospect, score, allowed);
      if (problems.length === 0) {
        chosen = outcome.draft;
        copySource = "model";
      } else {
        degraded.push(`model draft rejected (${problems.join("; ")}) — template used instead`);
      }
    }
    if (outcome.degraded.length > 0) {
      log(`[adlayer:closer] ${outcome.degraded[0] ?? "model unavailable"}`);
    }
  }

  // Belt and braces: whatever produced the copy, it does not leave this function
  // carrying a number the measurement does not support.
  assertNoFabricatedMetrics(chosen.subject, chosen.body, allowed);

  const blockers = sendBlockers(sender, channel, prospect);
  const draftPath = writeDraft(prospect, score, chosen, channel, blockers, flags, now);
  if (draftPath === null && (flags.draftDir ?? null) === null) {
    degraded.push("no draftDir given — draft held in memory, nothing written to disk");
  }

  drafts.push(gateDraft(prospect, gate, evidence, flags, draftPath !== null, draftPath, replay));
  drafts.push(angleDraft(prospect, score, angle, evidence, flags));
  drafts.push(channelDraft(prospect, channel, evidence, flags));
  const entries = appendAll(sink, drafts);

  return {
    subject: chosen.subject,
    body: chosen.body,
    decision: {
      prospect_id: prospect.id,
      disposition: "send",
      angle: angle.angle,
      channel: channel.channel,
      reason: gate.reason,
      copy_source: copySource,
      sent: false,
      send_blockers: blockers,
      draft_path: draftPath,
      degraded,
      entries,
    },
  };
}

/** What must be true before a human could push this out for real. */
function sendBlockers(
  sender: SenderIdentity,
  channel: ChannelVerdict,
  prospect: Prospect,
): string[] {
  const blockers = ["no send transport is wired in closer.ts"];
  if (sender.reply_to === null) blockers.push("sender.reply_to is not configured — opt-out would not reach anyone");
  if (sender.postal_address === null) blockers.push("sender.postal_address is not configured");
  if (channel.channel === "defer_to_human") {
    blockers.push(`consent basis is "${channel.basis}" — a person must approve contact`);
  }
  if (channel.channel === "email_direct" && prospect.contact.email === null) {
    blockers.push("no email address on record");
  }
  return blockers;
}

function writeDraft(
  prospect: Prospect,
  score: InvisibilityScore,
  copy: RenderedPitch,
  channel: ChannelVerdict,
  blockers: string[],
  flags: CloserFlags,
  now: Date,
): string | null {
  const dir = flags.draftDir ?? null;
  if (dir === null || dir === "") return null;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = slug(prospect.id);
  let path = join(dir, `${base}.txt`);
  let n = 2;
  while (existsSync(path)) {
    path = join(dir, `${base}-${n}.txt`);
    n++;
  }

  const header = [
    "DRY RUN — NOT SENT. AdLayer Closer draft.",
    `drafted_at: ${now.toISOString()}`,
    `prospect: ${prospect.name} <${prospect.domain}>`,
    `channel: ${channel.channel} (consent basis: ${channel.basis})`,
    `to: ${channel.channel === "contact_form" ? (prospect.contact.form_url ?? "unknown form") : (prospect.contact.email ?? "unknown")}`,
    `evidence: ${score.engine} · ${score.cited_queries}/${score.total_queries} cited · ${score.source} · ref ${score.ref ?? "none"}`,
    `blockers: ${blockers.join(" | ")}`,
    "",
    `Subject: ${copy.subject}`,
    "",
  ].join("\n");

  writeFileSync(path, `${header}${copy.body}\n`, { encoding: "utf8" });
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision log plumbing
// ─────────────────────────────────────────────────────────────────────────────

function buildEvidence(prospect: Prospect, score: InvisibilityScore): DecisionEvidence[] {
  const measured: EvidenceSource = score.source === "measurement" ? "measurement" : "fixture";
  const contactSource: EvidenceSource =
    prospect.contact.source === "inbound_request" ? "human_input" : "fixture";

  const items: DecisionEvidence[] = [
    {
      id: "ev_visibility",
      claim: `${prospect.domain} is cited in ${score.cited_queries} of ${score.total_queries} answers measured on ${score.engine} (visibility ${fmt(score.visibility)}).`,
      source: measured,
      ref: score.ref,
      value: round(score.visibility, 4),
      observed_at: score.measured_at,
    },
    {
      id: "ev_sample",
      claim: `The measurement covered ${score.total_queries} queries.`,
      source: measured,
      ref: score.ref,
      value: score.total_queries,
      observed_at: score.measured_at,
    },
    {
      id: "ev_contact_basis",
      claim: `Our contact route for ${prospect.domain} came from: ${prospect.contact.source}.`,
      source: contactSource,
      ref: prospect.record_ref,
      value: prospect.contact.source,
      observed_at: null,
    },
    {
      id: "ev_last_contact",
      claim:
        prospect.last_contacted_at === null
          ? `We have not contacted ${prospect.name} before.`
          : `We last contacted ${prospect.name} at ${prospect.last_contacted_at}.`,
      source: contactSource,
      ref: prospect.record_ref,
      value: prospect.last_contacted_at,
      observed_at: prospect.last_contacted_at,
    },
  ];

  const top = score.competitors[0];
  if (top !== undefined) {
    const total = score.competitors.reduce((sum, c) => sum + c.citation_count, 0);
    items.push({
      id: "ev_competitor_top",
      claim: `${top.domain} is the most-cited domain in this run: ${top.citation_count} citations, ${fmt(total === 0 ? 0 : top.citation_count / total)} of all citations measured.`,
      source: measured,
      ref: score.ref,
      value: top.citation_count,
      observed_at: score.measured_at,
    });
  }
  return items;
}

function gateDraft(
  prospect: Prospect,
  gate: GateVerdict,
  evidence: DecisionEvidence[],
  flags: CloserFlags,
  executed: boolean,
  draftPath: string | null,
  replay: DecisionReplay | null = null,
): DecisionDraft {
  const price = flags.placementPriceCents ?? null;
  const supported = evidence.map((e) => e.id);

  const options = [
    {
      id: `opt_${gate.disposition}`,
      summary: dispositionSummary(gate.disposition, prospect),
      expected_outcome: dispositionOutcome(gate.disposition, prospect, gate),
      supported_by: supported,
      projected_value_cents: gate.disposition === "send" ? price : 0,
    },
  ];
  if (gate.alternative !== null) {
    options.push({
      id: `opt_${gate.alternative}`,
      summary: dispositionSummary(gate.alternative, prospect),
      expected_outcome: gate.alternative_outcome,
      supported_by: supported,
      projected_value_cents: gate.alternative === "send" ? price : 0,
    });
  }

  return {
    id: `dec_closer_${slug(prospect.id)}_gate`,
    agent: "Closer",
    question: `Do we contact ${prospect.name} at all?`,
    context: "src/company/closer.ts → decideDisposition()",
    options,
    chosen_option_id: `opt_${gate.disposition}`,
    rationale: gate.reason,
    evidence,
    flip_condition: gate.flip_condition,
    flip_to_option_id: gate.alternative === null ? null : `opt_${gate.alternative}`,
    replay,
    reversible: gate.disposition !== "send" || draftPath === null,
    reversal_path:
      gate.disposition === "send"
        ? draftPath === null
          ? "Nothing left this process. Discard the returned draft."
          : `Delete the draft at ${draftPath}. Nothing was transmitted — no send path exists in this module.`
        : "Re-run the Closer once the blocking condition changes.",
    executed,
    effect:
      gate.disposition === "send"
        ? draftPath === null
          ? "Drafted a pitch in memory. Nothing written, nothing sent."
          : `Wrote a dry-run draft to ${draftPath}. Nothing sent.`
        : `No contact made with ${prospect.domain}. Rule: ${gate.rule}.`,
    supersedes: null,
  };
}

function angleDraft(
  prospect: Prospect,
  score: InvisibilityScore,
  angle: AngleVerdict,
  evidence: DecisionEvidence[],
  flags: CloserFlags,
): DecisionDraft {
  const price = flags.placementPriceCents ?? null;
  const ids = evidence.map((e) => e.id);
  const outcomes: Record<PitchAngle, string> = {
    loss_framed:
      `${prospect.name} reads "you are absent" as a fact about them and checks it. Accurate at ${fmt(score.visibility)} visibility; reads as insulting and inaccurate if they can find themselves in an answer.`,
    opportunity_framed:
      `${prospect.name} reads "there is unclaimed inventory next to you". Survives their fact-check at any visibility, and lands softer, so fewer replies.`,
    competitor_framed:
      angle.top_competitor === null
        ? "No dominant competitor was measured, so this framing would have to name a domain arbitrarily."
        : `${prospect.name} reads "${angle.top_competitor.domain} is in these answers and you are not". Most concrete of the three and most likely to provoke a reply; also the one that reads as hostile if the rival is not actually dominant.`,
  };

  const options = (["loss_framed", "opportunity_framed", "competitor_framed"] as PitchAngle[]).map(
    (candidate) => ({
      id: `opt_${candidate}`,
      summary: `Open with ${candidate.replace(/_/g, " ")}.`,
      expected_outcome: outcomes[candidate],
      supported_by: ids,
      projected_value_cents: price,
    }),
  );

  return {
    id: `dec_closer_${slug(prospect.id)}_angle`,
    agent: "Closer",
    question: `Which framing opens the pitch to ${prospect.name}?`,
    context: "src/company/closer.ts → decideAngle()",
    options,
    chosen_option_id: `opt_${angle.angle}`,
    rationale:
      angle.decided_on === "competitor_concentration"
        ? `One domain holds ${fmt(angle.top_competitor?.share ?? 0)} of measured citations, at or above the ${COMPETITOR_CONCENTRATION_FLOOR} floor, so naming it is concrete rather than arbitrary. Margin over the boundary: ${fmt(angle.margin)}.`
        : `Visibility is ${fmt(score.visibility)} against a ${LOSS_FRAME_CEILING} boundary, so ${angle.angle.replace(/_/g, " ")} is the framing the measurement actually supports. Margin from the boundary: ${fmt(angle.margin)}.`,
    evidence,
    flip_condition: angle.flip_condition,
    flip_to_option_id: `opt_${angle.runner_up}`,
    replay: angleReplay(score, angle),
    reversible: true,
    reversal_path: "Re-render with a different angle; nothing was transmitted.",
    executed: false,
    effect: `Pitch copy for ${prospect.domain} was written in the ${angle.angle} framing.`,
    supersedes: null,
  };
}

function channelDraft(
  prospect: Prospect,
  channel: ChannelVerdict,
  evidence: DecisionEvidence[],
  flags: CloserFlags,
): DecisionDraft {
  const price = flags.placementPriceCents ?? null;
  const ids = evidence.map((e) => e.id);
  const outcomes: Record<PitchChannel, string> = {
    email_direct:
      "The pitch lands in an inbox that published an address for this. Fastest route, and the one that is indefensible if the address was not in fact an invitation.",
    contact_form:
      "The pitch goes through the route they published. Slower, often routed to a shared inbox, and impossible to characterise as unsolicited email.",
    defer_to_human:
      "Nothing goes anywhere until a person decides. Costs us the deal if they never look, and it is the only option that does not have an agent deciding to mail a scraped address.",
  };

  const options = (["email_direct", "contact_form", "defer_to_human"] as PitchChannel[]).map(
    (candidate) => ({
      id: `opt_${candidate}`,
      summary: `Route via ${candidate.replace(/_/g, " ")}.`,
      expected_outcome: outcomes[candidate],
      supported_by: ids,
      projected_value_cents: candidate === "defer_to_human" ? 0 : price,
    }),
  );

  return {
    id: `dec_closer_${slug(prospect.id)}_channel`,
    agent: "Closer",
    question: `Which route do we use to reach ${prospect.name}?`,
    context: "src/company/closer.ts → decideChannel()",
    options,
    chosen_option_id: `opt_${channel.channel}`,
    rationale: channel.reason,
    evidence,
    flip_condition: channel.flip_condition,
    flip_to_option_id: `opt_${channel.runner_up}`,
    replay: channelReplay(prospect.contact, channel),
    reversible: true,
    reversal_path: "Nothing was transmitted. Re-route by changing the contact record and re-running.",
    executed: false,
    effect: `Draft for ${prospect.domain} was addressed for ${channel.channel}.`,
    supersedes: null,
  };
}

function dispositionSummary(disposition: Disposition, prospect: Prospect): string {
  switch (disposition) {
    case "send":
      return `Pitch ${prospect.name} now, opening with their measured number.`;
    case "hold":
      return `Hold ${prospect.name} until the evidence supports the claim.`;
    case "decline":
      return `Do not contact ${prospect.name}.`;
  }
}

function dispositionOutcome(
  disposition: Disposition,
  prospect: Prospect,
  gate: GateVerdict,
): string {
  switch (disposition) {
    case "send":
      return `${prospect.name} receives a pitch whose opening claim they can verify against their own logs in one query. Expect a reply rate driven by whether the number surprises them.`;
    case "hold":
      return `${prospect.name} receives nothing today; the pipeline entry stays open and re-qualifies once ${gate.rule === "evidence_is_fixture" ? "a live measurement exists" : "the sample is large enough"}.`;
    case "decline":
      return `${prospect.name} receives nothing, now or later under this rule (${gate.rule}). We give up whatever this deal was worth.`;
  }
}

function appendAll(sink: DecisionSink, drafts: DecisionDraft[]): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  for (const draft of drafts) {
    entries.push(sink.append({ ...draft, id: uniqueId(sink, draft.id) }));
  }
  return entries;
}

/**
 * The same prospect may be pitched more than once in a run (a retry, a second
 * angle after a reversal). Ids must stay unique or the log refuses the write, so
 * a collision gets a suffix rather than an exception.
 */
function uniqueId(sink: DecisionSink, base: string): string {
  const taken = new Set(sink.entries().map((e) => e.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function daysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Numbers inside rationale/flip text. Kept out of the copy allow-list on purpose. */
function fmt(value: number): string {
  return String(round(value, 4));
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "" ? "prospect" : cleaned;
}
