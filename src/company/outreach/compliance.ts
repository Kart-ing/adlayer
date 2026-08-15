/**
 * ADLAYER — the OUTREACH COMPLIANCE GATE.
 *
 * This is a HARD GATE, in the same sense as `assertDisclosed()` in
 * `src/contract.ts`: it runs on every message, it can BLOCK, and blocking stops
 * the send. There is deliberately no flag that disables it and no "force"
 * parameter, because the population this guards against includes a future
 * version of us at 18:30 with a demo to land.
 *
 * ── WHAT IT REFUSES, AND WHY EACH ONE IS HERE ────────────────────────────────
 *
 * Five come straight from CAN-SPAM (see docs/OUTREACH.md §2 for the citations
 * and the enforcement table). Each separate non-compliant email carries a civil
 * penalty of up to $53,088, which is the whole argument for blocking rather
 * than warning:
 *
 *   no_sender_identity          #1  false or misleading header information
 *   deceptive_subject           #2  deceptive subject lines
 *   no_advertisement_disclosure #3  identify the message as an ad
 *   no_postal_address           #4  a valid physical postal address
 *   no_unsubscribe/no_reply_route #5 a working, easily understood opt-out
 *
 * One is the law's #6 with teeth: `suppressed`. Somebody already told us to stop.
 *
 * One is a security check rather than a legal one: `header_injection`. A CR or
 * LF inside a recipient address or a subject forges every header after it — an
 * attacker-controlled prospect record could add a Bcc. It is checked here and
 * again in `transport.ts`, because a single check in front of a network call is
 * one refactor away from none.
 *
 * And one is ours, not the law's, and it is the one that matters most to what
 * AdLayer is selling: `unmeasured_metric`. Our entire justification for cold
 * contact is that we measured the prospect and can hand them a number they did
 * not have. `findFabricatedNumbers()` extracts every numeric token from the
 * composed message and refuses any that is not derivable from the
 * `InvisibilityScore` we actually observed.
 *
 * **It is an allow-list, and it fails closed.** With no evidence supplied at
 * all, the allowed set is empty and every number in the body is a violation.
 * That is deliberate: the inconvenient direction is the safe one. Asserting a
 * measured fact about a stranger that we did not measure is not marketing, it
 * is a false statement of fact about a third party.
 *
 * ── KNOWN LIMIT, STATED RATHER THAN DISCOVERED ───────────────────────────────
 *
 * `deceptive_subject` is a BLOCKLIST and blocklists are incomplete by
 * construction. It catches what a language model reaches for unprompted, which
 * is the population it is aimed at. It does not catch a subject that is
 * deceptive in a way we did not enumerate, and neither this file nor any test
 * in this repo should be read as claiming otherwise.
 */

import {
  BANNED_CLAIMS,
  BANNED_URGENCY,
  OPT_OUT_SENTENCE,
  findFabricatedNumbers,
  maskLiterals,
  type AllowedNumbers,
} from "../closer.ts";
import { registerMechanism } from "../decision-log.ts";
import { checkSuppression, type SuppressionList } from "./suppression.ts";
import { hasUnsafeHeaderValue, type OutreachMessage } from "./transport.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The literal strings the gate string-matches for. Ours, not the model's — the
// same reason `DISCLOSURE_TAG` is a constant rather than a prompt instruction.
// ─────────────────────────────────────────────────────────────────────────────

/** CAN-SPAM #3. Must appear verbatim in every message we send. */
export const AD_DISCLOSURE_SENTENCE =
  "This is an advertisement. AdLayer sells disclosed sponsored entries in llms.txt.";

/** Prefix on the postal-address line, so a reader can find it without hunting. */
export const POSTAL_ADDRESS_LABEL = "AdLayer postal address:";

/** Prefix on the opt-out line. */
export const UNSUBSCRIBE_LABEL = "Unsubscribe:";

/** The header that makes one-click opt-out work in Gmail and Outlook. */
export const LIST_UNSUBSCRIBE_HEADER = "List-Unsubscribe";

/** A postal address shorter than this is not an address. */
export const MIN_POSTAL_ADDRESS_CHARS = 12;

