/**
 * ADLAYER — llms.txt renderer.
 *
 * This module is the disclosure chokepoint. Every byte AdLayer writes into a
 * publisher's llms.txt passes through here, and there is deliberately no code
 * path in this file that emits a block without DISCLOSURE_TAG.
 *
 * Threat model: **advertiser input is hostile.** A creative is attacker-supplied
 * text that we are about to paste into a file agents read. Untreated, it can:
 *   - break out of the markdown list item with a newline and start its own H2,
 *   - close our provenance comment early with `-->`,
 *   - forge a provenance comment and lie to Person B's string matcher,
 *   - plant its own `<!-- ADLAYER_SLOT -->` so the next render lands inside it,
 *   - forge or spoof `[SPONSORED]` (including with unicode lookalikes) so the
 *     disclosure assertion passes on a block whose real tag was stripped,
 *   - ship a *counter-label* ("NOT SPONSORED") inside a correctly disclosed
 *     block, which corrupts the measurement the whole project exists to make.
 *
 * Every one of those is closed here, structurally, not by blocklist:
 *   1. All creative text is NFKC-folded first, so lookalikes become ASCII and
 *      cannot slip past the neutraliser as "not really a bracket".
 *   2. Zero-width, bidi-override and control characters are removed.
 *   3. All whitespace collapses to single spaces — creative text is physically
 *      incapable of starting a new line, therefore incapable of starting a
 *      heading, a list item, or a comment at line start.
 *   4. The WHOLE Unicode open/close punctuation categories (\p{Ps}/\p{Pe}) fold
 *      to parentheses, not an ASCII shortlist. After this step no creative text
 *      can contain a markdown link, an HTML comment, or the literal
 *      `[SPONSORED]` — and no lenticular/white-square lookalike survives either.
 *   5. The word "sponsor…" is redacted from creative copy. The disclosure token
 *      is ours to place and never the advertiser's; letting an advertiser write
 *      "NOT SPONSORED" inside a sponsored block is how a disclosed placement
 *      becomes an undisclosed one in the model's summary.
 *   6. Provenance vocabulary (`ad_id=`, `served_at=`, `adlayer`) is redacted
 *      from copy and percent-escaped in destinations, so one advertiser cannot
 *      mint a provenance token naming another advertiser's ad.
 *   7. The provenance comment is built only from charset-restricted IDs and a
 *      normalised ISO timestamp, and is signed. No creative bytes ever enter a
 *      comment, and an unsigned comment is not a record.
 *
 * Format decision worth stating: the tag sits **inside the anchor text** as
 * well as in the notes. Research on the llms.txt spec (v2, 2026-08-10) shows a
 * strict parser is only required to keep `[name](url)`; notes are optional and
 * some extractors discard them. Putting the tag in the anchor text means the
 * disclosure survives naive link extraction — which is the entire experiment.
 *
 * Zero runtime dependencies. Node stdlib + globals only.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DISCLOSURE_NOTICE,
  DISCLOSURE_TAG,
  assertDisclosed,
} from "../contract.ts";
import type { Creative, Publisher } from "../contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Stable strings. Person B string-matches these. Do not churn them.
// ─────────────────────────────────────────────────────────────────────────────

/** Publisher-authored marker naming where sponsored content may be inserted. */
export const SLOT_MARKER = "<!-- ADLAYER_SLOT -->";

/** Opening fence of the AdLayer-owned region. Everything paid lives inside. */
export const SECTION_BEGIN = "<!-- ADLAYER_SECTION_BEGIN -->";

/** Closing fence of the AdLayer-owned region. */
export const SECTION_END = "<!-- ADLAYER_SECTION_END -->";

/** The one H2 sponsored content is ever allowed to live under. */
export const SECTION_HEADING = "## Sponsored";

/** Prefix of the per-placement provenance comment. Case-sensitive, on purpose. */
export const PROVENANCE_PREFIX = "<!-- adlayer:";

