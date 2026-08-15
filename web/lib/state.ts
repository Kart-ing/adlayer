import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdLayerState, PropagationCheck } from "./contract";

/** state.json carries fixture markers that are not part of the contract shape. */
export type LoadedState = AdLayerState & { _fixture?: boolean; _note?: string };

const STATE_PATH = path.join(process.cwd(), "data", "state.json");

/** Read AdLayerState from disk. Renders fully with zero env vars set. */
export async function loadState(): Promise<LoadedState> {
  const raw = await readFile(STATE_PATH, "utf8");
  return JSON.parse(raw) as LoadedState;
}

/** Live-retrieval engines fetch at query time; ingestion engines refresh an index. */
export function engineKind(engine: string): "live_retrieval" | "ingestion" {
  return engine === "perplexity/sonar" ? "live_retrieval" : "ingestion";
}

export function checksForPlacement(
  state: AdLayerState,
  placementId: string,
): PropagationCheck[] {
  return state.propagation.filter((c) => c.placement_id === placementId);
}
