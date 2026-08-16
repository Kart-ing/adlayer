/**
 * Invokes the AdLayer workflow tasks. This is what the Render Cron Job runs.
 *
 *   npx tsx workflow/trigger.ts
 *
 * Render Workflows do not schedule themselves — their docs say to "create a
 * cron job that invokes your workflow tasks on your desired schedule", so this
 * is the invoking half of that pair.
 *
 * Needs RENDER_API_KEY (the SDK client reads it). On a Render Cron Job in the
 * same workspace it is usually present already; set it explicitly if not.
 *
 * Exits non-zero only if BOTH tasks fail. One engine being unreachable is not a
 * reason to mark the whole run failed and have Render retry the half that
 * already worked.
 */

import { createWorkflowsClient } from "@renderinc/sdk/workflows";

import { DEFAULT_QUERIES, PLACEMENT } from "./targets.ts";

async function main(): Promise<void> {
  const client = createWorkflowsClient();
  const results: { task: string; ok: boolean; detail: string }[] = [];

  for (const [task, input] of [
    ["poll-propagation", [PLACEMENT, DEFAULT_QUERIES]],
    ["snapshot-study", []],
  ] as const) {
    try {
      const run = await client.runTask(task, input as unknown[]);
      results.push({ task, ok: true, detail: JSON.stringify(run).slice(0, 400) });
      console.log(`[trigger] ${task}: ok`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ task, ok: false, detail });
      console.error(`[trigger] ${task}: FAILED — ${detail}`);
    }
  }

  console.log(JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2));
  if (results.every((r) => !r.ok)) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`[trigger] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