/**
 * How many literal DISCLOSURE_TAG occurrences renderBlock emits, by design:
 * one inside the anchor text, one leading the notes, one leading the notice.
 * Tests assert the exact count — if a hostile creative could smuggle in a
 * fourth, this number would move and the test would fail. That is the point.
 */
export const TAGS_PER_BLOCK = 3;

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 240;

/**
 * The only shape an id may take. Deliberately NOT a coercion: `sanitizeId`'s
 * many-to-one fold meant `ad@01H8X` and `ad_01H8X` produced the same provenance
 * record, which is an ad_id spoof. Ids are validated and refused, not repaired.
 */
export const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Thrown when a creative cannot be rendered safely. Refusing is the safe path. */
export class RenderRefusal extends Error {
  override readonly name = "RenderRefusal";
  constructor(message: string) {
    super(`Refusing to render: ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitisation
// ─────────────────────────────────────────────────────────────────────────────

/** Soft hyphen, zero-width chars, bidi controls, BOM. Invisible = dangerous. */
export const INVISIBLE_RE = new RegExp(
  "[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F" +
    "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164" +
    "\\uFE00-\\uFE0F\\uFEFF\\uFFA0]",
  "g",
);

/** C0 and C1 control characters, including every newline form. */
export const CONTROL_RE = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");

/** Line separators JS multiline ^/$ does NOT break on, but renderers and models do. */
export const EXOTIC_LINE_BREAK_RE = new RegExp("[\\u0085\\u2028\\u2029]", "g");

/**
 * The normalisation prelude, shared with compliance.ts.
 *
 * compliance and render MUST see the same codepoints. When compliance inspected
 * raw text while render inspected NFKC-folded text, `［ＳＰＯＮＳＯＲＥＤ］`
 * walked straight past the spoof veto. One definition, imported by both.
 */
export function normalizeForInspection(raw: unknown): string {
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (raw === null || raw === undefined) s = "";
  else s = String(raw);

  try {
    s = s.normalize("NFKC");
  } catch {
    // Lone surrogates can make normalize throw. Untreated text is worse than
    // unnormalised text, so fall through with the raw string and keep folding.
  }

  s = s.replace(INVISIBLE_RE, "");
  return s;
}

/**
 * Fold attacker-supplied text into something that cannot express structure.
 * Structure only — no vocabulary redaction. Used for strings we derive from
 * trusted-ish inputs (a validated publisher domain, a parsed URL hostname).
 *
 * Order matters. NFKC runs FIRST, deliberately: it turns `［ＳＰＯＮＳＯＲＥＤ］`
 * into `[SPONSORED]`, which the bracket fold on the next line then neutralises.
 * Folding brackets before normalising would let fullwidth lookalikes survive
 * into the output, where a model reading raw text would treat them as a tag we
 * never issued.
 */
export function foldStructure(raw: unknown, maxLen: number): string {
  let s = normalizeForInspection(raw);

  s = s.replace(CONTROL_RE, " ").replace(EXOTIC_LINE_BREAK_RE, " ");

  // Structure-bearing characters. Whole Unicode categories, not an ASCII list:
  // U+3010 【, U+27E6 ⟦ and U+2045 ⁅ all survive NFKC untouched, so an ASCII
  // shortlist let a creative ship `【NOT SPONSORED】` inside a disclosed block.
  s = s.replace(/\p{Ps}/gu, "(").replace(/\p{Pe}/gu, ")");
  // `<` and `>` are Sm/Po, not Ps/Pe, so they still need naming explicitly.
  s = s.replace(/[<]/g, "(").replace(/[>]/g, ")");

  // Backticks open code spans that can swallow following lines; backslashes
  // are markdown's escape machinery. Neither belongs in one line of ad copy.
  s = s.replace(/`/g, "'").replace(/\\/g, " ");

  // Newlines are already gone via CONTROL_RE; this collapses the rest.
  s = s.replace(/\s+/g, " ").trim();

  if (s.length > maxLen) s = s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
  return s;
}

/**
 * Everything `foldStructure` does, plus the vocabulary that only AdLayer is
 * allowed to write. Use this for every byte that came from an advertiser.
 */
export function sanitizeCreativeText(raw: unknown, maxLen: number): string {
  let s = foldStructure(raw, maxLen + 64);

  // Defence in depth. Folding the angle brackets already stops a creative from
  // forming a real marker, but a downstream tool that matches on the bare token
  // rather than the full comment would still be confused by a creative that
  // spells one out. Nothing legitimate in ad copy needs these words.
  s = s.replace(/ADLAYER_(?:SLOT|SECTION_BEGIN|SECTION_END)/gi, "redacted-marker");

  // Provenance vocabulary. Person B proves propagation by matching these
  // tokens; an advertiser who can emit them can manufacture a propagation
  // finding for an ad that never propagated — or for a rival's ad_id.
  s = s.replace(/(ad_id|served_at|serve|publisher|domain|sig)\s*=/gi, "$1-");
  s = s.replace(/adlayer/gi, "redacted-vendor");

  // The disclosure token is ours to place. An advertiser writing "NOT
  // SPONSORED" inside a block we labelled [SPONSORED] is telling the
  // summarising model the opposite of the truth, and it poisons the
  // surfaced_labeled / surfaced_unlabeled classification. Compliance blocks
  // this copy outright; this is the last line of defence if it ever gets here.
  s = s.replace(/\bsponsor\w*/gi, "redacted-term");

  if (s.length > maxLen) s = s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
  return s;
}

/**
 * Ids identify who gets paid and who gets credited with a propagation finding,
 * so they are validated, never coerced. `sanitizeId`'s old many-to-one fold
 * mapped `ad@01H8X`, `ad 01H8X` and `ad/01H8X` all onto `ad_01H8X`: any intake
 * path that let an advertiser choose their own id was an ad_id spoof.
 */
export function assertValidId(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw : "";
  if (!ID_RE.test(s)) {
    throw new RenderRefusal(
      `${field} must match ${ID_RE.source} — got ${JSON.stringify(
        String(raw ?? "").slice(0, 40),
      )}. An id we cannot attribute is an id we will not serve.`,
    );
  }
  return s;
}

/** True when an id is renderable. Cheap pre-check for callers that must not throw. */
export function isValidId(raw: unknown): boolean {
  return typeof raw === "string" && ID_RE.test(raw);
}

/**
 * Parse, validate and re-encode a target URL so it cannot break the markdown
 * destination. Throws rather than degrading — an unparseable destination is a
 * broken ad, and a broken ad must not ship.
 */
export function sanitizeTargetUrl(raw: unknown): string {
  const input = String(raw ?? "")
    .replace(CONTROL_RE, "")
    .replace(INVISIBLE_RE, "")
    .trim();
  if (input === "") throw new RenderRefusal("target_url is empty");

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new RenderRefusal(`target_url is not a URL: ${input.slice(0, 80)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new RenderRefusal(`target_url scheme ${u.protocol} is not http(s)`);
  }
  // Embedded credentials in an ad destination are never legitimate.
  u.username = "";
  u.password = "";

  // URL already percent-encodes whitespace, angle brackets and quotes.
  // Parentheses are what would close the markdown destination early.
  let out = u.toString().replace(/[()'`\\]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );

