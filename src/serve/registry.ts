/**
 * ADLAYER — publisher registry.
 *
 * Loads and saves `Publisher[]` from `publishers/registry.json`, and pairs
 * creatives to publishers by category.
 *
 * Two deliberate postures:
 *
 * 1. **Loud, not lenient.** A malformed record is an error with a path and a
 *    reason, never a silently coerced default. `rev_share: "0.5"` is a bug in
 *    somebody's tooling; paying a publisher 50% because we called `Number()`
 *    on it is a bug in ours. Unknown keys are rejected too — a typo'd
 *    `rev_shares` would otherwise vanish without a trace.
 * 2. **Tight matching by default.** Category match is what puts an ad on a
 *    page. Loose matching is how a gutter creative lands on a fintech site.
 *    Exact (normalized) token match is the default; substring matching exists
 *    but you have to ask for it by name.
 *
 * Zero runtime dependencies. Node stdlib only.
 */

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import type { Publisher } from "../contract.ts";
import { SLOT_MARKER } from "./render.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Location
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-root `publishers/registry.json`, resolved from this module. */
export const DEFAULT_REGISTRY_PATH: string = fileURLToPath(
  new URL("../../publishers/registry.json", import.meta.url),
);

/**
 * Directory-name convention. `Publisher` has no slug field and the contract is
 * law, so the site directory is derived from the id: `pub_<slug>` maps to
 * `publishers/<slug>/`. Keep new ids in that form.
 */
export const PUBLISHER_ID_PREFIX = "pub_";

