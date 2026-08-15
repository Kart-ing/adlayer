/**
 * ADLAYER — the compliance veto.
 *
 * This is the Pioneer track and the Band track in one function. It is the only
 * thing standing between an advertiser's copy and a publisher's llms.txt, and
 * it is allowed to say no.
 *
 * Two independent gates, in priority order:
 *
 *   1. DISCLOSURE. The RENDERED block must carry [SPONSORED]. Checked by
 *      rendering the creative and string-matching the output — not by trusting
 *      that renderBlock did its job. This is a HARD fail. No moderation score,
 *      no configuration, and no flag overrides it. Disclosed paid placement is
 *      advertising; undisclosed content engineered to steer agents is prompt
 *      injection, and we do not build the second one.
 *
 *   2. MODERATION. Pioneer GLiGuard over title + body + target_url, plus
 *      structural checks that GLiGuard cannot see (copy that would break out of
 *      the block and separate itself from its own label).
 *
 * FAIL CLOSED. If Pioneer is unavailable — no key, timeout, 500, unreadable
 * response — the creative is NOT approved. "The moderation service was down" is
 * not a review. The verdict says so in plain words, and `verdictStatus()` routes
 * it to `pending_review` rather than `blocked`, because held-unreviewed and
 * refused-on-content are different facts and the room should see which is which.
 */

import {
  DISCLOSURE_NOTICE,
  DISCLOSURE_TAG,
  type ComplianceVerdict,
  type Creative,
  type CreativeStatus,
  type Publisher,
} from "../contract.ts";
import {
  CONTROL_RE,
  EXOTIC_LINE_BREAK_RE,
  normalizeForInspection,
  renderBlock,
} from "./render.ts";
import {
  DEFAULT_THRESHOLD,
  moderate as defaultModerate,
  type ModerationResult,
} from "./pioneer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Flag vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted when moderation could not be completed. Its presence means "we do not
 * know", never "it is clean". Kept as one exported constant so callers can tell
 * a held creative from a refused one without string-sniffing.
 */
export const MODERATION_UNAVAILABLE_FLAG = "moderation_unavailable";

/** Prefix for checks we perform ourselves, so the room can tell them from GLiGuard's. */
export const STRUCTURAL_PREFIX = "structure:";