  // A query or fragment is a second, unfiltered channel for provenance tokens:
  // `https://attacker.example/#ad_id=ad_victim` renders a greppable forgery
  // inside the link an engine is most likely to reproduce. Percent-escape the
  // separator so the destination still resolves but the token is not a token.
  out = out.replace(/\b(ad_id|served_at|serve|publisher|domain|sig)=/gi, "$1%3D");

  return out;
}

/** Never throws. An unparseable timestamp degrades to now, not to a crash. */
export function normalizeIso(value?: string | null): string {
  if (value === undefined || value === null || value === "") {
    return new Date().toISOString();
  }
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return new Date().toISOString();
  return t.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — the greppable contract with Person B
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provenance comments used to be unauthenticated, which meant anyone who could
 * write to any file an engine reads — a publisher, a PR, a proxy integration,
 * or a base llms.txt we merge into — could mint a record claiming AdLayer had
 * served an arbitrary ad_id. A signature makes a record something only we can
 * write. Not a security boundary against a compromised server; a boundary
 * against a *measurement* being fabricated by anyone else.
 */
const DEV_SECRET = "adlayer-dev-secret-not-for-production";
let secretWarned = false;

function provenanceSecret(): string {
  const fromEnv = process.env["ADLAYER_SECRET"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  if (!secretWarned) {
    secretWarned = true;
    console.warn(
      "[adlayer:render] ADLAYER_SECRET unset — provenance signed with the public " +
        "development secret. Signatures verify locally but prove nothing in public.",
    );
  }
  return DEV_SECRET;
}

/** Test seam. Not used in the serving path. */
export function resetProvenanceWarning(): void {
  secretWarned = false;
}

export function provenanceSignature(p: {
  ad_id: string;
  served_at: string;
  publisher: string;
  domain: string;
}): string {
  return createHmac("sha256", provenanceSecret())
    .update(`${p.ad_id}|${p.served_at}|${p.publisher}|${p.domain}`)
    .digest("hex")
    .slice(0, 16);
}

export interface Provenance {
  ad_id: string;
  served_at: string;
  publisher: string;
  domain: string;
  /** Truncated HMAC over the four fields above. Empty when the record is unsigned. */
  sig: string;
  /** True only when `sig` verifies against ADLAYER_SECRET. Person B: count these only. */
  verified: boolean;
}

/**
 * Emits both `serve=` (the form in PRD-A §2.1) and `served_at=` (the form the
 * contract uses). Both carry the same ISO value. Twenty redundant bytes are
 * cheaper than a cross-workstream string match that silently misses.
 */
export function provenanceComment(p: {
  ad_id: string;
  served_at: string;
  publisher: string;
  domain: string;
}): string {
  return (
    `${PROVENANCE_PREFIX} ad_id=${p.ad_id} served_at=${p.served_at} ` +
    `serve=${p.served_at} publisher=${p.publisher} domain=${p.domain} ` +
    `sig=${provenanceSignature(p)} -->`
  );
}

const PROVENANCE_RE =
  /<!--\s*adlayer:\s*ad_id=(\S+)\s+served_at=(\S+)\s+serve=(\S+)\s+publisher=(\S+)\s+domain=(\S+?)(?:\s+sig=(\S+))?\s*-->/g;

/** Any AdLayer provenance comment, signed or not. Used to scrub foreign ones. */
const PROVENANCE_COMMENT_RE = /<!--\s*adlayer:[\s\S]*?-->/g;

function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Extract every AdLayer provenance record from rendered text.
 *
 * NOTE FOR MEASUREMENT (Person B): this is the ONLY sanctioned matcher.
 * Substring-matching `ad_id=` is unsound — advertiser copy and target URLs are
 * adversarial input and both have been used to forge that token. Count records
 * whose `verified` is true; treat the rest as noise.
 */
export function parseProvenance(text: string): Provenance[] {
  const out: Provenance[] = [];
  PROVENANCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROVENANCE_RE.exec(text)) !== null) {
    const record = {
      ad_id: m[1] ?? "",
      served_at: m[2] ?? "",
      publisher: m[4] ?? "",
      domain: m[5] ?? "",
    };
    const sig = m[6] ?? "";
    out.push({
      ...record,
      sig,
      verified: signaturesMatch(sig, provenanceSignature(record)),
    });
  }
  return out;
}

