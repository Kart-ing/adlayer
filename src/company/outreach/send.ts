/**
 * ADLAYER — `sendPitch()`. The thing that can actually be wrong.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERS ─────────────────────────────────────────
 *
 * An external audit: "AdLayer has an agent org that decides and a company that
 * does not yet execute… `sent` is a literal false and no transport exists, so it
 * has never been wrong in a way a prospect could settle." That was accurate.
 * This module closes it. `sent` is now computed from a receipt, and it can come
 * back true, and when it does a stranger has our email in their inbox and every
 * decision above it becomes falsifiable by a reply.
 *
 * ── THE ARMING RULE. NON-NEGOTIABLE. ─────────────────────────────────────────
 *
 * A real send requires BOTH:
 *
 *     flags.liveSend === true          AND          env.LIVE_SEND === "1"
 *
 * Two independent switches, one in code and one in the environment, because the
 * cheapest way to send a hundred emails by accident is a single boolean that a
 * caller defaults to true. There is no third path, no `force`, no
 * `skipCompliance`, and no environment variable that shortcuts the gate. If you
 * are reading this file looking for the convenience override: it is not here,
 * and it was left out on purpose.
 *
 * Order of operations is also the safety property:
 *
 *   1. The Closer's disposition gates everything. A prospect it declined or held
 *      is never composed, never checked, never sent.
 *   2. The message is composed WITH the compliance footer, then handed to the
 *      gate. The gate checks the bytes that would actually go out, not the
 *      intent behind them.
 *   3. `gateMessage()` can BLOCK. Blocking returns before the transport is ever
 *      constructed with a live key, so a blocked message cannot leak through a
 *      later refactor that forgets to check the verdict.
 *   4. Only then does the arming rule decide between the transport and a dry run.
 *
 * ── WHAT GETS LOGGED ─────────────────────────────────────────────────────────
 *
 * Every attempt writes a `DecisionEntry` (Closer: did we transmit?), and a
 * blocked attempt writes a second one under `Compliance`, because a veto that
 * only appears as a `false` in someone else's return value is a veto a reader
 * cannot audit. Both carry a `replay` pointer at the pure decider, so an auditor
 * re-runs the rule instead of reading our account of it.
 *
 * ── SAFETY POSTURE ───────────────────────────────────────────────────────────
 *
 *  · DRY RUN BY DEFAULT. With no flags at all this function makes zero network
 *    calls and writes zero files.
 *  · Missing config degrades to the file transport and logs once. It never
 *    throws — but missing config that would make the MESSAGE non-compliant
 *    (postal address, opt-out link, reply route) BLOCKS instead of degrading.
 *    Degrading on delivery is fine. Degrading on the law is not.
 *  · Never asserts a number about a prospect that we did not measure: with no
 *    `score` supplied, the metric allow-list is empty and any digit in the body
 *    blocks the send.
 *  · Zero runtime dependencies.
 */

import {
  OPT_OUT_SENTENCE,
  allowedNumbersFor,
  DEFAULT_SENDER,
  type AllowedNumbers,
  type CloserDecision,
  type InvisibilityScore,
  type Prospect,
  type SenderIdentity,
} from "../closer.ts";
import {
  openDecisionLog,
  registerMechanism,
  type DecisionDraft,
  type DecisionEntry,
  type DecisionEvidence,
  type DecisionOption,
  type DecisionReplay,
  type DecisionSink,
} from "../decision-log.ts";
import {
  AD_DISCLOSURE_SENTENCE,
  COMPLIANCE_GATE_MECHANISM,
  LIST_UNSUBSCRIBE_HEADER,
  OPT_COMPLIANCE_ALLOW,
  OPT_COMPLIANCE_BLOCK,
  POSTAL_ADDRESS_LABEL,
  UNSUBSCRIBE_LABEL,
  addressOf,
  complianceGateMechanism,
  gateMessage,
  type GateVerdict,
  type ViolationCode,
} from "./compliance.ts";
import { loadSuppressions, type SuppressionList } from "./suppression.ts";
import {
  resolveOutreachConfig,
  resolveTransport,
  type EnvLike,
  type OutreachConfig,
  type OutreachMessage,
  type SendReceipt,
  type Transport,
} from "./transport.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structurally satisfied by the Closer's `PitchResult`. Declared as a subset so
 * a test can build one without a full `DecisionEntry[]`, and so this module
 * never reaches for a Closer field it has no business reading.
 */
