# judge — Terac judging surface

The public app Terac participants are sent to. Built on the **svg-arena pattern**
(Terac's reference implementation for the generate → humans-judge → improve loop):
participant attribution, a judging UI, and JSONL export.

## The loop

1. `terac_launch_draft_opportunity` points the task URL at this deployment.
2. Terac appends `?submissionId=…&taskId=…`. We capture it **client-side** (the
   page's query string, `lib/attribution.ts` → `page.tsx`) and **server-side**
   (the `Referer` header in `app/api/vote/route.ts`).
3. Each participant sees one blindly-assigned arm (`labeled` / `unlabeled` /
   `labeled_prominent`, stable per `submissionId`) and answers two neutral
   questions from `data/study-spec.json`.
4. Responses append to `data/submissions.jsonl`.
5. `GET /api/export` returns that JSONL — exactly the shape
   `src/prove/terac.ts` `aggregateSubmissions` consumes → the Terac before/after.

## Deploy before launching the study

The task URL must be live **before** `terac_launch_draft_opportunity`, or
responses have nowhere to land. Deploy on Render, then feed the deployed URL to
the launch call.

## Regenerate the study spec

The task content is generated from the single source of truth
(`src/prove/study-design.ts`):

```bash
npm run gen:study-spec   # from the repo root → writes judge/data/study-spec.json
```

## Local

```bash
npm install
npm run dev
# open http://localhost:3000/?submissionId=demo_1&taskId=t_1
```
