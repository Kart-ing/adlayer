import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Publisher } from "../../contract.ts";
import {
  DEFAULT_REGISTRY_PATH,
  PUBLISHER_ID_PREFIX,
  RegistryValidationError,
  assertPublisherAssets,
  findByAnyCategory,
  findByCategory,
  findByDomain,
  findById,
  findBySlug,
  loadRegistry,
  normalizeCategory,
  normalizeDomain,
  parseRegistry,
  publisherMatchesCategory,
  publisherSlug,
  rankByCategoryOverlap,
  saveRegistry,
  serializeRegistry,
} from "../registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mk(overrides: Partial<Publisher> = {}): Publisher {
  return {
    id: "pub_test-site",
    domain: "test-site.example",
    integration: "hosted",
    categories: ["home_services"],
    rev_share: 0.5,
    verified_at: null,
    ...overrides,
  };
}

/** Three publishers with a deliberate category overlap, in a known order. */
const FIXTURE: Publisher[] = [
  mk({
    id: "pub_alpha",
    domain: "alpha.example",
    categories: ["home_services", "gutters", "roof_drainage"],
  }),
  mk({
    id: "pub_bravo",
    domain: "bravo.example",
    integration: "proxy",
    categories: ["home_services", "hvac", "heat_pumps"],
  }),
  mk({
    id: "pub_charlie",
    domain: "charlie.example",
    integration: "cited_generated",
    categories: ["saas", "invoicing", "small_business"],
  }),
];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "adlayer-registry-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function issuePaths(err: unknown): string[] {
  assert.ok(err instanceof RegistryValidationError, `expected RegistryValidationError, got ${err}`);
  return err.issues.map((i) => i.path);
}

/** Assert that `document` is rejected, and that an issue points at `path`. */
function rejects(document: unknown, path: string): RegistryValidationError {
  let caught: unknown;
  try {
    parseRegistry(document, "<test>");
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof RegistryValidationError,
    `expected the registry to be rejected, but it parsed: ${JSON.stringify(document)}`,
  );
  assert.ok(
    issuePaths(caught).includes(path),
    `expected an issue at ${path}, got ${JSON.stringify(issuePaths(caught))}`,
  );
  return caught;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seeded registry on disk
// ─────────────────────────────────────────────────────────────────────────────

test("seed registry: loads, holds exactly 3 publishers, all unverified at 0.5", async () => {
  const publishers = await loadRegistry();

  assert.equal(publishers.length, 3);
  for (const p of publishers) {
    assert.equal(p.rev_share, 0.5, `${p.id} rev_share`);
    assert.equal(p.verified_at, null, `${p.id} verified_at`);
    assert.ok(p.id.startsWith(PUBLISHER_ID_PREFIX), `${p.id} follows the pub_<slug> convention`);
    assert.ok(p.categories.length > 0, `${p.id} is targetable`);
  }

  assert.deepEqual(
    publishers.map(publisherSlug),
    ["rink-ops", "darkroom-commons", "loop-notes"],
  );
});

/**
 * The seeded registry once named three publishers on `*.example` domains with
 * no directory, no llms.txt and no deployment, while the three sites we had
 * actually built were absent from it. Every read threw ENOENT at serve time and
 * nothing said so. This is the check that catches that class of drift.
 */
test("seed registry: every entry resolves to a real site with an injection point", async () => {
  const publishers = await loadRegistry();
  const checks = await assertPublisherAssets(publishers);

  assert.equal(checks.length, 3);
  for (const c of checks) {
    assert.equal(c.problem, null, `${c.publisher.id}: ${c.problem}`);
    assert.equal(c.exists, true);
    assert.equal(c.hasSlotMarker, true);
    assert.ok(c.llmsTxtPath?.endsWith(`${c.slug}/llms.txt`));
  }
});

test("assertPublisherAssets is loud about a publisher that does not exist", async () => {
  await assert.rejects(
    () => assertPublisherAssets([mk({ id: "pub_does-not-exist", domain: "nope.example" })]),
    (err: unknown) => {
      assert.ok(err instanceof RegistryValidationError);
      assert.match(err.message, /no llms\.txt at/);
      return true;
    },
  );
});

test("seed registry: file on disk is byte-identical to our serializer", async () => {
  const publishers = await loadRegistry();
  const onDisk = await readFile(DEFAULT_REGISTRY_PATH, "utf8");
  assert.equal(onDisk, serializeRegistry(publishers));
});

// ─────────────────────────────────────────────────────────────────────────────
// load
// ─────────────────────────────────────────────────────────────────────────────

test("load: missing file is a loud RegistryValidationError, not a silent empty list", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => loadRegistry(join(dir, "nope.json")),
      (err: unknown) => {
        assert.ok(err instanceof RegistryValidationError);
        assert.match(err.message, /does not exist/);
        return true;
      },
    );
  });
});

