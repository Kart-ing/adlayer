/**
 * ADLAYER — outreach. The Closer's transport, and the gate in front of it.
 *
 * Read `docs/OUTREACH.md` before arming anything. The one-line summary: a real
 * send requires `flags.liveSend === true` AND `LIVE_SEND=1`, every message
 * carries a physical postal address and a working opt-out or the gate blocks it,
 * and nothing in this directory has ever transmitted a byte.
 *
 * Import order matters for one reason only: importing these modules is what
 * registers their mechanisms with the DecisionLog, so an auditor in this process
 * can re-run the send rule and the compliance veto rather than read about them.
 */

export {
  AD_DISCLOSURE_SENTENCE,
  COMPLIANCE_GATE_MECHANISM,
  LIST_UNSUBSCRIBE_HEADER,
  MIN_POSTAL_ADDRESS_CHARS,
  OPT_COMPLIANCE_ALLOW,
  OPT_COMPLIANCE_BLOCK,
  POSTAL_ADDRESS_LABEL,
  UNSUBSCRIBE_LABEL,
  VIOLATIONS,
  addressOf,
  complianceGateMechanism,
  gateMessage,
  type ComplianceGateInput,
  type GateContext,
  type GateVerdict,
  type OutreachViolation,
  type ViolationCode,
} from "./compliance.ts";

export { DEFAULT_SUPPRESSION_PATH } from "./transport.ts";

export {
  checkSuppression,
  domainKeyOf,
  isSuppressed,
  loadSuppressions,
  normalizeAddress,
  unsubscribe,
  type SuppressionAction,
  type SuppressionCheck,
  type SuppressionList,
  type SuppressionOptions,
  type SuppressionRecord,
} from "./suppression.ts";

export {
  DEFAULT_OUTBOX_DIR,
  HEADER_UNSAFE,
  RESEND_ENDPOINT,
  fileTransport,
  hasUnsafeHeaderValue,
  nullTransport,
  renderEml,
  resendTransport,
  resetTransportNoticesForTests,
  resolveOutreachConfig,
  resolveTransport,
  type EnvLike,
  type OutreachConfig,
  type OutreachMessage,
  type SendReceipt,
  type Transport,
  type TransportName,
  type TransportOptions,
} from "./transport.ts";

export {
  OPT_BLOCK,
  OPT_DRY_RUN,
  OPT_SEND,
  SEND_MECHANISM,
  composeBody,
  composeMessage,
  decideSend,
  findSendFlip,
  sendMechanism,
  sendPitch,
  type SendAction,
  type SendDecisionInput,
  type SendFlags,
  type SendOutcome,
  type SendRecipient,
  type SendRule,
  type SendVerdict,
  type SendablePitch,
} from "./send.ts";
