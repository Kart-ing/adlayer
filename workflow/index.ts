/**
 * ADLAYER — Render Workflows service.
 *
 * Two tasks, both load-bearing rather than decorative:
 *
 *   poll-propagation  asks answer engines whether a served placement surfaced,
 *                     and whether the [SPONSORED] label survived the model.
 *                     This is the project's headline measurement.
 *
 *   snapshot-study    copies the live judging app's JSONL export off its
 *                     ephemeral disk. Render web services lose the filesystem
 *                     on restart, and we watched one restart wipe it, so the
 *                     union of snapshots is the source of truth for study
 *                     responses -- not the server.
 *
 * Why a Workflow and not a cron job: propagation is a long-running,
 * fan-out-shaped measurement (engines x queries, each a slow network call with
 * its own retry profile), and each poll has to be independently retryable
 * without re-running the ones that already succeeded. Render Workflows do not
 * yet schedule themselves, so a Render cron job invokes these on an interval --
 * that split is Render's documented pattern, not a workaround.
 */

import { task, startTaskServer } from "@renderinc/sdk/workflows";

import { DRY_RUN } from "../src/contract.ts";
import type { Placement, PropagationCheck } from "../src/contract.ts";
import { checkPropagation } from "../src/prove/measure.ts";

import { DEFAULT_QUERIES } from "./targets.ts";

const JUDGE_EXPORT =
  process.env["JUDGE_EXPORT_URL"] ?? "https://adlayer-judge.onrender.com/api/export";

/**
 * Measure whether a placement propagated into answer-engine output.
 *
 * Retried rather than failed on a network wobble: an engine timing out is not
 * evidence of absence, and recording it as `absent` would understate the very
 * thing we are measuring.
 */
export const pollPropagation = task(
  {
    name: "poll-propagation",
    timeoutSeconds: 600,
    retry: { maxRetries: 3, waitDurationMs: 15_000, backoffScaling: 2 },
  },
  async (placement: Placement, queries: string[] = DEFAULT_QUERIES): Promise<{
    checked_at: string;
    placement_id: string;
    checks: PropagationCheck[];
    summary: Record<string, number>;
  }> => {
    const flags = { ...DRY_RUN, liveMeasure: true };
    const checks = await checkPropagation(placement, queries, flags);

    // Counting by state rather than reporting a single number: `absent` and
    // `surfaced_unlabeled` are opposite findings and must never be averaged.
    const summary: Record<string, number> = {};
    for (const c of checks) summary[c.state] = (summary[c.state] ?? 0) + 1;

    return {
      checked_at: new Date().toISOString(),
      placement_id: placement.id,
      checks,
      summary,
    };
  },
);

/**
 * Pull the judging app's export so responses survive its ephemeral disk.
 *
 * Returns the rows rather than writing to local disk, because a workflow
 * instance's filesystem is no more durable than the web service's. The caller
 * persists.
 */
export const snapshotStudy = task(
  {
    name: "snapshot-study",
    timeoutSeconds: 120,
    retry: { maxRetries: 3, waitDurationMs: 5_000 },
  },
  async (): Promise<{ captured_at: string; rows: unknown[]; count: number }> => {
    const res = await fetch(JUDGE_EXPORT, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`judge export returned ${res.status}`);

    const text = await res.text();
    const rows = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return { _unparseable: l };
        }
      });

    return { captured_at: new Date().toISOString(), rows, count: rows.length };
  },
);

await startTaskServer();
