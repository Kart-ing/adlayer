/**
 * ADLAYER — the ad server entrypoint.
 *
 * One public function, `servePlacement(creativeId, publisherId, flags)`, and a
 * CLI wrapper around it. It is the only thing in this codebase that turns a
 * creative into bytes on a publisher's disk.
 *
 * The order of operations is the product:
 *
 *   1. Resolve the publisher from the registry, and its llms.txt from disk.
 *   2. Run the compliance veto — GLiGuard + structural checks — and REFUSE if
 *      the verdict did not pass. Not "warn". Not "flag for later". Refuse.
 *   3. Render the block, which enforces the disclosure itself.
 *   4. Merge the block into the publisher's file, which enforces it again.
 *   5. `assertDisclosed()` on the exact `rendered_block` we are about to hand
 *      back, as a LAST-LINE check independent of the renderer's own — the
 *      renderer proving its own output is fine is not the same as the serving
 *      boundary proving it.
 *   6. Write, but only when `flags.liveServe` is true. Everything else is a
 *      dry run: it computes every byte, hands them back, and touches nothing.
 *
 * Zero runtime dependencies. Node stdlib + global fetch.
 */

import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  DRY_RUN,
  assertDisclosed,
  type ComplianceVerdict,
  type Creative,
  type Placement,
  type Publisher,
  type RunFlags,
} from "../contract.ts";

import {
  applyVerdict,
  reviewCreative,
  verdictStatus,
  type ReviewOptions,
} from "./compliance.ts";
import {
  RenderRefusal,
  parseVerifiedProvenance,
  renderBlock,
  renderLlmsTxt,
  servabilityReason,
} from "./render.ts";
import {
  DEFAULT_REGISTRY_PATH,
  findById,
  loadRegistry,
  publisherLlmsTxtPath,
} from "./registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-root `creatives.json`. Person B's intake writes it; we only read it. */
export const DEFAULT_CREATIVES_PATH: string = fileURLToPath(
  new URL("../../creatives.json", import.meta.url),
);

/** Default price for a placement, in cents. $20 — we need a transaction, not margin. */
export const DEFAULT_PRICE_CENTS = 2000;

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

