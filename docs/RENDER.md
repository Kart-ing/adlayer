# Render — what needs doing, in order

**BLUF.** Three actions. The first unblocks the demo, the second protects $90 of study data, the third claims the $500 track.

---

## 1. Manual Deploy `adlayer-darkroom-commons` — do this first

**Why:** the first placement is committed and served, but the static site is still serving the pre-serve `llms.txt`. Until it deploys, the ad does not exist publicly, so neither the propagation measurement nor the live demo can run.

Service → **Manual Deploy → Deploy latest commit**.

Verify:

```bash
curl -s https://adlayer-darkroom-commons.onrender.com/llms.txt | grep -c "ad_id=ad_aeroflow"
# must print 1
```

## 2. Turn OFF auto-deploy on `adlayer-judge` — protects the study

**Why:** Render web services have **ephemeral disks**. The judging app stores responses in `data/submissions.jsonl`, so any redeploy wipes them. We already watched one restart destroy a test record, and there is now real money in that file — 20 participants at $4.50.

`adlayer-judge` → Settings → Build & Deploy → **Auto-Deploy: No**.

Leave it off until the study closes. A snapshot loop runs every 60s as a backstop, but the backstop should not be the plan.

**Do not redeploy this service while the study is live.**

## 3. Create the Workflow service — the $500 track

The guidebook is explicit: *"Projects must use Render Workflows to qualify for the winner prizes."* Hosting three static sites earns nothing on this track.

Code is committed at `workflow/index.ts` and typechecks clean. It registers two tasks with `@renderinc/sdk@0.6.0`:

| Task | What it does |
|---|---|
| `poll-propagation` | Asks answer engines whether a served placement surfaced, and whether `[SPONSORED]` survived. The headline measurement. 10-min timeout, 3 retries with backoff. |
| `snapshot-study` | Pulls the judging app's JSONL export off its ephemeral disk. 2-min timeout, 3 retries. |

**Why a Workflow rather than a cron job.** Propagation is fan-out shaped — engines × queries, each a slow network call with its own failure profile — and each poll must be independently retryable without re-running the ones that already succeeded. An engine timing out is *not* evidence of absence, and recording it as `absent` would understate the exact thing we are measuring. That is what the retry policy on `poll-propagation` is for.

**Scheduling.** Render Workflows do not yet schedule themselves — Render's own docs say to *"create a cron job that invokes your workflow tasks on your desired schedule."* So the shape is: **cron job → triggers workflow task**. That split is their documented pattern, not a workaround.

### Setting it up

1. **New → Workflow**, point it at `Kart-ing/adlayer`, root directory `.` (it imports from `src/`).
2. Build: `npm ci` · Start: `npx tsx workflow/index.ts`
3. Env vars it needs:
   - `OPENROUTER_API_KEY` — sonar, the live-retrieval engine. **This is the one that matters**; it is the engine that can surface a page minutes after serving.
   - `OPENAI_API_KEY` — the slow ingestion-based control arm
   - `JUDGE_EXPORT_URL` — optional, defaults to the live judge export
4. **New → Cron Job** to invoke the tasks on an interval (every 10 min is sensible while the study runs).

I could not confirm the exact `render.yaml` service type for a Workflow from the public docs, so this is a dashboard setup rather than a Blueprint entry. If the dashboard exposes a Blueprint snippet, paste it into `render.yaml` and it becomes reproducible.

## Already done

| Service | State |
|---|---|
| `adlayer-rink-ops` | live, `llms.txt` 200, slot present, 4/4 AI crawlers allowed |
| `adlayer-darkroom-commons` | live, **awaiting manual deploy for the ad** |
| `adlayer-loop-notes` | live, verified |
| `adlayer-judge` | live, verified end-to-end, study running against it |
