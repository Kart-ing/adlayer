// Shared types for the retrieval module (Person A).
// The output must slot directly into fixture.json's `score` + `sources`.

import type { QueryResult } from "../contract";

export type { QueryResult };

export interface Citation {
  url: string;
  title?: string;
}

export type EngineName = "openai" | "openrouter" | "deepseek";

export interface EngineResult {
  query: string;
  urls: string[];
  source: EngineName;
}

export interface SourceStats {
  domain: string;
  citation_count: number;
  client_present: boolean;
}

export interface Score {
  visibility: number;
  cited_queries: number;
  total_queries: number;
}

export interface RetrieveOutput {
  score: Score;
  sources: SourceStats[];
  queries: QueryResult[];
}
