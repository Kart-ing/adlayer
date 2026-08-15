/**
 * Terac trust study orchestration (PRD-B §2.3, docs/TERAC.md).
 *
 * Panel latency is 5–6h, so the three variants launch as PARALLEL ARMS of one
 * study, not sequential rounds. The mandatory before/after is predicted-vs-actual:
 *   before = the model's predicted human verdict, FROZEN pre-study
 *            (src/prove/fixtures/predicted-verdict.json)
 *   after  = the actual human verdict from Terac submissions
 *   change = the disclosure-format change the Format agent ships because of it
 *
 * Transport: the live path is the Terac MCP (interactive OAuth — a human connects
 * it once; it cannot be scripted headlessly). This module owns the parts that ARE
 * code: freezing the prediction, aggregating raw submissions into a TrustStudy,
 * and computing the before/after deltas + the format decision. The MCP call order
 * (get_context → request_feasibility → create_opportunity → launch_draft_opportunity
 * with the deployed judge URL → get_submissions) is driven by the agent; feed the
 * returned submissions into `aggregateSubmissions`.
 *
 * `runStudy` / `runStudyArms` respect `LIVE_STUDY`. NEVER fabricate: with the flag
 * off, results are fixtures, self-evidently marked (id prefixed `fixture_`, and a
 * [FIXTURE] banner in the verbatims). With the flag on, results come only from
 * real submissions — if none are supplied, it throws rather than inventing them.
 *
 * Imports only contract + study-design + node builtins, so it runs under `node --test`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RunFlags, TeracBeforeAfter, TrustStudy } from "../contract.ts";
import { DRY_RUN } from "../contract.ts";
import {
  STUDY_QUESTIONS,
  VARIANT_NAMES,
  assertNeutralWording,
  type StudyVariant,
} from "./study-design.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");

/** The headline comparison surfaced as AdLayerState.terac — the stripped-label arm. */
export const HEADLINE_VARIANT: StudyVariant = "unlabeled";

/** One raw judging response from the Terac judge app (JSONL export / get_submissions). */
export interface Submission {
  submissionId: string;
  variant: StudyVariant;
  /** Answer to the trust question. */
  trust: "Yes" | "No" | "Unsure";
  /** Answer to the ad-recognition question. */
  ad_recognition: "Yes" | "No" | "Unsure";
  verbatim?: string;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation — raw submissions → TrustStudy (the reusable, testable core)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate real submissions for one arm into a TrustStudy. trust_rate is the
 * share answering the trust question's positive option; ad_recognition_rate the
 * share answering the ad question's positive option. Empty input throws — an
 * arm with no responses is not a 0% result, it is no result.
 */
export function aggregateSubmissions(
  variant: StudyVariant,
  submissions: Submission[],
  ranAt: string,
): TrustStudy {
  const arm = submissions.filter((s) => s.variant === variant);
  if (arm.length === 0) {
    throw new Error(`No submissions for arm "${variant}" — refusing to report an empty result.`);
  }
  const trustYes = arm.filter((s) => s.trust === STUDY_QUESTIONS.trust.positive).length;
  const adYes = arm.filter(
    (s) => s.ad_recognition === STUDY_QUESTIONS.ad_recognition.positive,
  ).length;
  const verbatims = arm.map((s) => s.verbatim?.trim()).filter((v): v is string => !!v).slice(0, 6);

  return {
    id: `study_${variant}`,
    variant,
    question: STUDY_QUESTIONS.trust.prompt,
    n_responses: arm.length,
    trust_rate: round(trustYes / arm.length),
    ad_recognition_rate: round(adYes / arm.length),
    verbatims,
    ran_at: ranAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Before (frozen prediction) and After (actual / fixture)
// ─────────────────────────────────────────────────────────────────────────────

interface PredictedVerdictFile {
  frozen_at: string;
  n_planned: number;
  predictions: Record<StudyVariant, { trust_rate: number; ad_recognition_rate: number }>;
}

interface StudyResultsFile {
  ran_at: string;
  arms: Record<
    StudyVariant,
    { n_responses: number; trust_yes: number; recognized_yes: number; verbatims: string[] }
  >;
}

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, file), "utf8")) as T;
}

/** The FROZEN model prediction for one arm — the "before". Loaded, never recomputed. */
export async function predictVerdict(variant: StudyVariant): Promise<TrustStudy> {
  const file = await loadJson<PredictedVerdictFile>("predicted-verdict.json");
  const p = file.predictions[variant];
  return {
    id: `predicted_${variant}`,
    variant,
    question: STUDY_QUESTIONS.trust.prompt,
    n_responses: file.n_planned,
    trust_rate: p.trust_rate,
    ad_recognition_rate: p.ad_recognition_rate,
    verbatims: ["[MODEL PREDICTION — frozen pre-study, not a human response]"],
    ran_at: file.frozen_at,
  };
}

/**
 * The actual verdict for one arm. `flags.liveStudy === false` → fixture; live →
 * aggregate the supplied real submissions. Live with no submissions throws.
 */
