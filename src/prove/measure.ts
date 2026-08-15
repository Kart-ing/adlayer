/**
 * Propagation measurement (PRD-B §2.1).
 *
 * `checkPropagation` runs one poll: for every (engine × query) it observes an
 * answer, classifies it against the exact placement, and returns a
 * PropagationCheck per the contract. Latency is the finding — it is stamped from
 * `served_at` to the observation time and cannot be reconstructed after the fact,
 * so a scheduler must call this repeatedly from 13:00 (the Render Workflow /
 * Superserve poll loop is a thin wrapper around this function).
 *
 * Live retrieval (perplexity/sonar) is polled FIRST and reported separately from
 * the ingestion control arm (openai) — never averaged; they measure different
 * mechanisms (PRD-B §2.1).
 *
 * `flags.liveMeasure === false` reads fixtures and hits no network, so the demo
 * re-runs offline. Every live answer is cached to disk by the engine adapters.
 *
 * Run via tsx: `npm run measure` (LIVE_MEASURE=0 by default).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Placement, PropagationCheck, RunFlags } from "../contract.ts";
import { DRY_RUN } from "../contract.ts";
import { classify, type BaselineObservation } from "./classify-propagation.ts";
import { DEFAULT_ENGINES, type EngineDef } from "./answer-engines.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const EXCERPT_LEN = 320;

export interface MeasureOptions {
  /** Engines to poll. Defaults to sonar (live) then openai (ingestion). */
  engines?: EngineDef[];
  /** Injectable clock (ISO string) for deterministic tests. */
  now?: () => string;
  /** Override the fixtures directory (offline mode + baseline). */
  fixturesDir?: string;
}

/** One recorded fixture answer, keyed `${engine}:${query}` in propagation.json. */
interface FixtureAnswer {
  answerText: string;
  citedUrls: string[];
  /** Optional recorded observation time, so offline latency is deterministic. */
  checked_at?: string;
}

/** Baseline map keyed `${engine}:${query}` — pre-serve organic presence per engine. */
type BaselineMap = Record<string, BaselineObservation>;

function keyFor(engine: string, query: string): string {
  return `${engine}:${query.trim().toLowerCase()}`;
}

function excerpt(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT_LEN ? `${t.slice(0, EXCERPT_LEN - 1)}…` : t;
}

function minutesBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 60_000));
}

async function loadJson<T>(dir: string, file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, file), "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Poll every engine × query once and classify each observation.
 *
 * @param placement The exact placement served (provenance source of truth).
 * @param queries   The queries to test.
 * @param flags     `liveMeasure` gates network vs fixtures.
 */
export async function checkPropagation(
  placement: Placement,
  queries: string[],
  flags: RunFlags,
  opts: MeasureOptions = {},
): Promise<PropagationCheck[]> {
  const engines = opts.engines ?? DEFAULT_ENGINES;
  const dir = opts.fixturesDir ?? FIXTURES_DIR;
  const now = opts.now ?? (() => new Date().toISOString());

  const baseline = (await loadJson<BaselineMap>(dir, "baseline.json")) ?? {};
  const fixtures = flags.liveMeasure
    ? null
    : (await loadJson<Record<string, FixtureAnswer>>(dir, "propagation.json")) ?? {};

  const checks: PropagationCheck[] = [];

  // Live retrieval first, then the ingestion control arm — order preserved.
  for (const engine of engines) {
    for (const query of queries) {
      const key = keyFor(engine.name, query);

      let answerText = "";
      let citedUrls: string[] = [];
      let checkedAt = now();

      if (flags.liveMeasure) {
        const ans = await engine.ask(query);
        answerText = ans.answerText;
        citedUrls = ans.citedUrls;
      } else {
        const fx = fixtures?.[key];
        if (fx) {
          answerText = fx.answerText;
          citedUrls = fx.citedUrls;
          if (fx.checked_at) checkedAt = fx.checked_at;
        }
      }

      const base = baseline[key];
      const state = classify(answerText, citedUrls, placement, base);
      const latency_minutes =
        state === "absent" ? null : minutesBetween(placement.served_at, checkedAt);

      checks.push({
        placement_id: placement.id,
        query,
        engine: engine.name,
        checked_at: checkedAt,
        state,
        answer_excerpt: excerpt(answerText),
        cited_urls: citedUrls,
        latency_minutes,
      });
    }
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo runner — `npm run measure`. Offline by default (LIVE_MEASURE=0).
// ─────────────────────────────────────────────────────────────────────────────

function flagsFromEnv(): RunFlags {
  return { ...DRY_RUN, liveMeasure: process.env.LIVE_MEASURE === "1" };
}

async function runDemo(): Promise<void> {
  const flags = flagsFromEnv();
  const placement = await loadJson<Placement>(FIXTURES_DIR, "demo-placement.json");
  const queries = await loadJson<string[]>(FIXTURES_DIR, "demo-queries.json");
  if (!placement || !queries) {
    console.error("[measure] demo fixtures missing under", FIXTURES_DIR);
    process.exitCode = 1;
    return;
  }

  console.error(
    `[measure] liveMeasure=${flags.liveMeasure} placement=${placement.id} ` +
      `queries=${queries.length} engines=${DEFAULT_ENGINES.map((e) => e.name).join(", ")}`,
  );

  const checks = await checkPropagation(placement, queries, flags);

  // Report the two mechanisms separately — never averaged (PRD-B §2.1).
  for (const kind of ["live_retrieval", "ingestion"] as const) {
    const names = DEFAULT_ENGINES.filter((e) => e.kind === kind).map((e) => e.name);
    const rows = checks.filter((c) => names.includes(c.engine));
    console.log(`\n=== ${kind.toUpperCase()} (${names.join(", ")}) ===`);
    for (const c of rows) {
      const lat = c.latency_minutes === null ? "—" : `${c.latency_minutes}m`;
      const flag = c.state === "surfaced_unlabeled" ? "  ⚠ HEADLINE" : "";
      console.log(`  [${c.state.padEnd(18)}] ${lat.padStart(4)}  ${c.engine}  · "${c.query}"${flag}`);
    }
  }

  const headline = checks.filter((c) => c.state === "surfaced_unlabeled").length;
  console.log(
    `\n[measure] ${checks.length} checks · surfaced_unlabeled=${headline}` +
      (flags.liveMeasure ? "" : "  (FIXTURE DATA — LIVE_MEASURE=0)"),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runDemo().catch((err) => {
    console.error("[measure] demo failed:", err);
    process.exitCode = 1;
  });
}