test("load: invalid JSON is rejected with the file path in the message", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "registry.json");
    await writeFile(path, "[{ not json ]", "utf8");
    await assert.rejects(
      () => loadRegistry(path),
      (err: unknown) => {
        assert.ok(err instanceof RegistryValidationError);
        assert.match(err.message, /not valid JSON/);
        assert.equal(err.source, path);
        return true;
      },
    );
  });
});

test("load: a malformed record fails the whole load — no partial registry", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "registry.json");
    await writeFile(path, JSON.stringify([mk(), { ...mk({ id: "pub_b", domain: "b.example" }), rev_share: "0.5" }]), "utf8");
    await assert.rejects(() => loadRegistry(path), RegistryValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// save
// ─────────────────────────────────────────────────────────────────────────────

test("save: round-trips through the filesystem unchanged", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "registry.json");
    await saveRegistry(FIXTURE, path);
    const reloaded = await loadRegistry(path);
    assert.deepEqual(reloaded, FIXTURE);
  });
});

test("save: writes stable pretty JSON with a trailing newline", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "registry.json");
    await saveRegistry(FIXTURE, path);
    const raw = await readFile(path, "utf8");
    assert.equal(raw, `${JSON.stringify(FIXTURE, null, 2)}\n`);
    assert.ok(raw.endsWith("\n"));
  });
});

test("save: validates before writing — a bad record never reaches disk", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "registry.json");
    await saveRegistry(FIXTURE, path);

    const bad = [...FIXTURE, mk({ id: "pub_bad", domain: "bad.example", rev_share: 1.5 })];
    await assert.rejects(() => saveRegistry(bad, path), RegistryValidationError);

    // Prior contents intact, and no temp file left behind.
    assert.deepEqual(await loadRegistry(path), FIXTURE);
    const left = await readdir(dir);
    assert.deepEqual(left, ["registry.json"], `stray files: ${JSON.stringify(left)}`);
  });
});