export interface SendablePitch {
  subject: string;
  body: string;
  decision: Pick<CloserDecision, "disposition" | "prospect_id">;
}

export interface SendRecipient {
  /** The address. Checked against the suppression list before anything else. */
  email: string;
  /**
   * The prospect record and the measured score. Supplying them is what lets the
   * metric guard build an allow-list; WITHOUT them every number in the body is
   * treated as unverified and the send is blocked. That is the intended
   * default, not an oversight.
   */
  prospect?: Prospect | null;
  score?: InvisibilityScore | null;
}

export interface SendFlags {
  /** Half of the arming rule. The other half is `LIVE_SEND=1`. */
  liveSend?: boolean;
  /** Injected in tests. Defaults to `process.env`. */
  env?: EnvLike;
  /** Injected in tests. Defaults to `resolveOutreachConfig(env)`. */
  config?: OutreachConfig;
  /** Injected in tests. Defaults to `resolveTransport()`. */
  transport?: Transport;
  /** Injected in tests. A dry run must never call this. */
  fetchImpl?: typeof fetch;
  log?: DecisionSink;
  logger?: (message: string) => void;
  now?: () => Date;
  /** Identity used to build the metric allow-list. Defaults to `DEFAULT_SENDER`. */
  sender?: SenderIdentity;
  outboxDir?: string;
  suppressionPath?: string;
  /** Pre-loaded suppression list, so a batch reads the file once. */
  suppression?: SuppressionList;
  /** Write the composed `.eml` to the outbox even in a dry run. Off by default. */
  writeDryRunFile?: boolean;
}

export type SendAction = "sent" | "dry_run" | "blocked";

export interface SendOutcome {
  action: SendAction;
  /**
   * TRUE only when an email service provider accepted the message for delivery.
   * A `.eml` on disk is not a send and does not set this.
   */
  sent: boolean;
  /** Both switches were on. Reported separately from `sent` so a failed live
   *  send is distinguishable from a run that was never armed. */
  armed: boolean;
  transport: string;
  receipt: SendReceipt | null;
  gate: GateVerdict;
  message: OutreachMessage | null;
  reason: string;
  /** One line per degradation. Empty means nothing degraded. */
  degraded: string[];
  /** The Closer entry, and the Compliance veto entry when one was written. */
  entries: DecisionEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE DECIDER, and the replay an auditor re-runs.
//
// Everything the send decision depends on is in `SendDecisionInput`, which is
// plain JSON. This is the only place the action is computed, so the logged entry
// and the re-run cannot diverge: they are the same call.
// ─────────────────────────────────────────────────────────────────────────────

export const OPT_SEND = "opt_send";
export const OPT_DRY_RUN = "opt_dry_run";
export const OPT_BLOCK = "opt_block";

export type SendRule =
  /** The Closer said hold or decline. Nothing downstream overrides that. */
  | "closer_declined"
  /** The compliance gate raised at least one violation. Terminal for this message. */
  | "compliance_blocked"
  /** Compliant, but one or both arming switches are off. */
  | "disarmed"
  /** Compliant and armed. This one leaves the process. */
  | "armed";

export interface SendDecisionInput {
  /** The Closer's disposition: "send" | "hold" | "decline". */
  disposition: string;
  /** True when the compliance gate raised nothing. */
  gate_allowed: boolean;
  /** Codes, for the record. `gate_allowed` is the field that decides. */
  violation_codes: string[];
  /** `flags.liveSend === true`. */
  flag_live_send: boolean;
  /** `env.LIVE_SEND === "1"`. */
  env_live_send: boolean;
}

export interface SendVerdict {
  action: SendAction;
  option_id: string;
  rule: SendRule;
  reason: string;
}

/**
 * The whole send decision, as arithmetic over booleans. No clock, no network,
 * no log, no environment read — the environment is resolved by the caller and
 * passed in, so this function is the same function on an auditor's machine.
 *
 * The ordering IS the policy, and it is the conservative one: the Closer's
 * refusal outranks compliance, compliance outranks arming, and arming requires
 * both switches. Every rule can only ever move the outcome toward "nothing
 * happened".
 */
export function decideSend(input: SendDecisionInput): SendVerdict {
  const disposition = typeof input?.disposition === "string" ? input.disposition : "";
  const codes = Array.isArray(input?.violation_codes) ? input.violation_codes : [];

  if (disposition !== "send") {
    return {
      action: "blocked",
      option_id: OPT_BLOCK,
      rule: "closer_declined",
      reason: `The Closer's disposition for this prospect is "${disposition || "unknown"}", not "send". Nothing downstream may overrule the gate that decided whether to contact them at all.`,
    };
  }
  if (input?.gate_allowed !== true) {
    return {
      action: "blocked",
      option_id: OPT_BLOCK,
      rule: "compliance_blocked",
      reason:
        codes.length > 0
          ? `The compliance gate raised ${codes.length} violation(s): ${codes.join(", ")}. A blocked message is not sent, and there is no flag that overrides this.`
          : "The compliance gate did not pass this message. A blocked message is not sent.",
    };
  }
  if (input?.flag_live_send !== true || input?.env_live_send !== true) {
    const missing: string[] = [];
    if (input?.flag_live_send !== true) missing.push("flags.liveSend");
    if (input?.env_live_send !== true) missing.push("LIVE_SEND=1");
    return {
      action: "dry_run",
      option_id: OPT_DRY_RUN,
      rule: "disarmed",
      reason: `The message is compliant and would have gone out, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. A real send requires both switches, and dry run is the default.`,
    };
  }
  return {
    action: "sent",
    option_id: OPT_SEND,
    rule: "armed",
    reason:
      "The Closer qualified this prospect, the compliance gate passed the exact bytes that go out, and both arming switches are on. This message leaves the process.",
  };
}

/** Registry key. The DecisionLog re-runs the send rule by this name. */
export const SEND_MECHANISM = "outreach.decideSend";

/** JSON in, option id out. Total: bad input returns null rather than throwing. */
export function sendMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const input = raw as SendDecisionInput;
  if (typeof input.disposition !== "string") return null;
  return decideSend(input).option_id;
}