export const VIOLATIONS = {
  suppressed: "suppressed",
  noPostalAddress: "no_postal_address",
  noUnsubscribe: "no_unsubscribe",
  noReplyRoute: "no_reply_route",
  noAdDisclosure: "no_advertisement_disclosure",
  noOptOutSentence: "no_opt_out_sentence",
  deceptiveSubject: "deceptive_subject",
  noSenderIdentity: "no_sender_identity",
  headerInjection: "header_injection",
  invalidRecipient: "invalid_recipient",
  unmeasuredMetric: "unmeasured_metric",
  emptyBody: "empty_body",
} as const;

export type ViolationCode = (typeof VIOLATIONS)[keyof typeof VIOLATIONS];

export interface OutreachViolation {
  code: ViolationCode;
  detail: string;
}

export interface GateVerdict {
  /** False means the send does not happen. There is no override. */
  allowed: boolean;
  violations: OutreachViolation[];
  /** Codes only, in a stable order. This is what the replay mechanism reads. */
  codes: ViolationCode[];
  checked_at: string;
}

export interface GateContext {
  /** From `OUTREACH_POSTAL_ADDRESS`. Null blocks. */
  postal_address: string | null;
  /** From `OUTREACH_UNSUBSCRIBE_URL`. Null blocks. */
  unsubscribe_url: string | null;
  /** From `OUTREACH_REPLY_TO`. Null blocks — the copy tells them to reply. */
  reply_to: string | null;
  /**
   * The loaded suppression list. Passing `null` is treated as "we did not
   * check", which is itself a block: a send that skipped the opt-out list is
   * exactly the send this gate exists to stop.
   */
  suppression: SuppressionList | null;
  /**
   * Numbers the evidence supports. `null` means no measurement was supplied,
   * and then every numeric token in the body is a violation. Fails closed.
   */
  allowed: AllowedNumbers | null;
  now?: Date;
}

/** Deliberately permissive on the local part, strict about what breaks parsing. */
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;".]+\.[^\s@<>,;".]{2,}$/;

/** `Name <addr@host>` or a bare address. Returns the address, or null. */
export function addressOf(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const angled = /<([^<>]+)>\s*$/.exec(trimmed);
  const candidate = (angled?.[1] ?? trimmed).trim();
  return ADDRESS.test(candidate) ? candidate : null;
}

/**
 * Run the gate.
 *
 * Never throws: it is handed messages assembled from prospect records that may
 * contain anything, and a gate that dies on hostile input is a gate that got
 * skipped. Every failure is a violation code.
 */