/** Records we actually wrote. The only ones a propagation finding may rest on. */
export function parseVerifiedProvenance(text: string): Provenance[] {
  return parseProvenance(text).filter((p) => p.verified);
}

// ─────────────────────────────────────────────────────────────────────────────
// renderBlock — one sponsored entry
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderBlockOptions {
  /** ISO timestamp to stamp. Defaults to now. Injectable so tests are stable. */
  servedAt?: string;
}

/**
 * Render exactly one sponsored entry.
 *
 * Shape (three lines, always, regardless of input):
 *
 *   - [[SPONSORED] Title](https://target): [SPONSORED] Body copy.
 *     [SPONSORED] <disclosure notice, verbatim from the contract>
 *     <!-- adlayer: ad_id=… served_at=… serve=… publisher=… domain=… sig=… -->
 *
 * Calls assertDisclosed() on its own output before returning. Throws
 * RenderRefusal on input it cannot render safely.
 */
export function renderBlock(
  creative: Creative,
  publisher: Publisher,
  options: RenderBlockOptions = {},
): string {
  const adId = assertValidId(creative?.id, "creative.id");
  const publisherId = assertValidId(publisher?.id, "publisher.id");
  const domain = assertValidId(publisher?.domain, "publisher.domain");

  const targetUrl = sanitizeTargetUrl(creative?.target_url);

  let title = sanitizeCreativeText(creative?.title, MAX_TITLE_CHARS);
  if (title === "") {
    // Falling back to the destination host keeps the anchor honest rather than
    // inventing a name for the advertiser. It is folded like every other
    // creative-derived string: an IPv6 host is literally `[::1]`, and raw
    // brackets in anchor text defeat naive link extraction, which is the one
    // thing the anchor-text placement of the tag exists to survive.
    try {
      title = foldStructure(new URL(targetUrl).hostname, MAX_TITLE_CHARS);
    } catch {
      title = "";
    }
    if (title === "") title = "Sponsored listing";
  }

  let body = sanitizeCreativeText(creative?.body, MAX_BODY_CHARS);
  if (body === "") body = "Paid placement.";

  const servedAt = normalizeIso(options.servedAt);
  const provenance = provenanceComment({
    ad_id: adId,
    served_at: servedAt,
    publisher: publisherId,
    domain,
  });

  const block =
    `- [${DISCLOSURE_TAG} ${title}](${targetUrl}): ${DISCLOSURE_TAG} ${body}\n` +
    `  ${DISCLOSURE_TAG} ${DISCLOSURE_NOTICE}\n` +
    `  ${provenance}`;

  assertBlockIntegrity(block);
  assertDisclosed(block); // The hard invariant, on our own output, last.
  return block;
}

