# Render Workflow — setup runbook

**BLUF.** Create one Workflow service and one Cron Job. The code is already written, committed, and typechecks clean. This is dashboard configuration, not development.

**Why it matters:** the guidebook says *"Projects must use Render Workflows to qualify for the winner prizes."* We host three static sites and a web service, and **none of that counts**. This is the only thing that claims the track.

**Owner:** Parth. **Time:** ~15 minutes. **Prize:** $500 (1st) / $300 / $100 in Render credits.

---

## Before you start

Two other Render actions come first, in this order. Both are in `docs/RENDER.md`.

1. **Manual Deploy `adlayer-darkroom-commons`.** The first ad placement is committed and served but the live site still serves the pre-serve `llms.txt`. Nothing can be measured until it deploys.
2. **`adlayer-judge` → Settings → Build & Deploy → Auto-Deploy: No.** Render web services have ephemeral disks. That service holds live study responses (20 participants × $4.50), and any push to `main` can redeploy it and wipe them.

## What already exists

`workflow/index.ts`, on `main`. It registers two tasks with `@renderinc/sdk@0.6.0`:

| Task | Purpose | Timeout | Retry |
|---|---|---|---|
| `poll-propagation` | Ask answer engines whether a served placement surfaced, and whether `[SPONSORED]` survived the model | 600s | 3, 15s, ×2 backoff |
| `snapshot-study` | Pull the judging app's JSONL export off its ephemeral disk | 120s | 3, 5s |

The file ends with `await startTaskServer()`, which is what Render connects to.

## Step 1 — create the Workflow service

**Dashboard → New → Workflow**

| Field | Value |
|---|---|
| Repository | `Kart-ing/adlayer` |
| Branch | `main` |
| Root directory | `.` (repo root — the task file imports from `src/`) |
| Build command | `npm ci` |
| Start command | `npx tsx workflow/index.ts` |

**Root directory must be `.`**, not `workflow/`. The tasks import `src/prove/measure.ts` and `src/contract.ts`; a narrower root cannot see them.

## Step 2 — environment variables

| Key | Value | Why |
|---|---|---|
| `OPENROUTER_API_KEY` | from `.env` | **The one that matters.** Routes to `perplexity/sonar`, which does live retrieval at query time and can surface a page minutes after it is served. |
| `OPENAI_API_KEY` | from `.env` | The slow, ingestion-based control arm. Reported separately, never averaged with sonar. |
| `JUDGE_EXPORT_URL` | *(optional)* | Defaults to the live judge export. |

Ask Kartikey for the values — they are in `.env`, which is gitignored and must stay that way.

## Step 3 — create the Cron Job

Render Workflows **do not schedule themselves**. Render's own docs: *"Workflows do not yet natively support scheduling task runs. To schedule, create a cron job that invokes your workflow tasks on your desired schedule."*

**Dashboard → New → Cron Job**, same repo, invoking the workflow tasks.

Every **10 minutes** while the study and the propagation window are open. Propagation latency is the finding, so a coarse interval blurs the measurement; a very tight one just burns engine credits without adding resolution.

## Step 4 — verify

A run is healthy when:

- the service logs show both task names registered at startup
- `poll-propagation` returns a `summary` object counting states, e.g. `{ "absent": 6 }`
- `snapshot-study` returns a `count` matching the live export

```bash
curl -s https://adlayer-judge.onrender.com/api/export | wc -l
```

**`{"absent": 6}` is a successful run, not a failure.** Absence is a real finding — see below.

## What the results mean

`poll-propagation` counts observations **by state** and never reduces them to one number, because two of the states are opposite findings:

| State | Meaning |
|---|---|
| `surfaced_labeled` | The ad reached the answer **and the disclosure survived**. Honest agent advertising works. |
| `surfaced_unlabeled` | The ad reached the answer **and the model stripped the label**. This is the headline finding. |
| `absent` | The engine did not surface it. Publishable: it means llms.txt does not move that engine on this timescale. |
| `cited_unattributed` | The domain was cited but the copy did not come from our block — **not** propagation. |

All four are results. Do not treat `absent` as a broken run and retry it away.

## If something breaks

**Build fails on `npm ci`** — the lockfile is out of sync. Run `npm install` locally, commit `package-lock.json`.

**Tasks do not register** — check the start command runs the file that calls `startTaskServer()`. `npx tsx workflow/index.ts`, from repo root.

**Every check returns `absent`** — first confirm the ad is actually live:
```bash
curl -s https://adlayer-darkroom-commons.onrender.com/llms.txt | grep -c "ad_id=ad_aeroflow"   # must print 1
```
If that prints `0`, step 1 of "Before you start" has not happened and there is nothing to find.

**Engine errors / timeouts** — expected, and handled. The retry policy exists because a timeout is *not* evidence of absence, and recording it as `absent` would understate exactly what we are measuring.

## Note

I could not confirm the `render.yaml` service type for a Workflow from Render's public docs, so this is deliberately a dashboard setup rather than a guessed Blueprint entry. If the dashboard shows you a Blueprint snippet, paste it into `render.yaml` and the whole thing becomes reproducible.