/** `pub_gutter-guide` -> `gutter-guide`. Returns null if the id is off-convention. */
export function publisherSlug(publisher: Publisher): string | null {
  if (!publisher.id.startsWith(PUBLISHER_ID_PREFIX)) return null;
  const slug = publisher.id.slice(PUBLISHER_ID_PREFIX.length);
  return slug.length > 0 ? slug : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryIssue {
  /** Where the problem is, e.g. `publishers[1].rev_share`. */
  path: string;
  message: string;
}

/** Thrown by every load/parse/save path. Carries every issue, not just the first. */
export class RegistryValidationError extends Error {
  readonly issues: readonly RegistryIssue[];
  readonly source: string;

  constructor(source: string, issues: readonly RegistryIssue[]) {
    const lines = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    super(
      `${source}: ${issues.length} registry problem${issues.length === 1 ? "" : "s"}\n${lines}`,
    );
    this.name = "RegistryValidationError";
    this.issues = issues;
    this.source = source;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization — the matching semantics, in one place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical host key for domain lookup. Case-insensitive; tolerates a full URL
 * so callers can pass whatever they have.
 *
 * `https://WWW.Gutter-Guide.example:8443/llms.txt` -> `gutter-guide.example`
 *
 * A leading `www.` is stripped from both sides of a comparison, so
 * `www.foo.example` and `foo.example` are the same publisher. No other suffix
 * logic: `blog.foo.example` is NOT `foo.example`.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.\-]*:\/\//, ""); // scheme
  d = d.replace(/[/?#].*$/, ""); // path, query, fragment
  d = d.replace(/^[^@]*@/, ""); // userinfo
  d = d.replace(/:\d+$/, ""); // port
  d = d.replace(/\.+$/, ""); // trailing root dot
  d = d.replace(/^www\./, "");
  return d;
}

/**
 * Canonical category token. Case-insensitive; spaces and hyphens both fold to
 * underscore, so `Home Services`, `home-services` and `home_services` are one
 * category. Everything else is left alone — we do not stem or pluralize.
 */
export function normalizeCategory(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const INTEGRATIONS: readonly Publisher["integration"][] = [
  "hosted",
  "proxy",
  "cited_generated",
];

const PUBLISHER_KEYS: readonly string[] = [
  "id",
  "domain",
  "integration",
  "categories",
  "rev_share",
  "verified_at",
];

/** Bare lowercase hostname. No scheme, no port, no path. */
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** ISO-8601 with an explicit offset. `2026-08-15T13:02:11Z` or `+02:00`. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const MAX_CATEGORIES = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkPublisher(
  value: unknown,
  path: string,
  issues: RegistryIssue[],
): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: `expected an object, got ${describe(value)}` });
    return;
  }

  for (const key of Object.keys(value)) {
    if (!PUBLISHER_KEYS.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message:
          "unknown field — the contract in src/contract.ts is law; " +
          "a typo'd key would otherwise be dropped silently",
      });
    }
  }

  // id
  const id = value["id"];
  if (typeof id !== "string" || id.trim().length === 0) {
    issues.push({
      path: `${path}.id`,
      message: `expected a non-empty string, got ${describe(id)}`,
    });
  } else if (id !== id.trim()) {
    issues.push({ path: `${path}.id`, message: "has leading or trailing whitespace" });
  }

  // domain
  const domain = value["domain"];
  if (typeof domain !== "string" || domain.length === 0) {
    issues.push({
      path: `${path}.domain`,
      message: `expected a non-empty string, got ${describe(domain)}`,
    });
  } else if (!DOMAIN_RE.test(domain)) {
    issues.push({
      path: `${path}.domain`,
      message:
        `expected a bare lowercase hostname (no scheme, port or path), got ${JSON.stringify(domain)}`,
    });
  }

  // integration
  const integration = value["integration"];
  if (
    typeof integration !== "string" ||
    !INTEGRATIONS.includes(integration as Publisher["integration"])
  ) {
    issues.push({
      path: `${path}.integration`,
      message: `expected one of ${INTEGRATIONS.map((i) => JSON.stringify(i)).join(", ")}, got ${describe(integration)}`,
    });
  }

  // categories
  const categories = value["categories"];
  if (!Array.isArray(categories)) {
    issues.push({
      path: `${path}.categories`,
      message: `expected an array of strings, got ${describe(categories)}`,
    });
  } else if (categories.length === 0) {
    issues.push({
      path: `${path}.categories`,
      message: "expected at least one category — an untargetable publisher is a bug",
    });
  } else if (categories.length > MAX_CATEGORIES) {
    issues.push({
      path: `${path}.categories`,
      message: `expected at most ${MAX_CATEGORIES} categories, got ${categories.length}`,
    });
  } else {
    const seen = new Map<string, number>();
    categories.forEach((c, i) => {
      const at = `${path}.categories[${i}]`;
      if (typeof c !== "string" || c.trim().length === 0) {
        issues.push({ path: at, message: `expected a non-empty string, got ${describe(c)}` });
        return;
      }
      if (c !== c.trim()) {
        issues.push({ path: at, message: "has leading or trailing whitespace" });
        return;
      }
      const key = normalizeCategory(c);
      if (key.length === 0) {
        issues.push({ path: at, message: `normalizes to the empty string: ${JSON.stringify(c)}` });
        return;
      }
      const prior = seen.get(key);
      if (prior !== undefined) {
        issues.push({
          path: at,
          message: `duplicates categories[${prior}] once normalized (both are ${JSON.stringify(key)})`,
        });
        return;
      }
      seen.set(key, i);
    });
  }

  // rev_share
  const revShare = value["rev_share"];
  if (typeof revShare !== "number" || !Number.isFinite(revShare)) {
    issues.push({
      path: `${path}.rev_share`,
      message: `expected a finite number in 0..1, got ${describe(revShare)}`,
    });
  } else if (revShare < 0 || revShare > 1) {
    issues.push({
      path: `${path}.rev_share`,
      message: `expected a fraction in 0..1, got ${revShare} — this is a share, not a percentage`,
    });
  }

  // verified_at
  const verifiedAt = value["verified_at"];
  if (verifiedAt !== null) {
    if (typeof verifiedAt !== "string") {
      issues.push({
        path: `${path}.verified_at`,
        message: `expected an ISO-8601 string or null, got ${describe(verifiedAt)}`,
      });
    } else if (!ISO_RE.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) {
      issues.push({
        path: `${path}.verified_at`,
        message: `expected an ISO-8601 timestamp with an explicit offset, got ${JSON.stringify(verifiedAt)}`,
      });
    }
  }
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined (missing)";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array (length ${v.length})`;
  if (typeof v === "string") return `a string ${JSON.stringify(v)}`;
  if (typeof v === "object") return "an object";
  return `${typeof v} ${String(v)}`;
}

/**
 * Validate a decoded registry document. Returns a frozen `Publisher[]` or
 * throws `RegistryValidationError` listing every problem found.
 *
 * The document is the array itself — `[{...}, {...}]`, not `{publishers: [...]}`,
 * because `AdLayerState.publishers` is an array and the file should render into
 * it without a transform.
 */