/**
 * Belt-and-braces check that the sanitiser actually held. assertDisclosed only
 * proves a tag is *present*; this proves the tag count is exactly what we
 * emitted (so none was forged), that the block is one item on three lines (so
 * nothing broke out), that the notice survived, and that every provenance
 * token in the block belongs to the one comment we wrote.
 */
function assertBlockIntegrity(block: string): void {
  const lines = block.split("\n");
  if (lines.length !== 3) {
    throw new RenderRefusal(`block escaped its shape (${lines.length} lines)`);
  }
  if (countOccurrences(block, DISCLOSURE_TAG) !== TAGS_PER_BLOCK) {
    throw new RenderRefusal("disclosure tag count is not what we emitted");
  }
  if (!block.includes(DISCLOSURE_NOTICE)) {
    throw new RenderRefusal("disclosure notice missing");
  }
  if (countOccurrences(block, "<!--") !== 1) {
    throw new RenderRefusal("block contains an unexpected HTML comment");
  }
  if (block.includes(SLOT_MARKER) || block.includes(SECTION_END)) {
    throw new RenderRefusal("block contains an AdLayer structural marker");
  }

  // Provenance tokens are single-source by construction. If one appears twice,
  // some channel we did not think of (copy, title, URL query, URL fragment)
  // reached the output, and the block is a forgery vector regardless of which.
  const provenanceAt = block.indexOf(PROVENANCE_PREFIX);
  if (provenanceAt === -1) {
    throw new RenderRefusal("block lost its provenance comment");
  }
  for (const token of ["ad_id=", "served_at=", "serve=", "sig=", "adlayer:"]) {
    if (countOccurrences(block, token) !== 1) {
      throw new RenderRefusal(
        `provenance token ${JSON.stringify(token)} appears more than once — ` +
          `a creative reached a channel that can forge attribution`,
      );
    }
    if (block.indexOf(token) < provenanceAt) {
      throw new RenderRefusal(
        `provenance token ${JSON.stringify(token)} appears outside the provenance comment`,
      );
    }
  }
  if (parseProvenance(block).filter((p) => p.verified).length !== 1) {
    throw new RenderRefusal("block does not carry exactly one signed provenance record");
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// The serving gate — an ALLOWLIST, not a denylist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why this is an allowlist: the previous gate skipped `status === "blocked"`
 * and `review.passed === false`, which meant a creative that had never been
 * reviewed at all — `status: "pending_review", review: null`, exactly what an
 * intake form produces — rendered straight into a live publisher's file. The
 * veto never had to be removed; it only had to be skipped.
 *
 * Returns null when the creative may be served, or a human-readable reason.
 */
export function servabilityReason(
  creative: Creative | null | undefined,
  options: { allowUnmoderated?: boolean } = {},
): string | null {
  if (creative === null || creative === undefined) return "creative is missing";

  const review = creative.review;
  if (review === null || review === undefined) {
    return "no compliance verdict (never reviewed)";
  }
  if (review.disclosure_present !== true) {
    return "compliance verdict says the disclosure is absent";
  }

  const flags = Array.isArray(review.flags) ? review.flags : ["malformed verdict"];
  const onlyUnmoderated =
    flags.length > 0 && flags.every((f) => f === "moderation_unavailable");

  if (review.passed !== true) {
    // The single documented exception. A creative held *only* because Pioneer
    // was unreachable is a different fact from a creative refused on content,
    // and PRD-A §5 requires the 13:00 gate to be servable with compliance
    // degraded. It still requires an explicit opt-in from the caller, it is
    // logged, and it is recorded on the serve result — it is never the default.
    if (!(options.allowUnmoderated === true && onlyUnmoderated)) {
      return flags.length > 0
        ? `compliance verdict did not pass (${flags.join(", ")})`
        : "compliance verdict did not pass";
    }
  } else if (flags.length > 0) {
    // passed:true with flags is a self-inconsistent verdict. A ComplianceVerdict
    // is a plain contract object with no provenance: anything that round-trips
    // one through JSON can produce this. Corrupted must not mean servable.
    return `verdict is self-inconsistent: passed=true with flags ${flags.join(", ")}`;
  }

  if (creative.status === "blocked") return "status=blocked";
  const servableStatus =
    creative.status === "approved" ||
    creative.status === "live" ||
    (options.allowUnmoderated === true &&
      onlyUnmoderated &&
      creative.status === "pending_review");
  if (!servableStatus) return `status=${String(creative.status)}`;

  if (!isValidId(creative.id)) return "creative.id is not attributable";

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// renderLlmsTxt — merge the sponsored section into a publisher's file
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderLlmsTxtOptions {
  servedAt?: string;
  /** Called once per skipped creative. Defaults to console.warn. */
  onSkip?: (creativeId: string, reason: string) => void;
  /**
   * Permit creatives held ONLY because moderation was unreachable. Off by
   * default. Never permits an unreviewed creative or a flagged one.
   */
  allowUnmoderated?: boolean;
}

/**
 * Matches a previously-rendered AdLayer region, heading included.
 *
 * Line-anchored and non-nesting, both deliberately. The old
 * `/BEGIN[\s\S]*?END/g` matched a *prose mention* of the marker — which
 * `publishers/README.md` and our own docs contain — and spanned from there to
 * the real region's END, silently deleting every editorial link in between on
 * the second render. That destroys the control side of the experiment and,
 * with LIVE_SERVE=1, a real publisher's file.
 */
const SECTION_REGION_RE = new RegExp(
  "^[ \\t]*<!--[ \\t]*ADLAYER_SECTION_BEGIN[ \\t]*-->[ \\t]*$" +
    "(?:(?!^[ \\t]*<!--[ \\t]*ADLAYER_SECTION_BEGIN[ \\t]*-->[ \\t]*$)[\\s\\S])*?" +
    "^[ \\t]*<!--[ \\t]*ADLAYER_SECTION_END[ \\t]*-->[ \\t]*$",
  "gm",
);

const FENCE_BEGIN_LINE_RE = /^[ \t]*<!--[ \t]*ADLAYER_SECTION_BEGIN[ \t]*-->[ \t]*$/gm;
const FENCE_END_LINE_RE = /^[ \t]*<!--[ \t]*ADLAYER_SECTION_END[ \t]*-->[ \t]*$/gm;
const HEADING_LINE_RE = /^#{1,6}[ \t]+\S/;

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/**
 * Remove every AdLayer-owned region, absorbing the blank lines either side so
 * the removal leaves no hole. Publisher bytes outside the region are untouched.
 */
function stripAdLayerRegions(base: string): string {
  let out = "";
  let last = 0;
  SECTION_REGION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_REGION_RE.exec(base)) !== null) {
    let start = m.index;
    let end = start + m[0].length;
    if (end <= last) continue;
    while (start > last && /[ \t\n\r]/.test(base.charAt(start - 1))) start -= 1;
    while (end < base.length && /[ \t\n\r]/.test(base.charAt(end))) end += 1;
    const joiner = start <= 0 || end >= base.length ? "" : "\n\n";
    out += base.slice(last, start) + joiner;
    last = end;
  }
  out += base.slice(last);
  return out;
}

/**
 * Merge a `## Sponsored` section into an existing llms.txt.
 *
 * Insertion point is the publisher's `<!-- ADLAYER_SLOT -->` marker; if absent,
 * the section is appended and the marker is written alongside it so the next
 * render lands in the same place. Re-rendering replaces the previous AdLayer
 * region rather than stacking a second one, so this is idempotent.
 *
 * Sponsored entries are NEVER interleaved into editorial link lists. They only
 * ever appear between SECTION_BEGIN and SECTION_END, under their own H2 — and
 * an H2 structurally terminates any list it follows, so even a marker placed
 * mid-list by a publisher cannot produce a mixed list. When content follows the
 * slot, the heading that was in scope before the slot is re-opened after
 * SECTION_END, so an editorial link never inherits the `## Sponsored` scope.
 *
 * Everything outside the AdLayer region is left byte-for-byte alone.
 */
export function renderLlmsTxt(
  publisher: Publisher,
  creatives: Creative[],
  baseContent: string,
  options: RenderLlmsTxtOptions = {},
): string {
  const onSkip =
    options.onSkip ??
    ((id: string, reason: string) => {
      console.warn(`[adlayer:render] skipped creative ${id}: ${reason}`);
    });

  const servedAt = normalizeIso(options.servedAt);
  const list = Array.isArray(creatives) ? creatives : [];

  const blocks: string[] = [];
  for (const creative of list) {
    const id = isValidId(creative?.id) ? String(creative?.id) : "<invalid id>";
    const refusal = servabilityReason(creative, {
      allowUnmoderated: options.allowUnmoderated === true,
    });
    if (refusal !== null) {
      onSkip(id, refusal);
      continue;
    }
    try {
      blocks.push(renderBlock(creative, publisher, { servedAt }));
    } catch (err) {
      onSkip(id, err instanceof Error ? err.message : String(err));
    }
  }

  const raw = String(baseContent ?? "");

  // An llms.txt we cannot parse unambiguously is one we must not rewrite.
  const opens = countMatches(raw, FENCE_BEGIN_LINE_RE);
  const closes = countMatches(raw, FENCE_END_LINE_RE);
  if (opens !== closes) {
    throw new RenderRefusal(
      `base llms.txt has ${opens} ADLAYER_SECTION_BEGIN fence(s) and ${closes} ` +
        `ADLAYER_SECTION_END fence(s). Refusing to rewrite a file whose AdLayer ` +
        `region cannot be identified unambiguously — stripping it would delete ` +
        `publisher content.`,
    );
  }

  // Strip any AdLayer region we wrote previously, plus any provenance comment
  // sitting loose in the file. Provenance is unforgeable-by-signature but it is
  // still ours to write: the only records in the output are the ones we just
  // stamped this pass, so we can never publish a claim we did not make.
  let base = stripAdLayerRegions(raw);
  base = base.replace(PROVENANCE_COMMENT_RE, "");
  base = ensureHeading(base, publisher);

  if (blocks.length === 0) {
    // Nothing renderable. Emit no empty section; hand back a clean file.
    return base.trimEnd() + "\n";
  }

  let out: string;
  const slotAt = base.indexOf(SLOT_MARKER);
  if (slotAt !== -1) {
    const before = base.slice(0, slotAt).trimEnd();
    const after = base.slice(slotAt + SLOT_MARKER.length).trimStart();

    // llmstxt.org's model is H2-delimited: whatever sits after our SECTION_END
    // with no heading between belongs, to a heading-scoped parser, to
    // `## Sponsored`. That is the exact inverse of PRD-A §2.1, so we restore
    // the publisher's own heading scope before handing the file back.
    const enclosing = lastHeadingLine(before);
    const suppressOwnHeading = enclosing === SECTION_HEADING;
    let reopen = "";
    if (after !== "" && !HEADING_LINE_RE.test(after)) {
      if (enclosing === null || enclosing === SECTION_HEADING) {
        throw new RenderRefusal(
          `content follows ${SLOT_MARKER} with no heading to restore after the ` +
            `sponsored section. Inserting here would place editorial content ` +
            `under "${SECTION_HEADING}". Move the marker to the end of a section.`,
        );
      }
      reopen = enclosing + "\n\n";
    }

    const section = renderSponsoredSection(blocks, { includeHeading: !suppressOwnHeading });

    out =
      (before === "" ? "" : before + "\n\n") +
      SLOT_MARKER +
      "\n\n" +
      section +
      (after === "" ? "" : "\n\n" + reopen + after);
  } else {
    out =
      base.trimEnd() +
      "\n\n" +
      SLOT_MARKER +
      "\n\n" +
      renderSponsoredSection(blocks, { includeHeading: true });
  }

  out = out.trimEnd() + "\n";

  // Last gate before these bytes are anyone's problem.
  assertDisclosed(out);
  return out;
}

/** The last markdown heading line at or above a point in the document. */
function lastHeadingLine(before: string): string | null {
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (HEADING_LINE_RE.test(line)) return line.trimEnd();
  }
  return null;
}

