/**
 * Propagation classifier — the most important function in the project.
 *
 * Given an answer-engine response (raw text + the URLs it cited) and the exact
 * `Placement` we served, decide which of four things happened:
 *
 *   absent              → the advertiser is not present in this answer at all
 *   surfaced_labeled    → present, our copy propagated, AND the [SPONSORED]
 *                         disclosure survived the model
 *   surfaced_unlabeled  → present, our copy propagated, but the model dropped
 *                         the disclosure — THE HEADLINE FINDING
 *   cited_unattributed  → the advertiser is present, but the text did not come
 *                         from OUR disclosed block (organic mention, or the
 *                         domain cited without our copy)
 *
 * DESIGN STANCE — be ruthless about false positives (PRD-B §2.2).
 * An advertiser can surface for ordinary organic reasons. That is NOT
 * propagation. We only claim `surfaced_*` when the answer carries a distinctive
 * multi-word fingerprint copied from `placement.rendered_block` (the exact
 * bytes we wrote). A bare brand mention or a domain citation is not enough —
 * those land in `cited_unattributed`. This biases the classifier toward
 * UNDER-claiming propagation, which is the honest direction in front of a judge.
 *
 * A pre-serve baseline (the same query asked BEFORE we served) lets us subtract
 * organic presence: if the advertiser was already there with the same copy, a
 * later match is not evidence we caused anything.
 *
 * The classifier only imports from `src/contract.ts` (which imports nothing) so
 * that it — and its tests — run under the repo's `node --test
 * --experimental-strip-types` harness, which enforces Node ESM resolution.
 * `normalizeDomain` below intentionally mirrors `engine/retrieve/aggregate.ts`;
 * measurement code (run via tsx) can import the engine's copy directly.
 */

import type { Placement, PropagationState } from "../contract.ts";
import { DISCLOSURE_TAG, DISCLOSURE_NOTICE } from "../contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One pre-serve observation for the SAME query being classified, captured before
 * the first placement went live. The caller (measure.ts) looks this up by query
 * and passes it in. Optional — classification degrades gracefully without it,
 * but the false-positive guard is weaker.
 */
export interface BaselineObservation {
  /** Was the advertiser already present for this query before we served? */
  present: boolean;
  /** The pre-serve answer text, so we can tell "was already there" from "us". */
  answer_excerpt: string;
  cited_urls: string[];
}

export interface ClassificationEvidence {
  present: boolean;
  /** The advertiser's own domain appeared among the cited URLs. */
  domain_cited: boolean;
  /** The advertiser's brand/title was mentioned in the answer text. */
  brand_mentioned: boolean;
  /** A distinctive multi-word fingerprint from our block appeared in the answer. */
  copy_from_block: boolean;
  /** The [SPONSORED] tag or the disclosure notice survived into the answer. */
  disclosure_present: boolean;
  /** The advertiser was already present pre-serve for this query (organic). */
  organic_baseline: boolean;
  /** The block shingles we matched, kept for honest reporting. */
  matched_shingles: string[];
  /**
   * "strong" when the verdict rests on a multi-word copy fingerprint;
   * "weak" when it rests only on a brand token or a domain citation.
   */
  confidence: "strong" | "weak";
  notes: string[];
}