export function gateMessage(message: OutreachMessage, context: GateContext): GateVerdict {
  const now = context.now ?? new Date();
  const violations: OutreachViolation[] = [];
  const add = (code: ViolationCode, detail: string): void => {
    violations.push({ code, detail });
  };

  const body = typeof message.text === "string" ? message.text : "";
  const subject = typeof message.subject === "string" ? message.subject : "";

  // ── Structural: is this even a message? ───────────────────────────────────
  if (body.trim() === "") add(VIOLATIONS.emptyBody, "the message body is empty");

  const unsafe = hasUnsafeHeaderValue(message);
  if (unsafe !== null) {
    add(
      VIOLATIONS.headerInjection,
      `${unsafe} contains a carriage return or line feed — that forges every header after it`,
    );
  }

  if (addressOf(message.to) === null) {
    add(VIOLATIONS.invalidRecipient, `"${String(message.to)}" is not a parseable email address`);
  }
  if (addressOf(message.from) === null) {
    add(
      VIOLATIONS.noSenderIdentity,
      `"${String(message.from)}" is not an identifiable sender — CAN-SPAM requires accurate header information, and we do not invent one`,
    );
  }
  // The Closer's template renders "[POSTAL ADDRESS NOT CONFIGURED — required
  // before any real send]" when its sender identity is unset. That placeholder
  // is correct in a draft and indefensible in a message a stranger opens, so it
  // blocks rather than shipping.
  if (/NOT CONFIGURED/i.test(body)) {
    add(
      VIOLATIONS.noSenderIdentity,
      'the body still carries a "NOT CONFIGURED" placeholder from an unconfigured sender identity',
    );
  }

  // ── CAN-SPAM #6: did somebody already tell us to stop? ────────────────────
  if (context.suppression === null) {
    add(
      VIOLATIONS.suppressed,
      "the suppression list was not consulted — a send that skipped the opt-out list is refused",
    );
  } else {
    const check = checkSuppression(message.to, context.suppression);
    if (check.suppressed) add(VIOLATIONS.suppressed, check.reason);
  }

  // ── CAN-SPAM #4: a valid physical postal address ──────────────────────────
  const postal = (context.postal_address ?? "").trim();
  if (postal === "") {
    add(
      VIOLATIONS.noPostalAddress,
      "OUTREACH_POSTAL_ADDRESS is not configured — CAN-SPAM requires a valid physical postal address in every commercial message",
    );
  } else if (postal.length < MIN_POSTAL_ADDRESS_CHARS) {
    add(
      VIOLATIONS.noPostalAddress,
      `"${postal}" is too short to be a postal address (under ${MIN_POSTAL_ADDRESS_CHARS} characters)`,
    );
  } else if (!body.includes(postal)) {
    add(
      VIOLATIONS.noPostalAddress,
      "the configured postal address does not appear in the message body — a compliant address that the recipient never sees is not compliance",
    );
  }

  // ── CAN-SPAM #5: a working opt-out ────────────────────────────────────────
  const unsubUrl = (context.unsubscribe_url ?? "").trim();
  if (unsubUrl === "") {
    add(VIOLATIONS.noUnsubscribe, "OUTREACH_UNSUBSCRIBE_URL is not configured — there is no opt-out link to include");
  } else if (!/^https:\/\/[^\s<>"]+\.[^\s<>"]+/i.test(unsubUrl)) {
    add(VIOLATIONS.noUnsubscribe, `"${unsubUrl}" is not an https URL, so it is not a working opt-out link`);
  } else {
    if (!body.includes(unsubUrl)) {
      add(VIOLATIONS.noUnsubscribe, "the opt-out link does not appear in the message body");
    }
    const header = message.headers[LIST_UNSUBSCRIBE_HEADER];
    if (typeof header !== "string" || !header.includes(unsubUrl)) {
      add(
        VIOLATIONS.noUnsubscribe,
        `the ${LIST_UNSUBSCRIBE_HEADER} header is missing or does not carry the opt-out URL, so one-click unsubscribe would not work`,
      );
    }
  }

  const reply = addressOf(context.reply_to);
  if (reply === null) {
    add(
      VIOLATIONS.noReplyRoute,
      "OUTREACH_REPLY_TO is not configured or is not a valid address — the copy tells the recipient to reply to opt out, and that reply would reach nobody",
    );
  } else if (addressOf(message.reply_to) !== reply) {
    add(VIOLATIONS.noReplyRoute, "the message's Reply-To does not match the configured opt-out address");
  }

  if (!body.includes(OPT_OUT_SENTENCE)) {
    add(VIOLATIONS.noOptOutSentence, `the body is missing the reply-based opt-out sentence: ${JSON.stringify(OPT_OUT_SENTENCE)}`);
  }

  // ── CAN-SPAM #3: say that it is an ad ─────────────────────────────────────
  if (!body.includes(AD_DISCLOSURE_SENTENCE)) {
    add(
      VIOLATIONS.noAdDisclosure,
      "the body does not identify the message as an advertisement — the same rule we enforce on the placements we sell",
    );
  }

  // ── CAN-SPAM #2: an honest subject ────────────────────────────────────────
  for (const detail of subjectProblems(subject, context.allowed)) {
    add(VIOLATIONS.deceptiveSubject, detail);
  }
  for (const phrase of BANNED_URGENCY) {
    if (body.toLowerCase().includes(phrase)) {
      add(VIOLATIONS.deceptiveSubject, `the body invents urgency: "${phrase}"`);
    }
  }
  for (const phrase of BANNED_CLAIMS) {
    if (body.toLowerCase().includes(phrase)) {
      add(VIOLATIONS.deceptiveSubject, `the body makes an unsupported claim: "${phrase}"`);
    }
  }

  // ── Ours: no number we did not measure ────────────────────────────────────
  const allowed = withFooterLiterals(context.allowed, message, context, now);
  const fabricated = [
    ...findFabricatedNumbers(subject, allowed),
    ...findFabricatedNumbers(body, allowed),
  ];
  if (fabricated.length > 0) {
    add(
      VIOLATIONS.unmeasuredMetric,
      context.allowed === null
        ? `no measurement was supplied, so every number in this message is unverifiable: ${unique(fabricated).join(", ")}`
        : `the message asserts number(s) the measurement does not support: ${unique(fabricated).join(", ")}`,
    );
  }

  const codes = unique(violations.map((v) => v.code)).sort() as ViolationCode[];
  return {
    allowed: violations.length === 0,
    violations,
    codes,
    checked_at: now.toISOString(),
  };
}

