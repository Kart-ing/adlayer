// Person B — shared types for the action pipeline (PRD-B §2).
// Report-contract types (Client/Score/Source/Gap/Action/Report) live in
// src/ui/types.ts and are frozen; these are B-internal seams.

import type { Score, Source } from "../ui/types";

export interface SiteAudit {
  url: string;
  fetched_at: string; // ISO
  ok: boolean; // homepage fetch succeeded
  title: string | null;
  meta_description: string | null;
  has_schema_org: boolean;
  schema_types: string[];
  has_llms_txt: boolean;
  llms_txt: string | null;
  sitemap_urls: string[]; // capped at 200
  page_text: string; // homepage visible text, capped at 20k chars
  head_html: string; // raw <head> contents, capped at 20k chars
}

// Person A's handoff seam: out/retrieve.json (score/sources per the report
// contract; queries optional — gap derivation falls back to fixture without it).
export interface RetrieveQuery {
  query: string;
  cited: boolean;
  citations: string[];
}

export interface RetrieveOutput {
  score: Score;
  sources: Source[];
  queries?: RetrieveQuery[];
}

export interface PrResult {
  pr_url: string | null;
  mode: "direct" | "invite" | "fork" | "skipped";
  detail: string; // human-readable outcome for logs/demo narration
}
