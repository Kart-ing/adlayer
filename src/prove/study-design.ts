/**
 * Terac study design — wording and stimuli (PRD-B §2.3).
 *
 * Real people are shown an assistant answer that contains a paid placement and
 * asked two neutral questions. Three variants run as PARALLEL ARMS of one study
 * (one 5–6h latency cycle, randomized A/B — no ordering effect):
 *
 *   labeled            → the [SPONSORED] tag + notice are present, inline
 *   unlabeled          → the disclosure is stripped (mirrors surfaced_unlabeled)
 *   labeled_prominent  → the disclosure is set apart as a clear banner
 *
 * Wording must be neutral — judges include PMs from DeepMind and Stripe, and a
 * leading question gets caught. `assertNeutralWording()` is the guard, exercised
 * by a test. It scans the QUESTIONS, their options, and participant-facing
 * framing — NOT the stimulus, which legitimately contains ad copy.
 *
 * Imports only `src/contract.ts` so this and its tests run under `node --test`.
 */

import { DISCLOSURE_TAG, DISCLOSURE_NOTICE } from "../contract.ts";

export type StudyVariant = "labeled" | "unlabeled" | "labeled_prominent";

export const VARIANT_NAMES: StudyVariant[] = ["labeled", "unlabeled", "labeled_prominent"];

// ─────────────────────────────────────────────────────────────────────────────
// Questions — neutral, non-leading. Both yield a binary rate for the contract:
// trust_rate = share answering "Yes" to trust; ad_recognition_rate = share
// answering "Yes" to the ad question.
// ─────────────────────────────────────────────────────────────────────────────

export interface StudyQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** The option that counts toward the contract rate. */
  positive: string;
}

export const STUDY_QUESTIONS: Record<"trust" | "ad_recognition", StudyQuestion> = {
  trust: {
    id: "trust",
    prompt: "Would you trust this assistant for future recommendations?",
    options: ["Yes", "No", "Unsure"],
    positive: "Yes",
  },
  ad_recognition: {
    id: "ad_recognition",
    prompt: "Was any part of this answer a paid advertisement?",
    options: ["Yes", "No", "Unsure"],
    positive: "Yes",
  },
};

/** Shown above the stimulus. Neutral — no priming about ads or trust. */
export const PARTICIPANT_FRAMING =
  "Read the assistant's answer below, then answer two short questions about it.";

// ─────────────────────────────────────────────────────────────────────────────
// Stimuli — the same recommendation under three disclosure treatments.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_RECOMMENDATION =
  "A good fit is Acme Board — kanban that stays out of your way for tiny remote teams. " +
  "It sets up in a few minutes and has a free plan for small teams.";

const PREAMBLE = "You asked for a simple kanban tool for a small remote team.";

/** The assistant answer shown to participants for a given variant. */
export function stimulusFor(variant: StudyVariant): string {
  switch (variant) {
    case "unlabeled":
      return `${PREAMBLE}\n\n${BASE_RECOMMENDATION}`;
    case "labeled":
      return (
        `${PREAMBLE}\n\n${DISCLOSURE_TAG} ${BASE_RECOMMENDATION}\n\n${DISCLOSURE_NOTICE}`
      );
    case "labeled_prominent":
      return (
        `${PREAMBLE}\n\n` +
        `─── PAID ADVERTISEMENT ───\n` +
        `${DISCLOSURE_TAG} ${BASE_RECOMMENDATION}\n` +
        `${DISCLOSURE_NOTICE}\n` +
        `──────────────────────────`
      );
  }
}

/** Everything the judging surface (Step 5) needs to render one arm. */
export interface StudySpec {
  framing: string;
  questions: StudyQuestion[];
  variants: { variant: StudyVariant; stimulus: string }[];
}

export function studySpec(): StudySpec {
  return {
    framing: PARTICIPANT_FRAMING,
    questions: [STUDY_QUESTIONS.trust, STUDY_QUESTIONS.ad_recognition],
    variants: VARIANT_NAMES.map((variant) => ({ variant, stimulus: stimulusFor(variant) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Neutrality guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phrases that lead a respondent toward an answer. Kept explicit so a judge can
 * audit exactly what we screen for. Substring match, case-insensitive.
 */
export const BANNED_LEADING_PHRASES: string[] = [
  "don't you",
  "do not you",
  "don't you think",
  "wouldn't you",
  "would not you",
  "won't you",
  "isn't it",
  "aren't they",
  "shouldn't you",
  "as you can see",
  "obviously",
  "clearly",
  "surely",
  "of course",
  "everyone knows",
  "needless to say",
  "deceptive",
  "manipulative",
  "misleading",
  "dishonest",
  "sneaky",
  "trick",
  "scam",
  "right?",
];

/** First banned phrase found in `text`, else null. */
export function findBannedPhrase(text: string): string | null {
  const t = text.toLowerCase();
  for (const phrase of BANNED_LEADING_PHRASES) {
    if (t.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Throw if any participant-facing wording (framing, question prompts, options)
 * contains a leading phrase. Does NOT scan stimuli — those carry real ad copy.
 */
export function assertNeutralWording(): void {
  const surfaces: { where: string; text: string }[] = [
    { where: "framing", text: PARTICIPANT_FRAMING },
  ];
  for (const q of Object.values(STUDY_QUESTIONS)) {
    surfaces.push({ where: `question:${q.id}`, text: q.prompt });
    for (const opt of q.options) surfaces.push({ where: `option:${q.id}`, text: opt });
  }
  for (const { where, text } of surfaces) {
    const hit = findBannedPhrase(text);
    if (hit) {
      throw new Error(
        `Leading wording in ${where}: "${text}" contains banned phrase "${hit}". ` +
          `Study wording must be neutral (PRD-B §2.3).`,
      );
    }
  }
}