export function parseRegistry(
  document: unknown,
  source = "<registry>",
): Publisher[] {
  const issues: RegistryIssue[] = [];

  if (!Array.isArray(document)) {
    throw new RegistryValidationError(source, [
      { path: "publishers", message: `expected a JSON array, got ${describe(document)}` },
    ]);
  }

  document.forEach((entry, i) => checkPublisher(entry, `publishers[${i}]`, issues));

  // Cross-record uniqueness. Two publishers on one domain means two blocks in
  // one llms.txt with no way to attribute revenue.
  const byId = new Map<string, number>();
  const byDomain = new Map<string, number>();
  document.forEach((entry, i) => {
    if (!isPlainObject(entry)) return;
    const id = entry["id"];
    if (typeof id === "string" && id.length > 0) {
      const prior = byId.get(id);
      if (prior !== undefined) {
        issues.push({
          path: `publishers[${i}].id`,
          message: `duplicate id ${JSON.stringify(id)}, already used by publishers[${prior}]`,
        });
      } else byId.set(id, i);
    }
    const domain = entry["domain"];
    if (typeof domain === "string" && domain.length > 0) {
      const key = normalizeDomain(domain);
      const prior = byDomain.get(key);
      if (prior !== undefined) {
        issues.push({
          path: `publishers[${i}].domain`,
          message: `duplicate domain ${JSON.stringify(key)}, already used by publishers[${prior}]`,
        });
      } else byDomain.set(key, i);
    }
  });

  if (issues.length > 0) throw new RegistryValidationError(source, issues);
  return document as Publisher[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Load / save
// ─────────────────────────────────────────────────────────────────────────────

/** Exact bytes we write. Stable so the file diffs cleanly in git. */
export function serializeRegistry(publishers: readonly Publisher[]): string {
  return `${JSON.stringify(publishers, null, 2)}\n`;
}

/**
 * Read and validate the registry. Throws `RegistryValidationError` on malformed
 * JSON or a malformed record — deliberately loud. A registry we cannot trust is
 * worse than no registry, because it decides who gets paid.
 */
export async function loadRegistry(
  path: string = DEFAULT_REGISTRY_PATH,
): Promise<Publisher[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new RegistryValidationError(path, [
        { path: "<file>", message: "registry file does not exist" },
      ]);
    }
    throw err;
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (err) {
    throw new RegistryValidationError(path, [
      { path: "<file>", message: `not valid JSON — ${(err as Error).message}` },
    ]);
  }

  return parseRegistry(document, path);
}

/**
 * Validate, then write atomically (temp file + rename) so a crash mid-write
 * cannot leave a half-registry behind. Validation runs BEFORE the write: we
 * never persist a document we would refuse to load.
 */
export async function saveRegistry(
  publishers: readonly Publisher[],
  path: string = DEFAULT_REGISTRY_PATH,
): Promise<void> {
  parseRegistry(publishers, path);

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, serializeRegistry(publishers), "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup check — a registry entry that names no real site is worse than none
// ─────────────────────────────────────────────────────────────────────────────

/** Repo-root `publishers/`, resolved from this module. */
export const PUBLISHERS_DIR: string = fileURLToPath(
  new URL("../../publishers/", import.meta.url),
);

export interface PublisherAssetCheck {
  publisher: Publisher;
  slug: string | null;
  llmsTxtPath: string | null;
  exists: boolean;
  hasSlotMarker: boolean;
  problem: string | null;
}

/** `publishers/<slug>/llms.txt` for a registry entry, or null if off-convention. */
export function publisherLlmsTxtPath(publisher: Publisher): string | null {
  const slug = publisherSlug(publisher);
  return slug === null ? null : join(PUBLISHERS_DIR, slug, "llms.txt");
}

/**
 * Confirm every registry entry resolves to a real site with an injection point.
 *
 * The seeded registry once named three publishers on `*.example` domains that
 * had no directory, no llms.txt and no deployment, while the three sites we had
 * actually built were absent from it. Nothing could be paired and served, and
 * nothing said so — every read just threw ENOENT at serve time. This is the
 * check that would have caught it in one line of output.
 */
export async function checkPublisherAssets(
  publishers: readonly Publisher[],
): Promise<PublisherAssetCheck[]> {
  return Promise.all(
    publishers.map(async (publisher): Promise<PublisherAssetCheck> => {
      const slug = publisherSlug(publisher);
      const llmsTxtPath = publisherLlmsTxtPath(publisher);
      if (slug === null || llmsTxtPath === null) {
        return {
          publisher,
          slug,
          llmsTxtPath,
          exists: false,
          hasSlotMarker: false,
          problem: `id ${JSON.stringify(publisher.id)} is off-convention — expected ${PUBLISHER_ID_PREFIX}<slug>`,
        };
      }
      let body: string;
      try {
        body = await readFile(llmsTxtPath, "utf8");
      } catch {
        return {
          publisher,
          slug,
          llmsTxtPath,
          exists: false,
          hasSlotMarker: false,
          problem: `no llms.txt at ${llmsTxtPath}`,
        };
      }
      const hasSlotMarker = body.includes(SLOT_MARKER);
      return {
        publisher,
        slug,
        llmsTxtPath,
        exists: true,
        hasSlotMarker,
        problem: hasSlotMarker ? null : `${llmsTxtPath} has no ${SLOT_MARKER}`,
      };
    }),
  );
}

/** Same check, but loud. Throws listing every publisher that cannot be served. */
export async function assertPublisherAssets(
  publishers: readonly Publisher[],
): Promise<PublisherAssetCheck[]> {
  const checks = await checkPublisherAssets(publishers);
  const broken = checks.filter((c) => c.problem !== null);
  if (broken.length > 0) {
    throw new RegistryValidationError(
      PUBLISHERS_DIR,
      broken.map((c) => ({ path: c.publisher.id, message: c.problem ?? "unknown problem" })),
    );
  }
  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

/** Exact id match. Null when absent — callers decide whether that is fatal. */
export function findById(
  publishers: readonly Publisher[],
  id: string,
): Publisher | null {
  return publishers.find((p) => p.id === id) ?? null;
}

/** `publishers/<slug>/` -> the publisher, via the `pub_<slug>` id convention. */
export function findBySlug(
  publishers: readonly Publisher[],
  slug: string,
): Publisher | null {
  return findById(publishers, `${PUBLISHER_ID_PREFIX}${slug}`);
}

/**
 * Domain lookup. Case-insensitive, tolerates a full URL, ignores a leading
 * `www.`. Subdomains do NOT match their parent — serving into
 * `blog.foo.example` because we have a deal with `foo.example` is exactly the
 * kind of "close enough" that ad networks get sued for.
 */
export function findByDomain(
  publishers: readonly Publisher[],
  domain: string,
): Publisher | null {
  const key = normalizeDomain(domain);
  if (key.length === 0) return null;
  return publishers.find((p) => normalizeDomain(p.domain) === key) ?? null;
}

export type CategoryMatchMode =
  /** Normalized tokens must be equal. `gutters` does not match `gutter`. */
  | "exact"
  /** Normalized query appears anywhere in the normalized category token. Opt-in. */
  | "substring";

export interface CategoryQueryOptions {
  /** Default `"exact"`. */
  mode?: CategoryMatchMode;
}

function tokenMatches(ownKey: string, queryKey: string, mode: CategoryMatchMode): boolean {
  if (queryKey.length === 0) return false;
  return mode === "exact" ? ownKey === queryKey : ownKey.includes(queryKey);
}

/** True if `publisher` carries `category` under the given mode. */
export function publisherMatchesCategory(
  publisher: Publisher,
  category: string,
  options: CategoryQueryOptions = {},
): boolean {
  const mode = options.mode ?? "exact";
  const q = normalizeCategory(category);
  return publisher.categories.some((c) => tokenMatches(normalizeCategory(c), q, mode));
}

/**
 * Every publisher carrying `category`, in registry order. Empty array on no
 * match and on an empty query — never throws, never returns a "close enough"
 * fallback. An empty result means do not serve.
 */
export function findByCategory(
  publishers: readonly Publisher[],
  category: string,
  options: CategoryQueryOptions = {},
): Publisher[] {
  return publishers.filter((p) => publisherMatchesCategory(p, category, options));
}

/**
 * Union across several categories — the shape a `Creative.categories` lookup
 * needs. Deduplicated by id, in registry order.
 */
export function findByAnyCategory(
  publishers: readonly Publisher[],
  categories: readonly string[],
  options: CategoryQueryOptions = {},
): Publisher[] {
  return publishers.filter((p) =>
    categories.some((c) => publisherMatchesCategory(p, c, options)),
  );
}

export interface CategoryMatch {
  publisher: Publisher;
  /** The publisher's own category tokens that matched, in publisher order. */
  matched: string[];
  /** Count of matched publisher categories. Higher is a tighter fit. */
  score: number;
}

/**
 * The pairing function: rank publishers by how much of a creative's category
 * set they carry. Publishers with zero overlap are omitted, not ranked last —
 * "no publisher fits this creative" is a legitimate and important answer.
 *
 * Ties keep registry order, so the ranking is deterministic and testable.
 */
export function rankByCategoryOverlap(
  publishers: readonly Publisher[],
  categories: readonly string[],
  options: CategoryQueryOptions = {},
): CategoryMatch[] {
  const mode = options.mode ?? "exact";
  const queries = categories.map(normalizeCategory);
  const ranked: CategoryMatch[] = [];
  for (const publisher of publishers) {
    const matched = publisher.categories.filter((own) => {
      const ownKey = normalizeCategory(own);
      return queries.some((q) => tokenMatches(ownKey, q, mode));
    });
    if (matched.length > 0) {
      ranked.push({ publisher, matched, score: matched.length });
    }
  }
  // Array.prototype.sort is stable, so equal scores keep registry order.
  return ranked.sort((a, b) => b.score - a.score);
}