/** RunFlags from the environment. Every one of them defaults to OFF. */
export function flagsFromEnv(): RunFlags {
  return {
    liveServe: envFlag("LIVE_SERVE"),
    liveMeasure: envFlag("LIVE_MEASURE"),
    liveStudy: envFlag("LIVE_STUDY"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────────

export type ServeOutcome =
  /** Bytes computed and written to the publisher's llms.txt. */
  | "served"
  /** Bytes computed, nothing written. The default. */
  | "dry_run"
  /** Compliance said no, or the renderer refused, or inputs did not resolve. */
  | "refused";

export interface ServeResult {
  outcome: ServeOutcome;
  /** True when nothing was written, whatever the reason. */
  dryRun: boolean;
  /** Null on refusal. Never a partially-filled placement. */
  placement: Placement | null;
  /** The verdict this serve was gated on. Null only when review never ran. */
  verdict: ComplianceVerdict | null;
  /** The creative with the verdict applied — status included. Null on refusal. */
  creative: Creative | null;
  publisher: Publisher | null;
  /** Human-readable. On refusal, why. On success, what was done. */
  reason: string;
  /** The full file we would write (or wrote). Null on refusal. */
  llmsTxt: string | null;
  llmsTxtPath: string | null;
  /** True when this serve used the explicit unmoderated-hold override. */
  unmoderatedOverride: boolean;
}

export interface ServeOptions {
  /** Creatives to choose from. Defaults to `creatives.json`, else empty. */
  creatives?: Creative[];
  /** Publishers to choose from. Defaults to the registry on disk. */
  publishers?: Publisher[];
  registryPath?: string;
  creativesPath?: string;
  /** Override the publisher's llms.txt location (tests). */
  llmsTxtPath?: string;
  /** Base llms.txt content, if you already have it. Skips the disk read. */
  baseContent?: string;
  /** Fixed timestamp so fixtures are deterministic. */
  servedAt?: string;
  priceCents?: number;
  /**
   * A pricing decision from the Pricing agent, enforced here.
   *
   * This exists because a skeptical review found the agent org "decides" while
   * the company "does not execute": Pricing produced 142 distinct prices and
   * refused unprofitable publishers, and none of it reached money because this
   * function charged a hardcoded DEFAULT_PRICE_CENTS.
   *
   * When supplied, this quote BINDS:
   *   - `price_cents: null` REFUSES the serve. A refusal to sell is the
   *     clearest evidence the decision is real, so it has to be able to stop a
   *     placement, not just be logged next to one.
   *   - a number is charged instead of the default.
   *
   * Typed structurally rather than importing PriceQuote so that src/serve does
   * not depend on src/company. Serving enforces the decision; it does not make
   * it.
   */
  priceQuote?: {
    outcome: string;
    price_cents: number | null;
    rationale?: string;
  };
  stripePaymentRef?: string | null;
  /** Passed straight to reviewCreative — injectable moderation in tests. */
  review?: ReviewOptions;
  /**
   * Re-use a verdict already on the creative instead of re-reviewing. Off by
   * default: the serving boundary reviews for itself rather than trusting a
   * verdict that arrived attached to attacker-adjacent JSON.
   */
  trustExistingVerdict?: boolean;
  /**
   * Serve a creative held ONLY because Pioneer was unreachable. Off by default.
   * Never permits an unreviewed creative or one with a content flag.
   * Env: ADLAYER_ALLOW_UNMODERATED=1.
   */
  allowUnmoderated?: boolean;
  logger?: (message: string) => void;
}

function refusal(reason: string, partial: Partial<ServeResult> = {}): ServeResult {
  return {
    outcome: "refused",
    dryRun: true,
    placement: null,
    verdict: null,
    creative: null,
    publisher: null,
    llmsTxt: null,
    llmsTxtPath: null,
    unmoderatedOverride: false,
    ...partial,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read `creatives.json`. A missing file is not an error — this is the keyless
 * development path, and it degrades with one log line like everything else.
 */
export async function loadCreatives(
  path: string = DEFAULT_CREATIVES_PATH,
  logger: (m: string) => void = (m) => console.warn(m),
): Promise<Creative[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    logger(`[adlayer:serve] no creatives file at ${path} — nothing to serve.`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger(
      `[adlayer:serve] ${path} is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }) — treating as empty.`,
    );
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? ((parsed as Record<string, unknown>)["creatives"] ?? [])
      : [];
  return Array.isArray(list) ? (list as Creative[]) : [];
}

/** Atomic write: temp file + rename, so a crash cannot leave half an llms.txt. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// servePlacement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serve one creative onto one publisher.
 *
 * Never throws for an expected condition — an unknown id, a failed verdict, a
 * refused render and a broken base file all come back as `outcome: "refused"`
 * with a reason, because a serve loop must record a refusal rather than die on
 * one. It DOES throw if `assertDisclosed` ever fails on our own output, which
 * would mean the disclosure guarantee itself is broken; that is not a condition
 * to be handled, it is a condition to stop on.
 */
export async function servePlacement(
  creativeId: string,
  publisherId: string,
  flags: RunFlags = DRY_RUN,
  options: ServeOptions = {},
): Promise<ServeResult> {
  const log = options.logger ?? ((m: string) => console.warn(m));
  const allowUnmoderated =
    options.allowUnmoderated ?? envFlag("ADLAYER_ALLOW_UNMODERATED");

  // 1. Resolve publisher.
  let publishers: Publisher[];
  try {
    publishers = options.publishers ?? (await loadRegistry(options.registryPath ?? DEFAULT_REGISTRY_PATH));
  } catch (err) {
    return refusal(
      `registry unusable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const publisher = findById(publishers, publisherId);
  if (publisher === null) {
    return refusal(`unknown publisher ${JSON.stringify(publisherId)}`);
  }

  // 2. Resolve creative.
  const creatives =
    options.creatives ?? (await loadCreatives(options.creativesPath, log));
  const creative = creatives.find((c) => c?.id === creativeId) ?? null;
  if (creative === null) {
    return refusal(`unknown creative ${JSON.stringify(creativeId)}`, { publisher });
  }

  // 3. The veto. Runs here, at the serving boundary, not somewhere upstream we
  //    are hoping ran. A verdict attached to the creative is treated as an
  //    unverified claim unless the caller explicitly opts into trusting it.
  let verdict: ComplianceVerdict;
  if (options.trustExistingVerdict === true && creative.review !== null) {
    verdict = creative.review;
  } else {
    verdict = await reviewCreative(creative, options.review ?? {});
  }
  const reviewed: Creative = applyVerdict(creative, verdict);

  // 4. Refuse unless the verdict says yes. `servabilityReason` is the same
  //    allowlist renderLlmsTxt applies, so the two cannot drift apart.
  const refuseReason = servabilityReason(reviewed, { allowUnmoderated });
  const usedOverride =
    refuseReason === null && verdict.passed !== true && allowUnmoderated;
  if (refuseReason !== null) {
    log(
      `[adlayer:serve] REFUSED ${creativeId} on ${publisherId}: ${refuseReason}. ` +
        `Verdict: ${verdict.rationale}`,
    );
    return refusal(refuseReason, {
      verdict,
      creative: reviewed,
      publisher,
      llmsTxtPath: options.llmsTxtPath ?? publisherLlmsTxtPath(publisher),
    });
  }
  if (usedOverride) {
    log(
      `[adlayer:serve] SERVING UNMODERATED ${creativeId}: Pioneer was unreachable ` +
        `(${verdict.flags.join(", ")}) and ADLAYER_ALLOW_UNMODERATED is set. ` +
        `This placement carries the disclosure but NOT a completed moderation pass. ` +
        `Say so in any writeup that cites it.`,
    );
  }

  // 5. Locate the publisher's file and read the base content.
  const llmsTxtPath = options.llmsTxtPath ?? publisherLlmsTxtPath(publisher);
  if (llmsTxtPath === null) {
    return refusal(
      `publisher ${publisher.id} is off-convention — cannot locate its llms.txt`,
      { verdict, creative: reviewed, publisher },
    );
  }
  let baseContent: string;
  if (options.baseContent !== undefined) {
    baseContent = options.baseContent;
  } else {
    try {
      baseContent = await readFile(llmsTxtPath, "utf8");
    } catch (err) {
      return refusal(
        `cannot read ${llmsTxtPath}: ${err instanceof Error ? err.message : String(err)}`,
        { verdict, creative: reviewed, publisher, llmsTxtPath },
      );
    }
  }

  // 6. Render. renderBlock enforces the disclosure on its own output; we take
  //    the exact bytes it produced as the placement's rendered_block, so what
  //    measurement string-matches is what the file contains.
  const servedAt = options.servedAt ?? new Date().toISOString();
  let renderedBlock: string;
  let llmsTxt: string;
  try {
    renderedBlock = renderBlock(reviewed, publisher, { servedAt });
    llmsTxt = renderLlmsTxt(publisher, [reviewed], baseContent, {
      servedAt,
      allowUnmoderated,
      onSkip: (id, reason) => log(`[adlayer:serve] skipped ${id}: ${reason}`),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[adlayer:serve] REFUSED ${creativeId} on ${publisherId}: ${message}`);
    return refusal(
      err instanceof RenderRefusal ? message : `render failed: ${message}`,
      { verdict, creative: reviewed, publisher, llmsTxtPath },
    );
  }

  // The merge could still have dropped the block (its own allowlist), in which
  // case there is no placement to report — the file is unchanged and we say so.
  if (!llmsTxt.includes(renderedBlock)) {
    return refusal(
      "the merged llms.txt does not contain the rendered block — nothing was placed",
      { verdict, creative: reviewed, publisher, llmsTxtPath },
    );
  }
  if (parseVerifiedProvenance(llmsTxt).length !== 1) {
    return refusal(
      "the merged llms.txt does not carry exactly one signed provenance record",
      { verdict, creative: reviewed, publisher, llmsTxtPath },
    );
  }

  // 7. LAST LINE OF DEFENCE. Independent of the renderer's own assertion, on
  //    the exact bytes we are about to return and (maybe) write. There is
  //    deliberately no flag that skips this.
  assertDisclosed(renderedBlock);
  assertDisclosed(llmsTxt);

  // 7b. The Pricing agent's decision binds. A quote that declines to sell stops
  //     the placement here — after the disclosure checks, so a refusal can
  //     never be confused with a compliance failure in the logs.
  const quote = options.priceQuote;
  if (quote && quote.price_cents === null) {
    const why = quote.rationale ? `: ${quote.rationale}` : "";
    log(
      `[adlayer:serve] REFUSED ${creativeId} on ${publisherId} — ` +
        `Pricing declined to sell (${quote.outcome})${why}`,
    );
    return refusal(
      `Pricing agent declined to sell this placement (${quote.outcome})${why}`,
      { verdict, creative: reviewed, publisher, llmsTxtPath },
    );
  }

  const placement: Placement = {
    id: placementId(creativeId, publisher.id, servedAt),
    creative_id: creativeId,
    publisher_id: publisher.id,
    served_at: servedAt,
    rendered_block: renderedBlock,
    // Precedence is deliberate: an agent's decision outranks a caller-supplied
    // number, which outranks the default. The default is the last resort, not
    // the norm.
    price_cents: quote?.price_cents ?? options.priceCents ?? DEFAULT_PRICE_CENTS,
    stripe_payment_ref: options.stripePaymentRef ?? null,
  };

  // 8. Write only under the flag.
  if (!flags.liveServe) {
    log(
      `[adlayer:serve] DRY RUN — computed ${llmsTxt.length} bytes for ` +
        `${llmsTxtPath}, wrote nothing. Set LIVE_SERVE=1 to publish.`,
    );
    return {
      outcome: "dry_run",
      dryRun: true,
      placement,
      verdict,
      creative: reviewed,
      publisher,
      reason: "dry run — LIVE_SERVE is not set, nothing was written",
      llmsTxt,
      llmsTxtPath,
      unmoderatedOverride: usedOverride,
    };
  }

  try {
    await writeAtomic(llmsTxtPath, llmsTxt);
  } catch (err) {
    return refusal(
      `write to ${llmsTxtPath} failed: ${err instanceof Error ? err.message : String(err)}`,
      { verdict, creative: reviewed, publisher, llmsTxt, llmsTxtPath },
    );
  }

  log(`[adlayer:serve] SERVED ${placement.id} -> ${llmsTxtPath} at ${servedAt}`);
  return {
    outcome: "served",
    dryRun: false,
    placement,
    verdict,
    creative: reviewed,
    publisher,
    reason: `served to ${llmsTxtPath}`,
    llmsTxt,
    llmsTxtPath,
    unmoderatedOverride: usedOverride,
  };
}

/** Deterministic given the same inputs, so a dry run and a live run agree. */
export function placementId(
  creativeId: string,
  publisherId: string,
  servedAt: string,
): string {
  const digest = createHash("sha256")
    .update(`${creativeId}|${publisherId}|${servedAt}`)
    .digest("hex")
    .slice(0, 16);
  return `plc_${digest}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — `npm run serve -- <creative_id> <publisher_id>`
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [creativeId, publisherId] = argv;
  const flags = flagsFromEnv();

  if (creativeId === undefined || publisherId === undefined) {
    const publishers = await loadRegistry().catch(() => [] as Publisher[]);
    const creatives = await loadCreatives();
    console.log("AdLayer ad server — usage: npm run serve -- <creative_id> <publisher_id>\n");
    console.log(`LIVE_SERVE=${flags.liveServe ? "1 (WILL WRITE)" : "0 (dry run)"}`);
    console.log(`\nPublishers (${publishers.length}):`);
    for (const p of publishers) console.log(`  ${p.id.padEnd(24)} ${p.domain}`);
    console.log(`\nCreatives (${creatives.length}):`);
    for (const c of creatives) {
      const gate = servabilityReason(c) ?? "servable";
      console.log(`  ${String(c?.id).padEnd(24)} ${String(c?.status).padEnd(16)} ${gate}`);
    }
    return creativeId === undefined ? 0 : 2;
  }

  const result = await servePlacement(creativeId, publisherId, flags);
  console.log(`\noutcome: ${result.outcome}`);
  console.log(`reason:  ${result.reason}`);
  if (result.verdict !== null) {
    console.log(`verdict: ${verdictStatus(result.verdict)} — ${result.verdict.rationale}`);
  }
  if (result.placement !== null) {
    console.log(`\nplacement ${result.placement.id} @ ${result.placement.served_at}\n`);
    console.log(result.placement.rendered_block);
  }
  return result.outcome === "refused" ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