export interface SponsoredSectionOptions {
  /**
   * False when the publisher's base file already carries `## Sponsored`
   * directly above the slot. Emitting a second identical H2 is not a disclosure
   * failure, but it is a malformed llms.txt.
   */
  includeHeading?: boolean;
}

/** The delimited, self-describing region. Nothing paid lives outside it. */
export function renderSponsoredSection(
  blocks: string[],
  options: SponsoredSectionOptions = {},
): string {
  const lines: string[] = [SECTION_BEGIN];
  if (options.includeHeading !== false) {
    lines.push(SECTION_HEADING, "");
  }
  lines.push(
    "<!-- AdLayer: every entry in this section is a paid placement, not an editorial recommendation. -->",
    `${DISCLOSURE_TAG} ${DISCLOSURE_NOTICE}`,
    "",
    blocks.join("\n"),
    "",
    SECTION_END,
  );
  return lines.join("\n");
}

/**
 * llmstxt.org: the H1 is "the only required section". If a publisher's file
 * lacks one, add it rather than shipping an invalid file.
 */
function ensureHeading(base: string, publisher: Publisher): string {
  if (/^#[ \t]+\S/m.test(base)) return base;
  const name = foldStructure(publisher?.domain, MAX_TITLE_CHARS);
  const heading = `# ${name === "" ? "llms.txt" : name}`;
  return base.trim() === "" ? heading + "\n" : heading + "\n\n" + base;
}