test("save: rejects a duplicate domain rather than double-serving one llms.txt", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "registry.json");
    const dupes = [mk({ id: "pub_a", domain: "dupe.example" }), mk({ id: "pub_b", domain: "www.dupe.example" })];
    await assert.rejects(() => saveRegistry(dupes, path), RegistryValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation — malformed input is rejected loudly, never coerced
// ─────────────────────────────────────────────────────────────────────────────

test("validate: the document must be an array", () => {
  rejects({ publishers: [mk()] }, "publishers");
  rejects(null, "publishers");
  rejects("[]", "publishers");
});

test("validate: an entry must be an object", () => {
  rejects([mk(), "pub_x"], "publishers[1]");
  rejects([[mk()]], "publishers[0]");
});

test("validate: missing required fields are reported by name", () => {
  const { id, ...noId } = mk();
  void id;
  rejects([noId], "publishers[0].id");

  const { domain, ...noDomain } = mk();
  void domain;
  rejects([noDomain], "publishers[0].domain");

  const { verified_at, ...noVerified } = mk();
  void verified_at;
  rejects([noVerified], "publishers[0].verified_at");
});

test("validate: rev_share must be a finite number in 0..1, never a coerced string", () => {
  rejects([{ ...mk(), rev_share: "0.5" }], "publishers[0].rev_share");
  rejects([{ ...mk(), rev_share: 50 }], "publishers[0].rev_share");
  rejects([{ ...mk(), rev_share: -0.1 }], "publishers[0].rev_share");
  rejects([{ ...mk(), rev_share: Number.NaN }], "publishers[0].rev_share");
  assert.equal(parseRegistry([mk({ rev_share: 0 })])[0]?.rev_share, 0);
  assert.equal(parseRegistry([mk({ rev_share: 1 })])[0]?.rev_share, 1);
});

test("validate: integration must be one of the three contract literals", () => {
  rejects([{ ...mk(), integration: "hosted " }], "publishers[0].integration");
  rejects([{ ...mk(), integration: "HOSTED" }], "publishers[0].integration");
  rejects([{ ...mk(), integration: "render" }], "publishers[0].integration");
  for (const integration of ["hosted", "proxy", "cited_generated"] as const) {
    assert.equal(parseRegistry([mk({ integration })])[0]?.integration, integration);
  }
});

test("validate: domain must be a bare lowercase hostname", () => {
  rejects([{ ...mk(), domain: "https://test-site.example" }], "publishers[0].domain");
  rejects([{ ...mk(), domain: "test-site.example/llms.txt" }], "publishers[0].domain");
  rejects([{ ...mk(), domain: "test-site.example:8443" }], "publishers[0].domain");
  rejects([{ ...mk(), domain: "Test-Site.example" }], "publishers[0].domain");
  rejects([{ ...mk(), domain: "localhost" }], "publishers[0].domain");
  rejects([{ ...mk(), domain: "" }], "publishers[0].domain");
  assert.equal(parseRegistry([mk({ domain: "a.b.co.uk" })])[0]?.domain, "a.b.co.uk");
});

test("validate: categories must be a non-empty array of clean, unique tokens", () => {
  rejects([{ ...mk(), categories: [] }], "publishers[0].categories");
  rejects([{ ...mk(), categories: "home_services" }], "publishers[0].categories");
  rejects([{ ...mk(), categories: ["home_services", 3] }], "publishers[0].categories[1]");
  rejects([{ ...mk(), categories: ["home_services", ""] }], "publishers[0].categories[1]");
  rejects([{ ...mk(), categories: [" home_services"] }], "publishers[0].categories[0]");
  // Duplicates only visible after normalization still count as duplicates.
  rejects([{ ...mk(), categories: ["home_services", "Home Services"] }], "publishers[0].categories[1]");
});

test("validate: verified_at is null or an ISO-8601 timestamp with an offset", () => {
  assert.equal(parseRegistry([mk({ verified_at: null })])[0]?.verified_at, null);
  assert.equal(
    parseRegistry([mk({ verified_at: "2026-08-15T13:02:11Z" })])[0]?.verified_at,
    "2026-08-15T13:02:11Z",
  );
  assert.equal(
    parseRegistry([mk({ verified_at: "2026-08-15T13:02:11.123+02:00" })])[0]?.verified_at,
    "2026-08-15T13:02:11.123+02:00",
  );
  rejects([{ ...mk(), verified_at: "2026-08-15" }], "publishers[0].verified_at");
  rejects([{ ...mk(), verified_at: "2026-08-15T13:02:11" }], "publishers[0].verified_at");
  rejects([{ ...mk(), verified_at: "yesterday" }], "publishers[0].verified_at");
  rejects([{ ...mk(), verified_at: 1755262931 }], "publishers[0].verified_at");
});

test("validate: unknown fields are rejected so a typo cannot be dropped silently", () => {
  rejects([{ ...mk(), rev_shares: 0.5 }], "publishers[0].rev_shares");
  rejects([{ ...mk(), slug: "test-site" }], "publishers[0].slug");
});

test("validate: duplicate ids and duplicate domains are rejected", () => {
  rejects([mk({ id: "pub_a", domain: "a.example" }), mk({ id: "pub_a", domain: "b.example" })], "publishers[1].id");
  rejects([mk({ id: "pub_a", domain: "a.example" }), mk({ id: "pub_b", domain: "a.example" })], "publishers[1].domain");
});

test("validate: every problem is reported at once, not just the first", () => {
  const err = rejects(
    [{ ...mk(), rev_share: "0.5", integration: "render", categories: [] }],
    "publishers[0].rev_share",
  );
  const paths = issuePaths(err);
  assert.ok(paths.includes("publishers[0].integration"));
  assert.ok(paths.includes("publishers[0].categories"));
  assert.equal(paths.length, 3);
  assert.match(err.message, /3 registry problems/);
});

test("validate: a clean registry is returned untouched", () => {
  assert.deepEqual(parseRegistry(structuredClone(FIXTURE)), FIXTURE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeDomain: strips scheme, userinfo, port, path, trailing dot and www", () => {
  assert.equal(normalizeDomain("https://WWW.Alpha.example:8443/llms.txt?x=1#y"), "alpha.example");
  assert.equal(normalizeDomain("  alpha.example.  "), "alpha.example");
  assert.equal(normalizeDomain("http://user:pw@alpha.example"), "alpha.example");
  assert.equal(normalizeDomain("alpha.example"), "alpha.example");
  assert.equal(normalizeDomain(""), "");
});

test("normalizeCategory: folds case, spaces and hyphens; does not stem", () => {
  assert.equal(normalizeCategory("Home Services"), "home_services");
  assert.equal(normalizeCategory("home-services"), "home_services");
  assert.equal(normalizeCategory("  HOME   SERVICES "), "home_services");
  assert.equal(normalizeCategory("home__services"), "home_services");
  assert.notEqual(normalizeCategory("gutter"), normalizeCategory("gutters"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Lookup — id and slug
// ─────────────────────────────────────────────────────────────────────────────

test("findById / findBySlug / publisherSlug", () => {
  assert.equal(findById(FIXTURE, "pub_bravo")?.domain, "bravo.example");
  assert.equal(findById(FIXTURE, "pub_missing"), null);
  assert.equal(findById(FIXTURE, "PUB_BRAVO"), null, "id match is exact and case-sensitive");

  assert.equal(findBySlug(FIXTURE, "charlie")?.id, "pub_charlie");
  assert.equal(findBySlug(FIXTURE, "delta"), null);

  assert.equal(publisherSlug(mk({ id: "pub_gutter-guide" })), "gutter-guide");
  assert.equal(publisherSlug(mk({ id: "legacy-id" })), null);
  assert.equal(publisherSlug(mk({ id: "pub_" })), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Lookup — domain
// ─────────────────────────────────────────────────────────────────────────────

test("findByDomain: exact host, case-insensitive, URL and www tolerant", () => {
  assert.equal(findByDomain(FIXTURE, "alpha.example")?.id, "pub_alpha");
  assert.equal(findByDomain(FIXTURE, "ALPHA.example")?.id, "pub_alpha");
  assert.equal(findByDomain(FIXTURE, "www.alpha.example")?.id, "pub_alpha");
  assert.equal(findByDomain(FIXTURE, "https://alpha.example/llms.txt")?.id, "pub_alpha");
  assert.equal(findByDomain(FIXTURE, "  alpha.example  ")?.id, "pub_alpha");
});

test("findByDomain: a subdomain is a different property, not a partial match", () => {
  assert.equal(findByDomain(FIXTURE, "blog.alpha.example"), null);
  assert.equal(findByDomain(FIXTURE, "example"), null);
  assert.equal(findByDomain(FIXTURE, "alpha.example.attacker.test"), null);
});

test("findByDomain: no match and empty input return null, never a fallback publisher", () => {
  assert.equal(findByDomain(FIXTURE, "unknown.example"), null);
  assert.equal(findByDomain(FIXTURE, ""), null);
  assert.equal(findByDomain(FIXTURE, "   "), null);
  assert.equal(findByDomain([], "alpha.example"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Lookup — category. This is the pairing decision, so every branch is pinned.
// ─────────────────────────────────────────────────────────────────────────────

test("findByCategory: exact match, case and separator insensitive", () => {
  assert.deepEqual(findByCategory(FIXTURE, "saas").map((p) => p.id), ["pub_charlie"]);
  assert.deepEqual(findByCategory(FIXTURE, "SaaS").map((p) => p.id), ["pub_charlie"]);
  assert.deepEqual(findByCategory(FIXTURE, "heat pumps").map((p) => p.id), ["pub_bravo"]);
  assert.deepEqual(findByCategory(FIXTURE, "Heat-Pumps").map((p) => p.id), ["pub_bravo"]);
});

test("findByCategory: multiple matches come back in registry order", () => {
  assert.deepEqual(
    findByCategory(FIXTURE, "home_services").map((p) => p.id),
    ["pub_alpha", "pub_bravo"],
  );
});

test("findByCategory: no match returns an empty array — no nearest-neighbour fallback", () => {
  assert.deepEqual(findByCategory(FIXTURE, "crypto"), []);
  assert.deepEqual(findByCategory([], "saas"), []);
});

test("findByCategory: partial matching is OFF by default", () => {
  // "gutter" is a substring of "gutters" but is not the same category.
  assert.deepEqual(findByCategory(FIXTURE, "gutter"), []);
  assert.deepEqual(findByCategory(FIXTURE, "home"), []);
  assert.deepEqual(findByCategory(FIXTURE, "services"), []);
});

test("findByCategory: substring mode is opt-in and matches inside the token only", () => {
  const opts = { mode: "substring" } as const;
  assert.deepEqual(findByCategory(FIXTURE, "gutter", opts).map((p) => p.id), ["pub_alpha"]);
  assert.deepEqual(findByCategory(FIXTURE, "pump", opts).map((p) => p.id), ["pub_bravo"]);
  assert.deepEqual(
    findByCategory(FIXTURE, "services", opts).map((p) => p.id),
    ["pub_alpha", "pub_bravo"],
  );
  // Still no match when the query is nowhere in the token.
  assert.deepEqual(findByCategory(FIXTURE, "crypto", opts), []);
  // Direction is fixed: query inside category, not category inside query.
  assert.deepEqual(findByCategory(FIXTURE, "saas_platform", opts), []);
});

test("findByCategory: an empty or whitespace query matches nothing", () => {
  assert.deepEqual(findByCategory(FIXTURE, ""), []);
  assert.deepEqual(findByCategory(FIXTURE, "   "), []);
  assert.deepEqual(findByCategory(FIXTURE, "", { mode: "substring" }), []);
  assert.deepEqual(findByCategory(FIXTURE, "-", { mode: "substring" }), []);
});

test("publisherMatchesCategory: single-publisher predicate agrees with the filter", () => {
  const alpha = FIXTURE[0]!;
  assert.equal(publisherMatchesCategory(alpha, "gutters"), true);
  assert.equal(publisherMatchesCategory(alpha, "gutter"), false);
  assert.equal(publisherMatchesCategory(alpha, "gutter", { mode: "substring" }), true);
  assert.equal(publisherMatchesCategory(alpha, "saas"), false);
});

test("findByAnyCategory: unions the creative's categories, deduped, in registry order", () => {
  assert.deepEqual(
    findByAnyCategory(FIXTURE, ["saas", "gutters"]).map((p) => p.id),
    ["pub_alpha", "pub_charlie"],
  );
  // A publisher matching two of the queried categories still appears once.
  assert.deepEqual(
    findByAnyCategory(FIXTURE, ["home_services", "gutters"]).map((p) => p.id),
    ["pub_alpha", "pub_bravo"],
  );
  assert.deepEqual(findByAnyCategory(FIXTURE, []), []);
  assert.deepEqual(findByAnyCategory(FIXTURE, ["crypto", "nft"]), []);
});

test("rankByCategoryOverlap: ranks by overlap, omits non-matches, ties keep registry order", () => {
  const ranked = rankByCategoryOverlap(FIXTURE, ["home_services", "Gutters", "roof-drainage"]);

  assert.deepEqual(
    ranked.map((r) => [r.publisher.id, r.score]),
    [
      ["pub_alpha", 3],
      ["pub_bravo", 1],
    ],
  );
  assert.deepEqual(ranked[0]?.matched, ["home_services", "gutters", "roof_drainage"]);
  assert.deepEqual(ranked[1]?.matched, ["home_services"]);

  // Tie on score falls back to registry order.
  const tied = rankByCategoryOverlap(FIXTURE, ["home_services"]);
  assert.deepEqual(tied.map((r) => r.publisher.id), ["pub_alpha", "pub_bravo"]);

  // No overlap means no publisher — an empty result, not a default placement.
  assert.deepEqual(rankByCategoryOverlap(FIXTURE, ["crypto"]), []);
  assert.deepEqual(rankByCategoryOverlap(FIXTURE, []), []);
});

test("rankByCategoryOverlap: substring mode is opt-in here too", () => {
  assert.deepEqual(rankByCategoryOverlap(FIXTURE, ["pump"]), []);
  assert.deepEqual(
    rankByCategoryOverlap(FIXTURE, ["pump"], { mode: "substring" }).map((r) => r.publisher.id),
    ["pub_bravo"],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end: the seeded registry answers the pairing question
// ─────────────────────────────────────────────────────────────────────────────

test("seed registry: a dehumidifier creative pairs with exactly one publisher", async () => {
  const publishers = await loadRegistry();
  const ranked = rankByCategoryOverlap(publishers, ["dehumidification", "refrigeration"]);

  assert.equal(ranked[0]?.publisher.id, "pub_rink-ops");
  assert.equal(ranked[0]?.score, 2);
  assert.deepEqual(ranked.map((r) => r.publisher.id), ["pub_rink-ops"]);

  // A field-strength meter belongs on the loop site and nowhere else.
  assert.deepEqual(
    rankByCategoryOverlap(publishers, ["assistive_listening"]).map((r) => r.publisher.id),
    ["pub_loop-notes"],
  );

  // And a creative in a vertical we have no supply for pairs with nobody.
  assert.deepEqual(rankByCategoryOverlap(publishers, ["online_casino"]), []);
});
