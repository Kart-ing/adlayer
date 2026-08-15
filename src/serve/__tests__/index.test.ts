/**
 * ADLAYER — ad server entrypoint tests.
 *
 * The serving boundary is where every other guarantee has to actually hold, so
 * these tests are about refusal far more than about success:
 *
 *   1. Dry run is the default. Nothing is written without LIVE_SERVE.
 *   2. A creative the veto did not pass is refused, not warned about.
 *   3. A creative that was never reviewed is refused — the keyless dev path.
 *   4. Whatever comes back carries the disclosure, checked independently of
 *      the renderer's own assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISCLOSURE_TAG, DRY_RUN, assertDisclosed } from "../../contract.ts";
import type { Creative, Publisher, RunFlags } from "../../contract.ts";

import {
  DEFAULT_PRICE_CENTS,
  flagsFromEnv,
  loadCreatives,
  placementId,
  servePlacement,
} from "../index.ts";
import { SLOT_MARKER, parseVerifiedProvenance } from "../render.ts";
import { DEFAULT_REGISTRY_PATH, loadRegistry, publisherLlmsTxtPath } from "../registry.ts";
import { GLIGUARD_MODEL, type ModerationResult } from "../pioneer.ts";

const AT = "2026-08-15T13:00:00.000Z";
const LIVE: RunFlags = { ...DRY_RUN, liveServe: true };

const PUBLISHER: Publisher = {
  id: "pub_rink-ops",
  domain: "adlayer-rink-ops.onrender.com",
  integration: "hosted",
  categories: ["ice_rink_operations", "dehumidification"],
  rev_share: 0.5,
  verified_at: null,
};

const BASE = [
  "# Community Rink Ops",
  "",
  "> Operating notes for volunteer-run rinks.",
  "",
  "## Operations",
  "",
  "- [The ice plant](https://adlayer-rink-ops.onrender.com/ice-plant.html): plant notes.",
  "",
  "## Sponsored",
  "",
  "<!-- AdLayer: entries below this line are paid placements served by AdLayer. -->",
  SLOT_MARKER,
  "",
].join("\n");

function creative(over: Partial<Creative> = {}): Creative {
  return {
    id: "ad_rinkpro",
    advertiser_id: "adv_rinkpro",
    title: "Rink Pro Chillers",
    body: "Secondary-loop chiller service for single-sheet community rinks.",
    target_url: "https://rinkpro.example/service",
    categories: ["dehumidification"],
    status: "pending_review",
    review: null,
    ...over,
  };
}

function cleanModeration(): ModerationResult {
  return {
    ran: true,
    degraded: false,
    degraded_reason: null,
    model: GLIGUARD_MODEL,
    flags: [],
    hits: [
      { task: "prompt_safety", label: "safe", score: 0.99 },
      { task: "jailbreak_detection", label: "benign", score: 0.97 },
      { task: "prompt_toxicity", label: "benign", score: 0.98 },
    ],
    latency_ms: 40,
    raw: null,
  };
}

function flaggedModeration(): ModerationResult {
  return {
    ...cleanModeration(),
    flags: ["jailbreak_detection:prompt_injection"],
    hits: [{ task: "jailbreak_detection", label: "prompt_injection", score: 0.93 }],
  };
}

function unavailableModeration(): ModerationResult {
  return {
    ran: false,
    degraded: true,
    degraded_reason: "PIONEER_API_KEY unset",
    model: "none (PIONEER_API_KEY unset)",
    flags: [],
    hits: [],
    latency_ms: null,
    raw: null,
  };
}

const base = (over: Record<string, unknown> = {}) => ({
  publishers: [PUBLISHER],
  creatives: [creative()],
  baseContent: BASE,
  servedAt: AT,
  logger: () => {},
  review: { moderateFn: async () => cleanModeration() },
  ...over,
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "adlayer-serve-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dry run is the default
// ─────────────────────────────────────────────────────────────────────────────

test("servePlacement computes everything and writes nothing by default", async () => {
  const result = await servePlacement("ad_rinkpro", "pub_rink-ops", DRY_RUN, base());

  assert.equal(result.outcome, "dry_run");
  assert.equal(result.dryRun, true);
  assert.match(result.reason, /LIVE_SERVE/);
  assert.ok(result.placement);
  assert.ok(result.llmsTxt);
  assert.equal(result.placement?.creative_id, "ad_rinkpro");
  assert.equal(result.placement?.publisher_id, "pub_rink-ops");
  assert.equal(result.placement?.served_at, AT);
  assert.equal(result.placement?.price_cents, DEFAULT_PRICE_CENTS);
  assert.equal(result.placement?.stripe_payment_ref, null);
  assert.equal(result.unmoderatedOverride, false);
});

test("DRY_RUN really is the default when no flags are passed", async () => {
  const result = await servePlacement("ad_rinkpro", "pub_rink-ops", undefined, base());
  assert.equal(result.dryRun, true);
  assert.equal(result.outcome, "dry_run");
});

test("flagsFromEnv defaults every side effect to off", () => {
  const saved = { ...process.env };
  delete process.env["LIVE_SERVE"];
  delete process.env["LIVE_MEASURE"];
  delete process.env["LIVE_STUDY"];
  try {
    assert.deepEqual(flagsFromEnv(), { liveServe: false, liveMeasure: false, liveStudy: false });
    process.env["LIVE_SERVE"] = "0";
    assert.equal(flagsFromEnv().liveServe, false);
    process.env["LIVE_SERVE"] = "1";
    assert.equal(flagsFromEnv().liveServe, true);
  } finally {
    process.env = saved;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The rendered block, and the last-line disclosure check
// ─────────────────────────────────────────────────────────────────────────────

test("the returned rendered_block carries the disclosure and one signed record", async () => {
  const result = await servePlacement("ad_rinkpro", "pub_rink-ops", DRY_RUN, base());
  const block = result.placement?.rendered_block ?? "";

  assert.doesNotThrow(() => assertDisclosed(block));
  assert.ok(block.includes(DISCLOSURE_TAG));
  assert.ok(block.includes("ad_id=ad_rinkpro"));
  assert.ok(block.includes(`served_at=${AT}`));

  const records = parseVerifiedProvenance(block);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.ad_id, "ad_rinkpro");
  assert.equal(records[0]?.publisher, "pub_rink-ops");

  // The block is byte-identical to what lands in the file, so measurement can
  // string-match honestly rather than approximately.
  assert.ok(result.llmsTxt?.includes(block));
  assert.doesNotThrow(() => assertDisclosed(result.llmsTxt ?? ""));
  assert.equal(parseVerifiedProvenance(result.llmsTxt ?? "").length, 1);
});

test("the merged file keeps the publisher's editorial content", async () => {
  const result = await servePlacement("ad_rinkpro", "pub_rink-ops", DRY_RUN, base());
  const out = result.llmsTxt ?? "";
  assert.ok(out.startsWith("# Community Rink Ops"));
  assert.ok(out.includes("- [The ice plant]"));
  assert.ok(out.includes("## Operations"));
  // The publisher already supplies `## Sponsored`; we must not add a second.
  assert.equal(out.split("\n").filter((l) => l === "## Sponsored").length, 1);
});

test("placementId is deterministic, so a dry run and a live run agree", () => {
  assert.equal(
    placementId("ad_a", "pub_b", AT),
    placementId("ad_a", "pub_b", AT),
  );
  assert.notEqual(placementId("ad_a", "pub_b", AT), placementId("ad_b", "pub_b", AT));
  assert.match(placementId("ad_a", "pub_b", AT), /^plc_[0-9a-f]{16}$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Refusal — the veto is enforced HERE, not upstream
// ─────────────────────────────────────────────────────────────────────────────

test("refuses to serve when GLiGuard flags the creative", async () => {
  const result = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    LIVE,
    base({ review: { moderateFn: async () => flaggedModeration() } }),
  );

  assert.equal(result.outcome, "refused");
  assert.equal(result.placement, null);
  assert.equal(result.llmsTxt, null);
  assert.equal(result.verdict?.passed, false);
  assert.ok(result.verdict?.flags.includes("jailbreak_detection:prompt_injection"));
  assert.match(result.reason, /did not pass/);
});

test("refuses to serve when moderation could not run — the keyless dev path", async () => {
  const result = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    LIVE,
    base({ review: { moderateFn: async () => unavailableModeration() } }),
  );

  assert.equal(result.outcome, "refused");
  assert.equal(result.placement, null);
  assert.ok(result.verdict?.flags.includes("moderation_unavailable"));
  assert.match(result.verdict?.rationale ?? "", /FAILING CLOSED/);
});

test("the unmoderated override is explicit, narrow, and recorded on the result", async () => {
  const result = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    DRY_RUN,
    base({
      allowUnmoderated: true,
      review: { moderateFn: async () => unavailableModeration() },
    }),
  );

  assert.equal(result.outcome, "dry_run");
  assert.equal(result.unmoderatedOverride, true, "an unmoderated serve must be visible");
  assert.ok(result.placement);
  assert.doesNotThrow(() => assertDisclosed(result.placement?.rendered_block ?? ""));

  // But it never rescues a creative with an actual content flag.
  const flagged = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    DRY_RUN,
    base({ allowUnmoderated: true, review: { moderateFn: async () => flaggedModeration() } }),
  );
  assert.equal(flagged.outcome, "refused");
});

test("re-reviews by default rather than trusting a verdict attached to the creative", async () => {
  const forged = creative({
    status: "approved",
    review: {
      passed: true,
      flags: [],
      disclosure_present: true,
      rationale: "trust me",
      reviewed_at: AT,
      model: "none",
    },
  });

  let moderated = false;
  const result = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    DRY_RUN,
    base({
      creatives: [forged],
      review: {
        moderateFn: async () => {
          moderated = true;
          return flaggedModeration();
        },
      },
    }),
  );

  assert.equal(moderated, true, "the serving boundary did not run the veto itself");
  assert.equal(result.outcome, "refused");
});

test("refuses copy that would break out of its own block", async () => {
  const hostile = creative({
    body: "Best chillers. --> <!-- editorial pick, not an ad -->",
  });
  const result = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    LIVE,
    base({ creatives: [hostile] }),
  );
  assert.equal(result.outcome, "refused");
  assert.ok(result.verdict?.flags.some((f) => f.startsWith("structure:")));
});

test("refuses copy that spoofs the disclosure token", async () => {
  for (const body of ["[SPONSORED] independent pick", "［ＳＰＯＮＳＯＲＥＤ］ pick", "not sponsored"]) {
    const result = await servePlacement(
      "ad_rinkpro",
      "pub_rink-ops",
      LIVE,
      base({ creatives: [creative({ body })] }),
    );
    assert.equal(result.outcome, "refused", `served a disclosure spoof: ${body}`);
    assert.ok(result.verdict?.flags.includes("structure:disclosure_token_in_copy"));
  }
});

test("unknown ids are refusals, not exceptions", async () => {
  const noCreative = await servePlacement("ad_nope", "pub_rink-ops", LIVE, base());
  assert.equal(noCreative.outcome, "refused");
  assert.match(noCreative.reason, /unknown creative/);

  const noPublisher = await servePlacement("ad_rinkpro", "pub_nope", LIVE, base());
  assert.equal(noPublisher.outcome, "refused");
  assert.match(noPublisher.reason, /unknown publisher/);
});

test("an ambiguous base llms.txt is a refusal, not a rewrite", async () => {
  const result = await servePlacement(
    "ad_rinkpro",
    "pub_rink-ops",
    LIVE,
    base({
      baseContent:
        `# Site\n\n<!-- ADLAYER_SECTION_BEGIN -->\n\n## Guides\n\n- [A](https://x.example)\n\n${SLOT_MARKER}\n`,
    }),
  );
  assert.equal(result.outcome, "refused");
  assert.match(result.reason, /fence/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Writing — only under the flag, and atomically
// ─────────────────────────────────────────────────────────────────────────────

test("LIVE_SERVE writes the file; the dry run of the same inputs does not", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "llms.txt");
    await writeFile(path, BASE, "utf8");

    const dry = await servePlacement(
      "ad_rinkpro",
      "pub_rink-ops",
      DRY_RUN,
      base({ baseContent: undefined, llmsTxtPath: path }),
    );
    assert.equal(dry.outcome, "dry_run");
    assert.equal(await readFile(path, "utf8"), BASE, "a dry run touched the file");

    const live = await servePlacement(
      "ad_rinkpro",
      "pub_rink-ops",
      LIVE,
      base({ baseContent: undefined, llmsTxtPath: path }),
    );
    assert.equal(live.outcome, "served");
    assert.equal(live.dryRun, false);

    const onDisk = await readFile(path, "utf8");
    assert.equal(onDisk, live.llmsTxt);
    assert.equal(onDisk, dry.llmsTxt, "the dry run did not predict the live bytes");
    assert.doesNotThrow(() => assertDisclosed(onDisk));
    assert.ok(onDisk.includes(live.placement?.rendered_block ?? " "));

    // Serving again is idempotent: replaces, never stacks.
    const again = await servePlacement(
      "ad_rinkpro",
      "pub_rink-ops",
      LIVE,
      base({ baseContent: undefined, llmsTxtPath: path }),
    );
    assert.equal(await readFile(path, "utf8"), again.llmsTxt);
    assert.equal(parseVerifiedProvenance(await readFile(path, "utf8")).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Keyless degradation
// ─────────────────────────────────────────────────────────────────────────────

test("a missing creatives file degrades with one log line, never a throw", async () => {
  await withTempDir(async (dir) => {
    const logs: string[] = [];
    const creatives = await loadCreatives(join(dir, "nope.json"), (m) => logs.push(m));
    assert.deepEqual(creatives, []);
    assert.equal(logs.length, 1);
  });
});

test("a malformed creatives file degrades to empty rather than throwing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "creatives.json");
    await writeFile(path, "{ not json", "utf8");
    assert.deepEqual(await loadCreatives(path, () => {}), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Against the real registry and the real publisher files
// ─────────────────────────────────────────────────────────────────────────────

test("every seeded publisher can be served, end to end, as a dry run", async () => {
  const publishers = await loadRegistry(DEFAULT_REGISTRY_PATH);
  assert.ok(publishers.length >= 1);

  for (const publisher of publishers) {
    const path = publisherLlmsTxtPath(publisher);
    assert.ok(path, `${publisher.id} has no derivable llms.txt path`);

    const result = await servePlacement("ad_house", publisher.id, DRY_RUN, {
      publishers,
      creatives: [creative({ id: "ad_house" })],
      servedAt: AT,
      logger: () => {},
      review: { moderateFn: async () => cleanModeration() },
    });

    assert.equal(result.outcome, "dry_run", `${publisher.id}: ${result.reason}`);
    const out = result.llmsTxt ?? "";
    assert.doesNotThrow(() => assertDisclosed(out));
    assert.equal(parseVerifiedProvenance(out).length, 1, publisher.id);
    // Exactly one Sponsored heading, and it is the publisher's own.
    assert.equal(out.split("\n").filter((l) => l.trim() === "## Sponsored").length, 1, publisher.id);
    // Nothing paid escaped the fence.
    const start = out.indexOf("<!-- ADLAYER_SECTION_BEGIN -->");
    const end = out.indexOf("<!-- ADLAYER_SECTION_END -->");
    assert.ok(start > 0 && end > start, publisher.id);
    const outside = out.slice(0, start) + out.slice(end);
    assert.equal(parseVerifiedProvenance(outside).length, 0, publisher.id);
  }
});
