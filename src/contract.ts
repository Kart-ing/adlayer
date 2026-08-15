/**
 * ADLAYER — the ad network for the answer layer.
 *
 * ONE contract. Both workstreams build against this from minute zero.
 * If your module emits this shape, it works. Do not change it without telling
 * the other person — this file is the coordination point, not a suggestion.
 *
 * Ported pattern from CITED (c0mpiled, 24 Jul 2026), which shipped because
 * fixture.json existed before any code did. Same play.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The disclosure spec. This is the ethical core AND the differentiator.
// Every served placement carries it. There is no code path that omits it.
// ─────────────────────────────────────────────────────────────────────────────

/** Literal marker written into every served block. Never make this optional. */
export const DISCLOSURE_TAG = "[SPONSORED]";

export const DISCLOSURE_NOTICE =
  "The following entry is a paid placement served by AdLayer. " +
  "It is advertising, not an editorial recommendation.";

// ─────────────────────────────────────────────────────────────────────────────
// Supply side — publishers who let us serve into their llms.txt
// ─────────────────────────────────────────────────────────────────────────────

export interface Publisher {
  id: string;
  domain: string;
  /** How the sponsored block reaches their llms.txt. */
  integration: "hosted" | "proxy" | "cited_generated";
  /** Categories this publisher's content sits in — drives targeting. */
  categories: string[];
  /** Publisher's cut of placement revenue, 0..1 */
  rev_share: number;
  verified_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Demand side — advertisers and their creative
// ─────────────────────────────────────────────────────────────────────────────

export interface Advertiser {
  id: string;
  name: string;
  url: string;
  /** Extracted by Pioneer GLiNER2 from their site. */
  categories: string[];
  stripe_customer_ref: string | null;
}

export type CreativeStatus =
  | "draft"
  | "pending_review"
  | "blocked"       // Compliance agent veto. Terminal until edited.
  | "approved"
  | "live"
  | "paused";

export interface Creative {
  id: string;
  advertiser_id: string;
  /** Anchor text shown in the llms.txt entry. */
  title: string;
  /** One line of body copy. Kept short — llms.txt is a terse format. */
  body: string;
  target_url: string;
  categories: string[];
  status: CreativeStatus;
  /** Populated by the Compliance agent. See ComplianceVerdict. */
  review: ComplianceVerdict | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compliance — Pioneer GLiGuard + structural disclosure enforcement.
// This agent can BLOCK. That veto is what makes the Band track real.
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceVerdict {
  passed: boolean;
  /** GLiGuard moderation categories that fired, if any. */
  flags: string[];
  /** Set false if the rendered block would lack the disclosure. Hard fail. */
  disclosure_present: boolean;
  /** Free-text reason surfaced in the Band room. */
  rationale: string;
  reviewed_at: string;
  /** Which model produced the verdict, for the writeup. */
  model: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serving — a placement is one creative, on one publisher, at one time
// ─────────────────────────────────────────────────────────────────────────────

export interface Placement {
  id: string;
  creative_id: string;
  publisher_id: string;
  /** ISO. The moment the block became live in the publisher's llms.txt. */
  served_at: string;
  /** Exact bytes we wrote, so measurement can string-match honestly. */
  rendered_block: string;
  price_cents: number;
  stripe_payment_ref: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement — the part nobody else can build.
// Reuses CITED's retrieve engine to ask answer engines whether the placement
// propagated, and CRUCIALLY whether the disclosure survived the model.
// ─────────────────────────────────────────────────────────────────────────────

export type PropagationState =
  /** Engine has not surfaced the advertiser for this query yet. */
  | "absent"
  /** Advertiser surfaced, and the sponsored label came with it. */
  | "surfaced_labeled"
  /** Advertiser surfaced, but the model dropped the disclosure. THE finding. */
  | "surfaced_unlabeled"
  /** Advertiser's domain was cited but copy did not come from our block. */
  | "cited_unattributed";

export interface PropagationCheck {
  placement_id: string;
  query: string;
  engine: string;
  checked_at: string;
  state: PropagationState;
  /** Raw answer text, kept for the demo and for honest reporting. */
  answer_excerpt: string;
  cited_urls: string[];
  /** Minutes from served_at to first non-absent observation. */
  latency_minutes: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terac — mandatory. Real humans judge disclosed sponsorship in AI answers.
// The before/after we ship at 18:45.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrustStudy {
  id: string;
  /** What we showed people. */
  variant: "labeled" | "unlabeled" | "labeled_prominent";
  question: string;
  n_responses: number;
  /** 0..1 — share who said they'd still trust the assistant. */
  trust_rate: number;
  /** 0..1 — share who correctly identified the result as an ad. */
  ad_recognition_rate: number;
  verbatims: string[];
  ran_at: string;
}

export interface TeracBeforeAfter {
  before: TrustStudy;
  after: TrustStudy;
  /** What we changed in the ad format because of round-one feedback. */
  change_made: string;
  trust_delta: number;
  recognition_delta: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The root object. `fixture.json` renders exactly this shape.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdLayerState {
  publishers: Publisher[];
  advertisers: Advertiser[];
  creatives: Creative[];
  placements: Placement[];
  propagation: PropagationCheck[];
  terac: TeracBeforeAfter | null;
  revenue: {
    total_cents: number;
    transaction_count: number;
    /** From the read-only rk_ key we gave organizers. */
    stripe_synced_at: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety posture, inherited from CITED. Every side effect is dry-run by default.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunFlags {
  /** Actually write to a publisher's live llms.txt. */
  liveServe: boolean;
  /** Actually hit answer engines (costs money, rate limited). */
  liveMeasure: boolean;
  /** Actually launch a paid Terac study. */
  liveStudy: boolean;
}

export const DRY_RUN: RunFlags = {
  liveServe: false,
  liveMeasure: false,
  liveStudy: false,
};

/**
 * Hard invariant. Call before any render reaches a publisher.
 * There is deliberately no flag that disables this.
 */
export function assertDisclosed(block: string): void {
  if (!block.includes(DISCLOSURE_TAG)) {
    throw new Error(
      `Refusing to serve: rendered block is missing ${DISCLOSURE_TAG}. ` +
        `Undisclosed placement is prompt injection, not advertising.`,
    );
  }
}
