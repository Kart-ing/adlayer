export interface CitedReport {
  client: Client;
  score: Score;
  sources: Source[];
  queries: QueryResult[];
  gaps: Gap[];
  actions: Action[];
  pr_url: string | null;
  indexnow_submitted_at: string | null;
}

export interface Client {
  url: string;
  repo: string;
  name: string;
}

export interface Score {
  visibility: number;
  cited_queries: number;
  total_queries: number;
}

export interface Source {
  domain: string;
  citation_count: number;
  client_present: boolean;
}

export interface QueryResult {
  query: string;
  cited_urls: string[];
  cited_domains: string[];
  client_cited: boolean;
  citation_count: number;
}

export interface Gap {
  keyword: string;
  type: "missing_page" | "thin_content";
  citations: number;
  competing_domains?: string[];
}

export type Action =
  | MetaAction
  | SchemaAction
  | RobotsTxtAction
  | LlmsTxtAction
  | NewPageAction
  | BacklinkCallAction;

export interface MetaAction {
  type: "meta";
  file: string;
  before: string;
  after: string;
  rationale?: string;
}

export interface SchemaAction {
  type: "schema";
  file: string;
  before: string;
  after: string;
  rationale?: string;
}

export interface RobotsTxtAction {
  type: "robots_txt";
  file: string;
  before: string;
  after: string;
  rationale?: string;
}

export interface LlmsTxtAction {
  type: "llms_txt";
  file: string;
  after: string;
  rationale?: string;
}

export interface NewPageAction {
  type: "new_page";
  file: string;
  after: string;
  targets_keyword?: string;
  rationale?: string;
}

export interface BacklinkCallAction {
  type: "backlink_call";
  target: OutreachTarget;
  brief: string;
  call_id: string | null;
  status: "pending_approval" | "queued" | "in_progress" | "completed" | "failed";
  outcome_type: string | null;
  outcome: BacklinkOutcome | null;
  outcome_summary: string | null;
  transcript: TranscriptTurn[] | null;
  recording_url: string | null;
  backlink_url: string | null;
}

export type BacklinkOutcome =
  | "listed"
  | "will_follow_up"
  | "needs_form"
  | "declined"
  | "no_answer"
  | "pending";

export interface TranscriptTurn {
  role: "bot" | "operator";
  text: string;
}

export interface OutreachTarget {
  name: string;
  domain: string | null;
  phone: string | null;
  category: "chamber" | "directory" | "blog" | "listicle" | "association" | "other";
  contact_person?: string | null;
  contact_title?: string | null;
  why_relevant: string;
  cited_by_engine?: boolean;
}

export interface AuditResult {
  url: string;
  title: string | null;
  meta_description: string | null;
  canonical: string | null;
  json_ld: unknown[];
  has_llms_txt: boolean;
  robots_txt: string | null;
  ai_crawlers_allowed: string[];
  nap: {
    name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    has_street: boolean;
  };
  pages: { url: string; title?: string }[];
  category_hint: string | null;
}

export interface VoygrCallResult {
  call_id: string;
  status: string;
  outcome_type: string | null;
  outcome_summary: string | null;
  transcript_full: TranscriptTurn[] | null;
  recording_url: string | null;
  duration_sec?: number;
}

export interface VoygrAdapter {
  placeCall(target_phone: string, brief: string, language?: string): Promise<{ call_id: string; status: string }>;
  getCall(call_id: string): Promise<VoygrCallResult>;
  getUsage(): Promise<{ remaining: number; limit: number }>;
  awaitCall(call_id: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<VoygrCallResult>;
}

export interface ActInput {
  client: Client;
  queries: QueryResult[];
  sources: Source[];
  approvedTargets?: OutreachTarget[];
  fixture?: boolean;
  live?: { generate?: boolean; call?: boolean; pr?: boolean; indexnow?: boolean };
}

export interface ActOutput {
  gaps: Gap[];
  actions: Action[];
  pr_url: string | null;
  indexnow_submitted_at: string | null;
}