export async function runStudy(
  variant: StudyVariant,
  flags: RunFlags,
  submissions?: Submission[],
): Promise<TrustStudy> {
  if (!flags.liveStudy) {
    const file = await loadJson<StudyResultsFile>("study-results.json");
    const a = file.arms[variant];
    return {
      id: `fixture_${variant}`,
      variant,
      question: STUDY_QUESTIONS.trust.prompt,
      n_responses: a.n_responses,
      trust_rate: round(a.trust_yes / a.n_responses),
      ad_recognition_rate: round(a.recognized_yes / a.n_responses),
      verbatims: ["[FIXTURE — not a real response]", ...a.verbatims],
      ran_at: file.ran_at,
    };
  }
  if (!submissions || submissions.length === 0) {
    throw new Error(
      `LIVE_STUDY=1 but no submissions supplied for "${variant}". ` +
        `Connect the Terac MCP, pull get_submissions, and pass them in — never fabricate.`,
    );
  }
  return aggregateSubmissions(variant, submissions, new Date().toISOString());
}

/** Launch all three arms simultaneously (one latency cycle) and return each verdict. */
export async function runStudyArms(
  flags: RunFlags,
  submissions?: Submission[],
): Promise<Record<StudyVariant, TrustStudy>> {
  const results = await Promise.all(
    VARIANT_NAMES.map((v) => runStudy(v, flags, submissions)),
  );
  return Object.fromEntries(VARIANT_NAMES.map((v, i) => [v, results[i]!])) as Record<
    StudyVariant,
    TrustStudy
  >;
}

/** predicted (before) vs actual (after) for one arm, plus the shipped format change. */
export function buildBeforeAfter(
  before: TrustStudy,
  after: TrustStudy,
  changeMade: string,
): TeracBeforeAfter {
  return {
    before,
    after,
    change_made: changeMade,
    trust_delta: round(after.trust_rate - before.trust_rate),
    recognition_delta: round(after.ad_recognition_rate - before.ad_recognition_rate),
  };
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

/**
 * The Format agent's hard decision (PRD §2): read the actual arms and decide the
 * disclosure format we ship. If prominent labeling beats inline on recognition
 * without a material trust cost, adopt it as the default.
 */
export function decideFormatChange(arms: Record<StudyVariant, TrustStudy>): string {
  const inline = arms.labeled;
  const prominent = arms.labeled_prominent;
  const unlabeled = arms.unlabeled;
  const trustCost = round(inline.trust_rate - prominent.trust_rate);

  if (
    prominent.ad_recognition_rate > inline.ad_recognition_rate &&
    trustCost <= 0.1
  ) {
    return (
      `Ship 'labeled_prominent' as the default disclosure format. ` +
      `Unlabeled answers were recognized as advertising only ${pct(unlabeled.ad_recognition_rate)} of the time; ` +
      `prominent labeling raised recognition to ${pct(prominent.ad_recognition_rate)} ` +
      `(vs ${pct(inline.ad_recognition_rate)} for inline) at a ${pct(Math.max(0, trustCost))} trust cost.`
    );
  }
  return (
    `Keep 'labeled' (inline) as the default. Prominent labeling did not improve ad recognition ` +
    `enough to justify its ${pct(Math.max(0, trustCost))} trust cost ` +
    `(inline recognition ${pct(inline.ad_recognition_rate)}, prominent ${pct(prominent.ad_recognition_rate)}).`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo runner — `npm run study`. Offline by default (LIVE_STUDY=0).
// ─────────────────────────────────────────────────────────────────────────────

function flagsFromEnv(): RunFlags {
  return { ...DRY_RUN, liveStudy: process.env.LIVE_STUDY === "1" };
}

async function runDemo(): Promise<void> {
  assertNeutralWording(); // fail fast if wording ever drifts into leading territory
  const flags = flagsFromEnv();

  if (flags.liveStudy) {
    console.error(
      "[study] LIVE_STUDY=1 — connect the Terac MCP, run terac_request_feasibility FIRST " +
        "(read the gen-pop quote/ETA before committing), then pass get_submissions in. " +
        "This demo has no submissions, so it will report the frozen prediction only.",
    );
  }

  const arms = flags.liveStudy
    ? null
    : await runStudyArms(flags);

  console.log("\n=== Terac trust study — parallel arms (predicted → actual) ===");
  console.log("variant             pred_trust  act_trust   pred_recog  act_recog");
  for (const v of VARIANT_NAMES) {
    const before = await predictVerdict(v);
    const after = arms?.[v];
    const at = after ? pct(after.trust_rate) : "—";
    const ar = after ? pct(after.ad_recognition_rate) : "—";
    console.log(
      `  ${v.padEnd(18)} ${pct(before.trust_rate).padStart(9)} ${at.padStart(10)}  ` +
        `${pct(before.ad_recognition_rate).padStart(10)} ${ar.padStart(10)}`,
    );
  }

  if (!arms) return;

  const change = decideFormatChange(arms);
  const before = await predictVerdict(HEADLINE_VARIANT);
  const ba = buildBeforeAfter(before, arms[HEADLINE_VARIANT], change);

  console.log(`\n[headline arm: ${HEADLINE_VARIANT}]`);
  console.log(`  trust:       predicted ${pct(ba.before.trust_rate)} → actual ${pct(ba.after.trust_rate)} (Δ ${pct(ba.trust_delta)})`);
  console.log(`  recognition: predicted ${pct(ba.before.ad_recognition_rate)} → actual ${pct(ba.after.ad_recognition_rate)} (Δ ${pct(ba.recognition_delta)})`);
  console.log(`\n[Format agent decision]\n  ${ba.change_made}`);
  console.log(
    `\n[study] ${VARIANT_NAMES.length} arms${flags.liveStudy ? "" : "  (FIXTURE DATA — LIVE_STUDY=0)"}`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runDemo().catch((err) => {
    console.error("[study] demo failed:", err);
    process.exitCode = 1;
  });
}
