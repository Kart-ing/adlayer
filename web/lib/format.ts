import type { PropagationState } from "./contract";

export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function signedPct(rate: number): string {
  const p = Math.round(rate * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}

export function latency(minutes: number | null): string {
  return minutes === null ? "—" : `${minutes}m`;
}

/** Short human timestamp (UTC) for a dense table. */
export function ts(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** CSS class + label per propagation state. surfaced_unlabeled is the alarm. */
export const STATE_META: Record<PropagationState, { label: string; cls: string; alarming?: boolean }> = {
  absent: { label: "absent", cls: "st-absent" },
  surfaced_labeled: { label: "surfaced · labeled", cls: "st-labeled" },
  surfaced_unlabeled: { label: "surfaced · UNLABELED", cls: "st-unlabeled", alarming: true },
  cited_unattributed: { label: "cited · unattributed", cls: "st-cited" },
};