registerMechanism(SEND_MECHANISM, sendMechanism);

/**
 * THE DERIVED FALSIFIER.
 *
 * For each rule we perturb exactly the input the flip sentence names, re-run,
 * and keep the FIRST perturbation that actually changes the option. What is
 * recorded is what the code returned, never what we hoped it would. When
 * nothing flips we record `null` and let our own auditor mark the entry down.
 */
export function findSendFlip(
  input: SendDecisionInput,
): { input: SendDecisionInput; option_id: string } | null {
  const chosen = decideSend(input).option_id;
  const candidates: SendDecisionInput[] = [
    { ...input, disposition: "send", gate_allowed: true, violation_codes: [], flag_live_send: true, env_live_send: true },
    { ...input, flag_live_send: false, env_live_send: false },
    { ...input, gate_allowed: false, violation_codes: ["no_postal_address"] },
    { ...input, disposition: "decline" },
  ];
  for (const candidate of candidates) {
    const out = decideSend(candidate).option_id;
    if (out !== chosen) return { input: candidate, option_id: out };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composing the message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The compliance footer. Every string it appends is one the gate then
 * string-matches for, so this function and `gateMessage()` cannot drift: if the
 * footer stops emitting the postal address, the gate blocks the next send.
 */
export function composeBody(pitchBody: string, config: OutreachConfig): string {
  const lines = [pitchBody.trimEnd(), "", "—", AD_DISCLOSURE_SENTENCE];
  if (config.unsubscribe_url !== null) {
    lines.push(`${UNSUBSCRIBE_LABEL} ${config.unsubscribe_url}`);
  }
  lines.push(OPT_OUT_SENTENCE);
  if (config.postal_address !== null) {
    lines.push(`${POSTAL_ADDRESS_LABEL} ${config.postal_address}`);
  }
  return `${lines.join("\n")}\n`;
}

export function composeMessage(
  pitch: SendablePitch,
  recipient: SendRecipient,
  config: OutreachConfig,
): OutreachMessage {
  const headers: Record<string, string> = {};
  if (config.unsubscribe_url !== null) {
    const mailto = config.reply_to === null ? "" : `, <mailto:${config.reply_to}?subject=unsubscribe>`;
    headers[LIST_UNSUBSCRIBE_HEADER] = `<${config.unsubscribe_url}>${mailto}`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  headers["X-AdLayer-Prospect"] = String(pitch.decision.prospect_id ?? "unknown").replace(/[\r\n\0]/g, " ");

  return {
    to: String(recipient.email ?? ""),
    from: config.from ?? "",
    reply_to: config.reply_to,
    subject: String(pitch.subject ?? ""),
    text: composeBody(String(pitch.body ?? ""), config),
    headers,
  };
}

/**
 * The numbers this message is allowed to contain.
 *
 * No prospect and no score means an EMPTY allow-list, which blocks any message
 * carrying a digit. Fails closed, on purpose: the justification for the contact
 * is that we measured them, and a caller who cannot produce the measurement has
 * not earned the send.
 */
function allowedFor(recipient: SendRecipient, sender: SenderIdentity): AllowedNumbers | null {
  const prospect = recipient.prospect ?? null;
  const score = recipient.score ?? null;
  if (prospect === null || score === null) return null;
  return allowedNumbersFor(prospect, score, sender);
}

// ─────────────────────────────────────────────────────────────────────────────
// The entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send one pitch. DRY RUN BY DEFAULT.
 *
 * Never throws on bad input, bad config, a hostile prospect record or a network
 * failure: every one of those is a verdict plus a logged decision, because the
 * caller has to be able to report truthfully what happened either way.
 */
export async function sendPitch(
  pitch: SendablePitch,
  recipient: SendRecipient,
  flags: SendFlags = {},
): Promise<SendOutcome> {
  const logger = flags.logger ?? ((m: string): void => console.log(m));
  const clock = flags.now ?? ((): Date => new Date());
  const now = clock();
  const env = flags.env ?? process.env;
  const config = flags.config ?? resolveOutreachConfig(env);
  const sink = flags.log ?? openDecisionLog({ logger: flags.logger });
  const sender = flags.sender ?? DEFAULT_SENDER;
  const degraded: string[] = [...config.degraded];

  const suppression =
    flags.suppression ??
    loadSuppressions({ path: flags.suppressionPath ?? config.suppression_path, logger: flags.logger });

  const message = composeMessage(pitch, recipient, config);
  const gate = gateMessage(message, {
    postal_address: config.postal_address,
    unsubscribe_url: config.unsubscribe_url,
    reply_to: config.reply_to,
    suppression,
    allowed: allowedFor(recipient, sender),
    now,
  });

  const envLive = String(env["LIVE_SEND"] ?? "").trim() === "1";
  const input: SendDecisionInput = {
    disposition: pitch.decision.disposition,
    gate_allowed: gate.allowed,
    violation_codes: [...gate.codes],
    flag_live_send: flags.liveSend === true,
    env_live_send: envLive,
  };
  const verdict = decideSend(input);

  // ── Execute. The transport is only reached on the armed path. ─────────────
  let receipt: SendReceipt | null = null;
  let transportName = "none";

  if (verdict.action === "sent") {
    const transport =
      flags.transport ??
      resolveTransport({
        config,
        fetchImpl: flags.fetchImpl,
        now: clock,
        logger: flags.logger,
        outboxDir: flags.outboxDir,
        note: "LIVE SEND",
      });
    transportName = transport.name;
    receipt = await transport.send(message);
    if (!receipt.ok) degraded.push(`transport ${transport.name} did not accept the message: ${receipt.detail}`);
    if (receipt.ok && !receipt.transmitted) {
      degraded.push(
        `armed, but the ${transport.name} transport does not deliver to recipients — the message reached ${receipt.path ?? "disk"} and nobody else`,
      );
    }
  } else if (verdict.action === "dry_run" && flags.writeDryRunFile === true) {
    const transport =
      flags.transport ??
      resolveTransport({
        config: { ...config, resend_api_key: null },
        now: clock,
        logger: flags.logger,
        outboxDir: flags.outboxDir,
        note: "DRY RUN — NOT SENT",
      });
    transportName = transport.name;
    receipt = await transport.send(message);
  }

  const sent = receipt !== null && receipt.ok && receipt.transmitted;
  const armed = input.flag_live_send && input.env_live_send;

  if (verdict.action === "blocked") {
    logger(`[adlayer:outreach] BLOCKED ${message.to}: ${verdict.reason}`);
  } else if (verdict.action === "dry_run") {
    logger(`[adlayer:outreach] dry run for ${message.to} — nothing transmitted. ${verdict.reason}`);
  }

  // ── Record. The Compliance veto gets its own entry, under its own agent. ──
  const entries: DecisionEntry[] = [];
  if (!gate.allowed) {
    entries.push(appendUnique(sink, complianceDraft(message, gate, pitch, now)));
  }
  entries.push(
    appendUnique(
      sink,
      sendDraft({
        message,
        pitch,
        gate,
        input,
        verdict,
        receipt,
        transportName,
        suppression,
        config,
        sent,
        now,
      }),
    ),
  );

  return {
    action: verdict.action,
    sent,
    armed,
    transport: transportName,
    receipt,
    gate,
    message,
    reason: verdict.reason,
    degraded,
    entries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision log plumbing
// ─────────────────────────────────────────────────────────────────────────────

interface SendDraftInput {
  message: OutreachMessage;
  pitch: SendablePitch;
  gate: GateVerdict;
  input: SendDecisionInput;
  verdict: SendVerdict;
  receipt: SendReceipt | null;
  transportName: string;
  suppression: SuppressionList;
  config: OutreachConfig;
  sent: boolean;
  now: Date;
}

function sendEvidence(d: SendDraftInput): DecisionEvidence[] {
  const at = d.now.toISOString();
  return [
    {
      id: "ev_gate",
      claim:
        d.gate.allowed
          ? "The compliance gate ran on the exact bytes that would be transmitted and raised no violation."
          : `The compliance gate raised ${d.gate.codes.length} violation(s) on the composed message: ${d.gate.codes.join(", ")}.`,
      source: "measurement",
      ref: "src/company/outreach/compliance.ts#gateMessage",
      value: d.gate.codes.length,
      observed_at: d.gate.checked_at,
    },
    {
      id: "ev_suppression",
      claim: d.suppression.detail,
      source: "measurement",
      ref: "src/company/outreach/suppression.ts#checkSuppression",
      value: d.suppression.suppressed.size,
      observed_at: at,
    },
    {
      id: "ev_arming",
      claim: `Arming switches at decision time: flags.liveSend=${d.input.flag_live_send}, LIVE_SEND=${d.input.env_live_send ? "1" : "unset"}. A real send needs both.`,
      source: "human_input",
      ref: "docs/OUTREACH.md#LIVE_SEND",
      value: d.input.flag_live_send && d.input.env_live_send,
      observed_at: at,
    },
    {
      id: "ev_transport",
      claim:
        d.receipt === null
          ? `No transport was invoked (${d.transportName}).`
          : `Transport ${d.receipt.transport}: ${d.receipt.detail}`,
      source: "measurement",
      ref: "src/company/outreach/transport.ts#resolveTransport",
      value: d.receipt?.provider_id ?? d.receipt?.path ?? null,
      observed_at: d.receipt?.attempted_at ?? at,
    },
    {
      id: "ev_disposition",
      claim: `The Closer's disposition for ${d.pitch.decision.prospect_id} is "${d.pitch.decision.disposition}".`,
      source: "measurement",
      ref: "src/company/closer.ts#decideDisposition",
      value: d.pitch.decision.disposition,
      observed_at: at,
    },
  ];
}

function sendDraft(d: SendDraftInput): DecisionDraft {
  const evidence = sendEvidence(d);
  const ids = evidence.map((e) => e.id);
  const to = d.message.to;

  const options: DecisionOption[] = [
    {
      id: OPT_SEND,
      summary: `Transmit the pitch to ${to} through ${d.transportName === "none" ? "the configured transport" : d.transportName}.`,
      expected_outcome:
        `${to} receives the message. Every claim in it becomes something a stranger can dispute in a reply, and the Closer's angle, channel and gate decisions become falsifiable rather than theoretical. ` +
        "The cost of being wrong is a complaint, a burned sending domain, and — if the message were non-compliant — a civil penalty of up to $53,088 for this one email.",
      supported_by: ids,
      projected_value_cents: 2000,
    },
    {
      id: OPT_DRY_RUN,
      summary: `Compose and check the message for ${to}, transmit nothing.`,
      expected_outcome:
        "Nothing reaches the recipient. We learn that the message is compliant and would have gone out, and we learn nothing at all about whether the pitch works, because no human ever reads it. This is the default and it is the option that can never generate revenue.",
      supported_by: ids,
      projected_value_cents: 0,
    },
    {
      id: OPT_BLOCK,
      summary: `Refuse to send to ${to}.`,
      expected_outcome:
        d.gate.allowed
          ? `No contact with ${to}, now or under this rule. We give up whatever the deal was worth, and the prospect never hears from an agent that was not authorised to speak to them.`
          : `No contact with ${to}. The specific violations (${d.gate.codes.join(", ")}) stay unfixed until a human fixes them, so this prospect stays unreachable until then. We give up the deal rather than send a message that breaks the rules we sell other people on following.`,
      supported_by: ids,
      projected_value_cents: 0,
    },
  ];

  const flip = findSendFlip(d.input);
  const replay: DecisionReplay = {
    fn: SEND_MECHANISM,
    input: d.input,
    flip_input: flip === null ? null : flip.input,
  };

  const flipSentence = ((): string => {
    switch (d.verdict.rule) {
      case "closer_declined":
        return `If the Closer's disposition had been "send" (it was "${d.input.disposition}") with the gate passing and both arming switches on, this would have transmitted.`;
      case "compliance_blocked":
        return `If the compliance gate had raised no violation (it raised: ${d.gate.codes.join(", ")}), this would have transmitted or dry-run depending on the arming switches. Clearing the violations is the only thing that moves it.`;
      case "disarmed":
        return `If flags.liveSend and LIVE_SEND=1 had both been set (they were ${d.input.flag_live_send} and ${d.input.env_live_send}), this exact message would have been transmitted to ${to}.`;
      case "armed":
        return `If either arming switch had been off, or the gate had raised any violation, this would not have left the process.`;
      default:
        return "";
    }
  })();

  const irreversible = d.sent;
  return {
    id: `dec_outreach_send_${slug(d.pitch.decision.prospect_id)}`,
    agent: "Closer",
    decided_at: d.now.toISOString(),
    question: `Do we transmit this pitch to ${to}?`,
    context:
      `src/company/outreach/send.ts → decideSend(). Rule: ${d.verdict.rule}. ` +
      `Transport: ${d.transportName}. Suppression list: ${d.suppression.path}. ` +
      `Config gaps (human-set, not evidence): ${d.config.degraded.length === 0 ? "none" : d.config.degraded.length}.`,
    options,
    chosen_option_id: d.verdict.option_id,
    rationale: d.verdict.reason,
    evidence,
    flip_condition: flipSentence,
    flip_to_option_id: flip === null ? null : flip.option_id,
    replay,
    reversible: !irreversible,
    reversal_path: irreversible
      ? `NOT REVERSIBLE. The message was accepted by ${d.receipt?.transport ?? "the transport"} (${d.receipt?.provider_id ?? "no id returned"}) and is in ${to}'s inbox. The only remedy is honouring an opt-out: call unsubscribe("${to}") in src/company/outreach/suppression.ts, which is checked before every subsequent send.`
      : `Nothing left this process. Re-run once the blocking condition changes${d.receipt?.path === undefined || d.receipt?.path === null ? "" : `, and delete ${d.receipt.path} if you do not want the draft on disk`}.`,
    // Executed means the world outside this log changed. A dry run and a block
    // both leave the prospect exactly where they were, and saying otherwise
    // would disarm the summary's "nothing in this log was executed" warning —
    // the one check most likely to catch us shipping a simulation.
    executed: d.sent,
    effect: d.sent
      ? `Transmitted to ${to} via ${d.receipt?.transport ?? "unknown"} (${d.receipt?.provider_id ?? "no id"}).`
      : d.verdict.action === "dry_run"
        ? `Nothing transmitted to ${to}. ${d.receipt?.path === undefined || d.receipt?.path === null ? "No file written." : `A dry-run copy was written to ${d.receipt.path}.`}`
        : `Refused to contact ${to}. Rule: ${d.verdict.rule}.`,
    supersedes: null,
  };
}

/**
 * The veto, logged under Compliance rather than folded into the Closer's entry.
 * A block that only appears as a `false` in someone else's return value is a
 * block a reader cannot audit, and the whole point of PRD §2's Compliance row is
 * that this agent can say no and the record shows it saying no.
 */
function complianceDraft(
  message: OutreachMessage,
  gate: GateVerdict,
  pitch: SendablePitch,
  now: Date,
): DecisionDraft {
  const evidence: DecisionEvidence[] = gate.violations.slice(0, 12).map((violation, i) => ({
    id: `ev_violation_${i}`,
    claim: `${violation.code}: ${violation.detail}`,
    source: "measurement",
    ref: "src/company/outreach/compliance.ts#gateMessage",
    value: violation.code,
    observed_at: gate.checked_at,
  }));
  if (evidence.length === 0) {
    evidence.push({
      id: "ev_violation_0",
      claim: "The gate blocked without naming a violation, which is itself a defect in this module.",
      source: "measurement",
      ref: "src/company/outreach/compliance.ts#gateMessage",
      value: null,
      observed_at: gate.checked_at,
    });
  }
  const ids = evidence.map((e) => e.id);
  const input: { violation_codes: ViolationCode[] } = { violation_codes: [...gate.codes] };

  const replay: DecisionReplay | null =
    complianceGateMechanism(input) === OPT_COMPLIANCE_BLOCK &&
    complianceGateMechanism({ violation_codes: [] }) === OPT_COMPLIANCE_ALLOW
      ? { fn: COMPLIANCE_GATE_MECHANISM, input, flip_input: { violation_codes: [] } }
      : null;

  return {
    id: `dec_compliance_outreach_${slug(pitch.decision.prospect_id)}`,
    agent: "Compliance",
    decided_at: now.toISOString(),
    question: `May this message be transmitted to ${message.to}?`,
    context: "src/company/outreach/compliance.ts → gateMessage(). A hard gate: there is no flag that overrides it.",
    options: [
      {
        id: OPT_COMPLIANCE_BLOCK,
        summary: `Block the message to ${message.to}.`,
        expected_outcome:
          `Nothing is transmitted. The prospect stays unreachable until a human fixes ${gate.codes.join(", ")}, and we forgo the deal. ` +
          "The failure this prevents is a message that breaks the disclosure and opt-out rules AdLayer sells other people on following.",
        supported_by: ids,
        projected_value_cents: 0,
      },
      {
        id: OPT_COMPLIANCE_ALLOW,
        summary: "Transmit it anyway and fix the message later.",
        expected_outcome:
          "The pitch reaches the prospect a day earlier. Each separate non-compliant commercial email carries a civil penalty of up to $53,088, the sending domain takes a complaint it cannot un-take, and the disclosure standard in our own pitch becomes a thing we say rather than a thing we do.",
        supported_by: ids,
        projected_value_cents: 2000,
      },
    ],
    chosen_option_id: OPT_COMPLIANCE_BLOCK,
    rationale:
      `${gate.violations.length} violation(s) on the composed message: ` +
      `${gate.violations.map((v) => `${v.code} (${v.detail})`).join("; ")}. ` +
      "Blocking is not advisory here — sendPitch() returns before the transport is constructed.",
    evidence,
    flip_condition: `If every violation had been cleared (${gate.codes.join(", ")}), this gate would have allowed the message and the send decision would have been made on the arming switches alone.`,
    flip_to_option_id: OPT_COMPLIANCE_ALLOW,
    replay,
    reversible: true,
    reversal_path: "Nothing was transmitted. Fix the named violations and re-run; the gate re-checks the new bytes.",
    // A veto that stops a send is a real effect on what the company did, even
    // though nothing left the process. It consumed the attempt.
    executed: true,
    effect: `Refused transmission to ${message.to}. Violations: ${gate.codes.join(", ")}.`,
    supersedes: null,
  };
}

function appendUnique(sink: DecisionSink, draft: DecisionDraft): DecisionEntry {
  const taken = new Set(sink.entries().map((e) => e.id));
  let id = draft.id;
  let n = 2;
  while (taken.has(id)) {
    id = `${draft.id}_${n}`;
    n++;
  }
  return sink.append({ ...draft, id });
}

function slug(value: string): string {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned === "" ? "prospect" : cleaned;
}

/** Re-exported so a caller never has to reach past this module for the check. */
export { addressOf };
