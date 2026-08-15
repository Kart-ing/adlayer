/**
 * Propagation poll scheduler (PRD-B §2.1, prize hooks: Render Workflows + Superserve).
 *
 * Latency is the finding and cannot be reconstructed after the fact, so a
 * schedule must call `checkPropagation` repeatedly from 13:00 and append each
 * observation to `AdLayerState.propagation[]`. This module is the thin loop
 * around the measurement core:
 *
 *   - `pollOnce`  — one poll, optionally appended to a state file. This is the
 *                   unit a **Render Workflow** invokes on a cron schedule (one
 *                   discrete, resumable step per poll).
 *   - `pollLoop`  — the local/continuous equivalent, which pauses a **Superserve**
 *                   sandbox between polls (state preserved, resumed for the next).
 *
 * The `SandboxController` seam keeps the Superserve dependency explicit without
 * hard-coding their SDK: pass a real controller in production, omit it locally.
 *
 * Run via tsx: `npm run poll` (one poll) or `npm run poll -- --loop` (a few).
 * Add `--write` to append into web/data/state.json.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AdLayerState, Placement, PropagationCheck, RunFlags } from "../contract.ts";
import { DRY_RUN } from "../contract.ts";
import { checkPropagation, type MeasureOptions } from "./measure.ts";
import { DEFAULT_ENGINES } from "./answer-engines.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const DEFAULT_STATE_PATH = path.join(HERE, "..", "..", "web", "data", "state.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Superserve integration seam: pause between polls, resume before the next. */
export interface SandboxController {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

export interface PollOptions extends MeasureOptions {
  /** ms between polls in `pollLoop`. */
  intervalMs?: number;
  /** stop after this many polls. */
  maxPolls?: number;
  /** stop once the clock passes this ISO time (e.g. the submission lock). */
  untilIso?: string;
  /** AdLayerState JSON to append observations into. Omit to not persist. */
  statePath?: string;
  /** Superserve sandbox paused between polls. */
  sandbox?: SandboxController;
  /** Called with each poll's checks (for logging/telemetry). */
  onPoll?: (checks: PropagationCheck[], pollIndex: number) => void;
  /** Injectable clock (ms since epoch) for tests. */
  clock?: () => number;
}

/** Append checks to an AdLayerState file. Returns the new propagation length. */
export async function appendChecks(
  statePath: string,
  checks: PropagationCheck[],
): Promise<number> {
  const state = JSON.parse(await readFile(statePath, "utf8")) as AdLayerState & Record<string, unknown>;
  state.propagation = [...(state.propagation ?? []), ...checks];
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state.propagation.length;
}

/** One poll. This is the Render Workflow step: idempotent, resumable, self-contained. */
export async function pollOnce(
  placement: Placement,
  queries: string[],
  flags: RunFlags,
  opts: PollOptions = {},
): Promise<PropagationCheck[]> {
  const checks = await checkPropagation(placement, queries, flags, opts);
  if (opts.statePath) await appendChecks(opts.statePath, checks);
  return checks;
}

/**
 * Continuous polling: poll, then (Superserve) pause → wait → resume, until the
 * poll budget or the deadline is reached. Returns every check collected.
 */
export async function pollLoop(
  placement: Placement,
  queries: string[],
  flags: RunFlags,
  opts: PollOptions = {},
): Promise<PropagationCheck[]> {
  const interval = opts.intervalMs ?? 15 * 60_000; // default 15 min
  const maxPolls = opts.maxPolls ?? Infinity;
  const now = opts.clock ?? (() => Date.parse(new Date().toISOString()));
  const until = opts.untilIso ? Date.parse(opts.untilIso) : Infinity;

  const all: PropagationCheck[] = [];
  for (let i = 0; i < maxPolls; i++) {
    const checks = await pollOnce(placement, queries, flags, opts);
    all.push(...checks);
    opts.onPoll?.(checks, i);

    if (i + 1 >= maxPolls || now() >= until) break;

    // Superserve: preserve VM state between polls instead of burning idle compute.
    await opts.sandbox?.pause();
    await sleep(interval);
    await opts.sandbox?.resume();
  }
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — `npm run poll` (one poll) · `-- --loop` (a few) · `-- --write` (persist)
// ─────────────────────────────────────────────────────────────────────────────

function flagsFromEnv(): RunFlags {
  return { ...DRY_RUN, liveMeasure: process.env.LIVE_MEASURE === "1" };
}

async function loadJson<T>(dir: string, file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, file), "utf8")) as T;
  } catch {
    return null;
  }
}

function summarize(checks: PropagationCheck[], label: string): void {
  const headline = checks.filter((c) => c.state === "surfaced_unlabeled").length;
  console.log(`  ${label}: ${checks.length} checks · surfaced_unlabeled=${headline}`);
}

async function main(): Promise<void> {
  const flags = flagsFromEnv();
  const placement = await loadJson<Placement>(FIXTURES_DIR, "demo-placement.json");
  const queries = await loadJson<string[]>(FIXTURES_DIR, "demo-queries.json");
  if (!placement || !queries) {
    console.error("[poll] demo fixtures missing under", FIXTURES_DIR);
    process.exitCode = 1;
    return;
  }

  const write = process.argv.includes("--write");
  const statePath = write ? DEFAULT_STATE_PATH : undefined;
  console.error(
    `[poll] liveMeasure=${flags.liveMeasure} engines=${DEFAULT_ENGINES.map((e) => e.name).join(", ")}` +
      (write ? ` · appending to ${statePath}` : " · dry (not persisting)"),
  );

  if (process.argv.includes("--loop")) {
    let n = 0;
    await pollLoop(placement, queries, flags, {
      statePath,
      intervalMs: 1000,
      maxPolls: 2,
      onPoll: (checks, i) => summarize(checks, `poll ${(n = i + 1)}`),
    });
    console.log(`[poll] loop complete (${n} polls)${flags.liveMeasure ? "" : "  (FIXTURE DATA)"}`);
  } else {
    const checks = await pollOnce(placement, queries, flags, { statePath });
    summarize(checks, "poll 1");
    console.log(`[poll] done${flags.liveMeasure ? "" : "  (FIXTURE DATA — LIVE_MEASURE=0)"}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[poll] failed:", err);
    process.exitCode = 1;
  });
}