export const STRUCTURAL_FLAGS = {
  /** A newline in copy escapes the list item and orphans the label. */
  lineBreak: `${STRUCTURAL_PREFIX}line_break_in_copy`,
  /** `<!--` / `-->` lets copy escape or forge the provenance comment. */
  commentBreakout: `${STRUCTURAL_PREFIX}html_comment_in_copy`,
  /** A markdown link in copy injects a second, unlabelled destination. */
  injectedLink: `${STRUCTURAL_PREFIX}markdown_link_in_copy`,
  /** Advertiser supplying the disclosure token themselves. We place it, not them. */
  spoofedDisclosure: `${STRUCTURAL_PREFIX}disclosure_token_in_copy`,
  /** A heading in copy would terminate the Sponsored section early. */
  headingBreakout: `${STRUCTURAL_PREFIX}heading_in_copy`,
  /** target_url must be a plain http(s) URL. */
  badTargetUrl: `${STRUCTURAL_PREFIX}invalid_target_url`,
  /** Copy must be present at all — an empty creative cannot be reviewed. */
  emptyCopy: `${STRUCTURAL_PREFIX}empty_copy`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export type ModerateFn = (text: string) => Promise<ModerationResult>;
export type RenderFn = (creative: Creative, publisher: Publisher) => string;

export interface ReviewOptions {
  /**
   * Publisher the block would be rendered for. Optional: review happens before
   * a placement exists, so a neutral review context is used by default.
   */
  publisher?: Publisher;
  /** Injected in tests. Defaults to Pioneer GLiGuard. */
  moderateFn?: ModerateFn;
  /** Injected in tests. Defaults to renderBlock from ./render.ts. */
  renderFn?: RenderFn;
  threshold?: number;
  /** Fixed timestamp, for deterministic fixtures. */
  now?: Date;
}

/**
 * The publisher used when a creative is reviewed before it is paired with one.
 * Deliberately inert: it exercises the renderer without naming a real property.
 */
export const REVIEW_CONTEXT_PUBLISHER: Publisher = {
  id: "pub_compliance_review",
  domain: "review.adlayer.internal",
  integration: "hosted",
  categories: [],
  rev_share: 0,
  verified_at: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Gate 1 — disclosure, verified against the rendered bytes
// ─────────────────────────────────────────────────────────────────────────────

export interface DisclosureCheck {
  /** Hard gate: the rendered block contains DISCLOSURE_TAG. */
  present: boolean;
  /** Advisory: the block also carries the long-form notice. */
  notice_present: boolean;
  /** Set when renderBlock refused or threw — itself a disclosure failure. */
  render_error: string | null;
  block: string | null;
}

export function checkDisclosure(
  creative: Creative,
  publisher: Publisher,
  renderFn: RenderFn,
): DisclosureCheck {
  let block: string;
  try {
    block = renderFn(creative, publisher);
  } catch (err) {
    // renderBlock calls assertDisclosed() on its own output. A throw here IS the
    // disclosure failing, and it is a refusal to serve, not a crash to swallow.
    return {
      present: false,
      notice_present: false,
      render_error: err instanceof Error ? err.message : String(err),
      block: null,
    };
  }

  return {
    present: block.includes(DISCLOSURE_TAG),
    notice_present: block.includes(DISCLOSURE_NOTICE),
    render_error: null,
    block,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate 2a — structural checks GLiGuard cannot see
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A classifier reads copy for harm. It does not read copy for "this string will
 * break out of the markdown list item and leave the [SPONSORED] tag attached to
 * nothing". That second failure is the one that turns our ad into the thing we
 * refuse to build, so we check it ourselves.
 */
export function checkStructure(creative: Creative | null | undefined): string[] {
  const flags = new Set<string>();

  // Coerce, never dereference. This function is a veto, and a veto that throws
  // on malformed input is a veto that takes the reviewer down instead of
  // recording a block. Non-string copy becomes "" and raises emptyCopy, which
  // is exactly the posture we want for a creative we cannot read.
  const rawTitle = typeof creative?.title === "string" ? creative.title : "";
  const rawBody = typeof creative?.body === "string" ? creative.body : "";
  const rawUrl = typeof creative?.target_url === "string" ? creative.target_url : "";

  // Inspect the codepoints the RENDERER will see, not the ones the advertiser
  // typed. When this check ran pre-NFKC and the renderer ran post-NFKC,
  // `［ＳＰＯＮＳＯＲＥＤ］` and `[SP\u200bONSORED]` walked straight past the
  // spoof veto and the verdict reported "clean" for a forged label.
  const title = normalizeForInspection(rawTitle);
  const body = normalizeForInspection(rawBody);
  const copy = `${title}\n${body}`;

  if (title.trim() === "" || body.trim() === "") {
    flags.add(STRUCTURAL_FLAGS.emptyCopy);
  }
  // JS `^`/`$` do not break on U+0085/U+2028/U+2029, but markdown renderers and
  // models do, so those are line breaks for our purposes too.
  const lineBreakRe = new RegExp(`[\\r\\n]|${EXOTIC_LINE_BREAK_RE.source}`);
  // Non-global copies: `.test()` on a /g regex is stateful. Tested per field,
  // never on `copy`, because the joiner we add is itself a newline.
  const controlRe = new RegExp(CONTROL_RE.source);
  if (
    lineBreakRe.test(title) ||
    lineBreakRe.test(body) ||
    controlRe.test(title) ||
    controlRe.test(body)
  ) {
    flags.add(STRUCTURAL_FLAGS.lineBreak);
  }
  if (copy.includes("<!--") || copy.includes("-->")) {
    flags.add(STRUCTURAL_FLAGS.commentBreakout);
  }
  if (/\]\(/.test(copy) || /https?:\/\//i.test(body)) {
    flags.add(STRUCTURAL_FLAGS.injectedLink);
  }
  // The disclosure token is ours to place, so the ADVERTISER never needs the
  // word at all — not the token, not a lookalike, not the bare word. Person B's
  // label classifier needs "sponsored" in an answer to mean AdLayer wrote it.
  if (copy.toUpperCase().includes(DISCLOSURE_TAG) || /\bsponsor\w*/i.test(copy)) {
    flags.add(STRUCTURAL_FLAGS.spoofedDisclosure);
  }
  // Split on every line-break form before testing, so an exotic separator
  // cannot hide a heading from a multiline `^`.
  const copyLines = copy.split(new RegExp(`\\r\\n|[\\r\\n]|${EXOTIC_LINE_BREAK_RE.source}`));
  if (copyLines.some((line) => /^\s*#{1,6}\s/.test(line))) {
    flags.add(STRUCTURAL_FLAGS.headingBreakout);
  }
  if (!isSafeTargetUrl(rawUrl)) {
    flags.add(STRUCTURAL_FLAGS.badTargetUrl);
  }

  return [...flags].sort();
}

function isSafeTargetUrl(raw: unknown): boolean {
  const s = typeof raw === "string" ? raw : "";
  if (s === "") return false;
  if (/[\s<>"'\\]/.test(s) || s.includes(")")) return false;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname !== "";
}

// ─────────────────────────────────────────────────────────────────────────────
// The veto
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly the text GLiGuard sees. Exported so the writeup can quote it. */
export function moderationInput(creative: Creative | null | undefined): string {
  const s = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  return [
    `Title: ${s(creative?.title)}`,
    `Body: ${s(creative?.body)}`,
    `Target URL: ${s(creative?.target_url)}`,
  ].join("\n");
}

/**
 * A caller may make review STRICTER, never looser.
 *
 * `Number(process.env.ADLAYER_THRESHOLD)` on an unset variable is NaN, and
 * `score >= NaN` is false for every hit — one config typo silently turned the
 * whole moderation veto off and the rationale still read "GLiGuard clean".
 * A threshold that is not a finite fraction is ignored with one warn line, and
 * a valid one is clamped so it can only tighten the gate.
 */
export function effectiveThreshold(
  supplied: number | undefined,
  warn: (message: string) => void = (m) => console.warn(m),
): number {
  if (supplied === undefined) return DEFAULT_THRESHOLD;
  if (!Number.isFinite(supplied) || supplied < 0 || supplied > 1) {
    warn(
      `[adlayer:compliance] ignoring threshold ${String(supplied)} — not a finite ` +
        `fraction in 0..1. Falling back to ${DEFAULT_THRESHOLD}. A bad threshold ` +
        `must never widen the gate.`,
    );
    return DEFAULT_THRESHOLD;
  }
  return Math.min(supplied, DEFAULT_THRESHOLD);
}

/** A moderation client may return anything. Only a well-formed result is usable. */
function isUsableModeration(v: unknown): v is ModerationResult {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["ran"] === "boolean" &&
    Array.isArray(r["flags"]) &&
    Array.isArray(r["hits"]) &&
    typeof r["model"] === "string"
  );
}

function degradedModeration(reason: string): ModerationResult {
  return {
    ran: false,
    degraded: true,
    degraded_reason: reason,
    model: "none (moderation client error)",
    flags: [],
    hits: [],
    latency_ms: null,
    raw: null,
  };
}

export async function reviewCreative(
  creative: Creative,
  options: ReviewOptions = {},
): Promise<ComplianceVerdict> {
  const publisher = options.publisher ?? REVIEW_CONTEXT_PUBLISHER;
  const renderFn = options.renderFn ?? renderBlock;
  const moderateFn = options.moderateFn ?? ((text: string) => defaultModerate(text));
  const threshold = effectiveThreshold(options.threshold);
  const reviewed_at = (options.now ?? new Date()).toISOString();

  // Gate 1 — disclosure. Runs first and independently: a moderation outage must
  // never stop us from checking the one thing we promise.
  const disclosure = checkDisclosure(creative, publisher, renderFn);

  // Gate 2a — structure.
  const structural = checkStructure(creative);

  // Gate 2b — GLiGuard. Never throws; degrades.
  let moderation: ModerationResult;
  try {
    const raw: unknown = await moderateFn(moderationInput(creative));
    // A client that RESOLVES to junk is as broken as one that throws — and the
    // old code only caught the throw, so `undefined.ran` took down the batch.
    moderation = isUsableModeration(raw)
      ? raw
      : degradedModeration("moderation client returned a malformed result");
  } catch (err) {
    // A client that throws is a broken client, not a clean creative.
    moderation = degradedModeration(
      `moderation client threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Flags are surfaced whether or not the pass was COMPLETE. A partial pass
  // cannot certify a creative clean, but a label that did fire is real
  // evidence and must not be dropped just because a sibling task went missing.
  const moderationFlags = moderation.flags.filter((f) =>
    aboveThresholdLabel(f, moderation, threshold),
  );

  const flags = [...new Set([...structural, ...moderationFlags])].sort();
  if (!moderation.ran) flags.push(MODERATION_UNAVAILABLE_FLAG);

  const passed = disclosure.present && flags.length === 0;

  return {
    passed,
    flags,
    disclosure_present: disclosure.present,
    rationale: buildRationale({
      passed,
      disclosure,
      structural,
      moderation,
      moderationFlags,
    }),
    reviewed_at,
    model: moderation.model,
  };
}

/**
 * moderation.flags is already threshold-filtered by pioneer.ts, but reviewers
 * may pass a stricter threshold here. Re-derive against the raw hits.
 */
function aboveThresholdLabel(flag: string, moderation: ModerationResult, threshold: number): boolean {
  const hit = moderation.hits.find(
    (h) => (h.task !== null ? `${h.task}:${h.label}` : h.label) === flag,
  );
  if (hit === undefined) return true;
  return hit.score === null || hit.score >= threshold;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rationale — this string is what a human reads in the Band room
// ─────────────────────────────────────────────────────────────────────────────

interface RationaleInput {
  passed: boolean;
  disclosure: DisclosureCheck;
  structural: string[];
  moderation: ModerationResult;
  moderationFlags: string[];
}

function buildRationale(input: RationaleInput): string {
  const { disclosure, structural, moderation, moderationFlags } = input;
  const parts: string[] = [];

  // Disclosure first, always. It is the hard gate and it leads the sentence.
  if (!disclosure.present) {
    parts.push(
      `BLOCKED — HARD FAIL: the rendered block does not carry ${DISCLOSURE_TAG}. ` +
        `Undisclosed paid placement is prompt injection, not advertising. ` +
        `No moderation score can override this.`,
    );
    if (disclosure.render_error !== null) {
      parts.push(`Renderer refused the block: ${disclosure.render_error}`);
    }
  } else {
    parts.push(`Disclosure verified: the rendered block carries ${DISCLOSURE_TAG}.`);
    if (!disclosure.notice_present) {
      parts.push(
        `Note: the long-form disclosure notice is not in this block — expected at ` +
          `the section level in llms.txt, not a block-level failure.`,
      );
    }
  }

  if (structural.length > 0) {
    parts.push(
      `BLOCKED — structural: ${structural.join(", ")}. ` +
        `Copy shaped this way can separate itself from its own label once rendered.`,
    );
  }

  if (moderationFlags.length > 0) {
    parts.push(`BLOCKED — GLiGuard flagged: ${moderationFlags.join(", ")}.`);
  }

  if (!moderation.ran) {
    parts.push(
      `HELD — FAILING CLOSED: moderation did not run (${
        moderation.degraded_reason ?? "reason unavailable"
      }). ` +
        `An unreviewed creative is never approved. This is not a judgement about ` +
        `the content; it is a refusal to guess. Restore Pioneer and re-review.`,
    );
  } else if (moderationFlags.length === 0) {
    parts.push(
      `GLiGuard clean across prompt_safety, jailbreak_detection and prompt_toxicity ` +
        `(${moderation.hits.length} classification${
          moderation.hits.length === 1 ? "" : "s"
        } read, model ${moderation.model}).`,
    );
  }

  if (input.passed) {
    parts.unshift("APPROVED.");
  }

  return parts.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing — held is not the same fact as blocked
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A verdict whose fields agree with each other. `ComplianceVerdict` is a plain
 * contract object with no provenance — anything that constructs one, hand-edits
 * fixture.json, or round-trips one through a dashboard can produce
 * `passed: true` alongside `disclosure_present: false` and a list of flags.
 * Trusting the boolean on its own made that a full veto bypass.
 */
export function isConsistentVerdict(verdict: ComplianceVerdict | null | undefined): boolean {
  if (verdict === null || verdict === undefined) return false;
  if (typeof verdict.passed !== "boolean") return false;
  if (typeof verdict.disclosure_present !== "boolean") return false;
  if (!Array.isArray(verdict.flags)) return false;
  if (!verdict.passed) return true; // a failing verdict cannot over-claim
  return verdict.disclosure_present && verdict.flags.length === 0;
}

/** True when the only thing wrong is that we could not review it. */
export function isHeldForReview(verdict: ComplianceVerdict): boolean {
  if (!isConsistentVerdict(verdict)) return false;
  if (verdict.passed) return false;
  if (!verdict.disclosure_present) return false;
  return (
    verdict.flags.length > 0 &&
    verdict.flags.every((f) => f === MODERATION_UNAVAILABLE_FLAG)
  );
}

/**
 * The status a creative takes from its verdict. DERIVED, not trusted: there is
 * deliberately no branch that returns "approved" for an unreviewed creative,
 * and none that returns it for a verdict whose own fields contradict `passed`.
 */
export function verdictStatus(verdict: ComplianceVerdict): CreativeStatus {
  if (!isConsistentVerdict(verdict)) return "blocked";
  if (verdict.passed) return "approved";
  if (isHeldForReview(verdict)) return "pending_review";
  return "blocked";
}

/** Apply a verdict to a creative without mutating the input. */
export function applyVerdict(creative: Creative, verdict: ComplianceVerdict): Creative {
  return { ...creative, status: verdictStatus(verdict), review: verdict };
}