export interface Classification {
  state: PropagationState;
  evidence: ClassificationEvidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunables (documented so a judge can see exactly where the line is)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum shingle length (in words) that counts as a distinctive fingerprint of
 * our block. Four words is long enough that an accidental organic collision is
 * unlikely, short enough to survive light model paraphrasing of a one-line body.
 */
const SHINGLE_N = 4;
/** If the body is shorter than SHINGLE_N words, fall back to this. */
const MIN_SHINGLE_N = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Text normalization
// ─────────────────────────────────────────────────────────────────────────────

// Unicode bracket look-alikes that a model (or a hostile advertiser, per the
// red-team findings) might substitute for ASCII "[" / "]". We fold them to ASCII
// before looking for the disclosure tag so a counterfeit `［SPONSORED］` still
// registers as "the label text survived". LIMIT: this is deliberately lenient —
// it measures whether the WORD survived, not whether the exact bytes did. A
// stricter provenance check belongs on the serving side (assertDisclosed).
const OPEN_BRACKET_LOOKALIKES = /[［【〔⟦⁅⦋﹇]/g;
const CLOSE_BRACKET_LOOKALIKES = /[］】〕⟧⁆⦌﹈]/g;
// Zero-width characters used to smuggle look-alikes past a naive substring test.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** Lowercase, strip zero-width chars, collapse whitespace. */
function normalizeText(s: string): string {
  return s.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** As normalizeText, but also fold bracket look-alikes to ASCII for tag detection. */
function normalizeForTag(s: string): string {
  return normalizeText(
    s.replace(OPEN_BRACKET_LOOKALIKES, "[").replace(CLOSE_BRACKET_LOOKALIKES, "]"),
  );
}

/** Split into content words, dropping punctuation. */
function words(s: string): string[] {
  return normalizeText(s)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Mirrors engine/retrieve/aggregate.ts — lowercase, strip a www. prefix and trailing slashes. */
function normalizeDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
}

function domainOf(url: string): string | null {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return normalizeDomain(u.hostname);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance extraction from the exact rendered block
// ─────────────────────────────────────────────────────────────────────────────

interface BlockProvenance {
  /** Advertiser domain, from the block's target URL. */
  domain: string | null;
  /** Anchor / title text of the placement. */
  title: string;
  /** The persuasive body copy — the propagation fingerprint. */
  body: string;
}

/**
 * Pull provenance out of `placement.rendered_block`. We do NOT assume a rigid
 * format (Person A owns the renderer); we extract robustly:
 *   - the first markdown link `[title](url)`, else the first bare URL,
 *   - the body as everything left after stripping the disclosure tag, the
 *     disclosure notice, the markdown link, any URLs, and an `ad_id:` marker.
 */
function extractProvenance(renderedBlock: string): BlockProvenance {
  let title = "";
  let url: string | null = null;

  const mdLink = renderedBlock.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
  if (mdLink) {
    title = mdLink[1] ?? "";
    url = mdLink[2] ?? null;
  } else {
    const bare = renderedBlock.match(/https?:\/\/[^\s)\]}"'<>]+/);
    if (bare) url = bare[0];
  }

  let body = renderedBlock;
  // Remove the disclosure scaffolding so it never counts as advertiser "copy".
  body = body.replace(new RegExp(escapeRe(DISCLOSURE_TAG), "gi"), " ");
  body = body.split(DISCLOSURE_NOTICE).join(" ");
  // Remove the markdown link (keep neither title nor URL in the body fingerprint).
  body = body.replace(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, " ");
  // Remove any remaining bare URLs and an ad_id provenance marker.
  body = body.replace(/https?:\/\/[^\s)\]}"'<>]+/g, " ");
  body = body.replace(/ad_id\s*[:=]\s*\S+/gi, " ");
  // Drop list/blockquote punctuation.
  body = body.replace(/^[\s>*\-]+/gm, " ");

  return { domain: url ? domainOf(url) : null, title: title.trim(), body: body.trim() };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Build word-shingles of length n from text. */
function shingles(text: string, n: number): string[] {
  const w = words(text);
  if (w.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
}

/**
 * Distinctive shingles matched between the block body and an answer. Returns the
 * matched shingles (evidence). Empty = the copy did not demonstrably come from us.
 */
function matchBodyCopy(body: string, answer: string): string[] {
  const answerWords = words(answer).join(" ");
  const bodyWords = words(body);
  const n = bodyWords.length >= SHINGLE_N ? SHINGLE_N : MIN_SHINGLE_N;
  const candidates = shingles(body, n);
  const hits: string[] = [];
  for (const sh of candidates) {
    // Space-padded to match on word boundaries, not mid-word.
    if (` ${answerWords} `.includes(` ${sh} `)) hits.push(sh);
  }
  return hits;
}

/** Is the brand/title mentioned? Multi-word titles are stronger evidence. */
function brandMentioned(title: string, answer: string): boolean {
  const t = words(title);
  if (t.length === 0) return false;
  const a = ` ${words(answer).join(" ")} `;
  return a.includes(` ${t.join(" ")} `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Presence detection — shared by the classifier AND pre-serve baseline capture,
// so both answer "is the advertiser here?" the same way.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdvertiserIdentity {
  /** Normalized advertiser domain, or null if it could not be parsed. */
  domain: string | null;
  /** Brand / anchor text. */
  brand: string;
}

export interface PresenceEvidence {
  domain_cited: boolean;
  brand_mentioned: boolean;
  /** Present by domain citation OR brand mention (NOT copy provenance). */
  present: boolean;
}

/** Build an identity from an advertiser's target URL + title (e.g. a Creative). */
export function advertiserIdentity(targetUrl: string, brand: string): AdvertiserIdentity {
  return { domain: domainOf(targetUrl), brand };
}

/** Did the advertiser's domain get cited, or its brand get mentioned? */
export function mentionsAdvertiser(
  answerText: string,
  citedUrls: string[],
  adv: AdvertiserIdentity,
): PresenceEvidence {
  const citedDomains = new Set(
    citedUrls.map((u) => domainOf(u)).filter((d): d is string => d !== null),
  );
  const domain_cited = adv.domain !== null && citedDomains.has(adv.domain);
  const brand_mentioned = brandMentioned(adv.brand, answerText);
  return { domain_cited, brand_mentioned, present: domain_cited || brand_mentioned };
}

/** Did the [SPONSORED] tag or the disclosure notice survive into the answer? */
function disclosureSurvived(answer: string): boolean {
  const tagged = normalizeForTag(answer);
  if (tagged.includes(normalizeForTag(DISCLOSURE_TAG))) return true;
  // Also accept a distinctive phrase from the notice — the model may keep the
  // sentence while dropping the literal bracket tag. "paid placement" and
  // "not an editorial recommendation" are the two load-bearing phrases.
  const n = normalizeText(answer);
  return n.includes("paid placement") || n.includes("not an editorial recommendation");
}

// ─────────────────────────────────────────────────────────────────────────────
// The classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full classification with evidence. `classify()` wraps this and returns only the
 * state. Pass `baseline` (the pre-serve observation for the same query) to enable
 * the organic false-positive subtraction.
 */
export function classifyDetailed(
  answerText: string,
  citedUrls: string[],
  placement: Placement,
  baseline?: BaselineObservation,
): Classification {
  const { domain, title, body } = extractProvenance(placement.rendered_block);
  const notes: string[] = [];

  const { domain_cited: domainCited, brand_mentioned: brand } = mentionsAdvertiser(
    answerText,
    citedUrls,
    { domain, brand: title },
  );

  const matchedShingles = matchBodyCopy(body, answerText);
  let copyFromBlock = matchedShingles.length > 0;

  const present = domainCited || brand || copyFromBlock;
  const disclosurePresent = disclosureSurvived(answerText);
  const organicBaseline = baseline?.present === true;

  // Organic subtraction: if the advertiser was already present pre-serve AND the
  // "matched" copy already appeared in the baseline answer, then the match is not
  // evidence we caused anything — strip the copy-provenance claim.
  if (copyFromBlock && baseline && matchBodyCopy(body, baseline.answer_excerpt).length > 0) {
    copyFromBlock = false;
    notes.push(
      "copy fingerprint was already present in the pre-serve baseline — organic, not propagation",
    );
  }

  let state: PropagationState;
  let confidence: "strong" | "weak";

  if (!present) {
    state = "absent";
    confidence = "strong";
  } else if (copyFromBlock) {
    // Our disclosed block's copy demonstrably propagated. The only question left
    // is whether the disclosure came with it.
    state = disclosurePresent ? "surfaced_labeled" : "surfaced_unlabeled";
    confidence = "strong";
    if (organicBaseline) {
      notes.push(
        "advertiser was also present pre-serve; copy fingerprint still indicates our block propagated",
      );
    }
  } else {
    // Present, but we cannot prove the text came from our block. Honest bucket:
    // a domain citation or a bare brand mention is organic until proven otherwise.
    state = "cited_unattributed";
    confidence = domainCited ? "weak" : "weak";
    if (!domainCited && brand) {
      notes.push("brand mentioned without a domain citation or copy match — weak organic signal");
    }
    if (organicBaseline) notes.push("corroborated by pre-serve baseline presence");
  }

  return {
    state,
    evidence: {
      present,
      domain_cited: domainCited,
      brand_mentioned: brand,
      copy_from_block: copyFromBlock,
      disclosure_present: disclosurePresent,
      organic_baseline: organicBaseline,
      matched_shingles: matchedShingles,
      confidence,
      notes,
    },
  };
}

/**
 * Classify one answer-engine observation into a PropagationState.
 *
 * @param answerText Raw answer text from the engine.
 * @param citedUrls  URLs the engine cited.
 * @param placement  The exact placement we served (provenance source of truth).
 * @param baseline   Optional pre-serve observation for the same query.
 */
export function classify(
  answerText: string,
  citedUrls: string[],
  placement: Placement,
  baseline?: BaselineObservation,
): PropagationState {
  return classifyDetailed(answerText, citedUrls, placement, baseline).state;
}
