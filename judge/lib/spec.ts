import spec from "../data/study-spec.json";

export type Variant = "labeled" | "unlabeled" | "labeled_prominent";

export interface Question {
  id: string;
  prompt: string;
  options: string[];
  positive: string;
}

export interface StudySpec {
  framing: string;
  questions: Question[];
  variants: { variant: Variant; stimulus: string }[];
}

export const STUDY: StudySpec = spec as StudySpec;

export const VARIANT_ORDER: Variant[] = ["labeled", "unlabeled", "labeled_prominent"];

/**
 * Deterministically assign an arm from the submissionId, so a participant always
 * sees the same variant (stable across a reload) and the arms spread evenly.
 * Blind: nothing in the UI reveals which arm was assigned.
 */
export function assignVariant(seed: string): Variant {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return VARIANT_ORDER[h % VARIANT_ORDER.length]!;
}

export function stimulusFor(variant: Variant): string {
  return STUDY.variants.find((v) => v.variant === variant)?.stimulus ?? "";
}