function subjectProblems(subject: string, allowed: AllowedNumbers | null): string[] {
  const problems: string[] = [];
  const lower = subject.toLowerCase();
  if (subject.trim() === "") return ["the subject is empty"];
  if (/^\s*(re|fwd|fw)\s*:/i.test(subject)) problems.push("the subject fakes a reply or a forward");
  if (subject.includes("!")) problems.push("the subject uses an exclamation mark");
  const masked = maskLiterals(subject, allowed?.literals ?? []);
  const shouting = masked.match(/\b[A-Z]{4,}\b/g);
  if (shouting !== null) problems.push(`the subject shouts: ${unique(shouting).join(", ")}`);
  for (const phrase of BANNED_URGENCY) {
    if (lower.includes(phrase)) problems.push(`the subject invents urgency: "${phrase}"`);
  }
  for (const phrase of BANNED_CLAIMS) {
    if (lower.includes(phrase)) problems.push(`the subject makes an unsupported claim: "${phrase}"`);
  }
  return problems;
}

/**
 * The compliance footer contains digits that are not claims: a street number, a
 * ZIP, a year, an address with a `2` in the domain. Mask them, and mask nothing
 * else — every forgiveness added here is a hole a language model will find.
 */
function withFooterLiterals(
  allowed: AllowedNumbers | null,
  message: OutreachMessage,
  context: GateContext,
  now: Date,
): AllowedNumbers {
  const literals = [...(allowed?.literals ?? [])];
  const push = (value: string | null): void => {
    if (value !== null && value.trim() !== "") literals.push(value);
  };
  push(context.postal_address);
  push(context.unsubscribe_url);
  push(context.reply_to);
  push(message.from);
  push(message.to);
  push(message.reply_to);
  push(AD_DISCLOSURE_SENTENCE);
  push(String(now.getUTCFullYear()));
  for (const value of Object.values(message.headers)) push(value);
  return { values: allowed?.values ?? new Set<string>(), literals };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ─────────────────────────────────────────────────────────────────────────────
// MECHANISM REPLAY — the auditor re-runs the veto rather than reading about it.
//
// The gate's own decision is trivially simple: any violation blocks. That is the
// point, and stating it as a re-runnable function is how a reader checks that we
// did not quietly add an "unless it is 18:30" clause.
// ─────────────────────────────────────────────────────────────────────────────

export const COMPLIANCE_GATE_MECHANISM = "outreach.complianceGate";

export const OPT_COMPLIANCE_BLOCK = "opt_block";
export const OPT_COMPLIANCE_ALLOW = "opt_allow";

export interface ComplianceGateInput {
  violation_codes: string[];
}

/** JSON in, option id out. Total: bad input returns null rather than throwing. */
export function complianceGateMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const codes = (raw as ComplianceGateInput).violation_codes;
  if (!Array.isArray(codes)) return null;
  return codes.length > 0 ? OPT_COMPLIANCE_BLOCK : OPT_COMPLIANCE_ALLOW;
}

registerMechanism(COMPLIANCE_GATE_MECHANISM, complianceGateMechanism);
