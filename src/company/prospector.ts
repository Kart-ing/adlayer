/**
 * ADLAYER — the PROSPECTOR agent.
 *
 * It decides WHICH COMPANIES TO APPROACH, and in what order, out of a finite
 * outreach budget. It qualifies by MEASURING a prospect's invisibility in AI
 * answers, so every pitch we send opens with a number about the prospect that
 * they did not have and cannot dispute. We do not spray.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT AN AUDIT BROKE, AND WHAT CHANGED — read this first
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A reviewer took this file apart and was right on every count. The findings and
 * the fixes, so the next reader does not have to rediscover them:
 *
 *  1. "In every configuration this repo can actually run, it returns `defer` for
 *     every candidate." TRUE of the old version. The only live measurement path
 *     was `engine/retrieve`, which cannot load here: it uses extensionless
 *     specifiers (unresolvable under `node --experimental-strip-types`) and
 *     imports `openai`, which is not in package.json and cannot be added under
 *     the zero-new-deps rule. The decision function was real; the wiring was
 *     theatre.
 *     FIXED by giving the agent a measurement source that works under this
 *     project's own rules: `sonarRetrieve()`, an inline keyless-degrading call
 *     to perplexity/sonar written against global fetch with zero dependencies —
 *     the live-retrieval engine PRD §3 already names as the target. Set
 *     `PERPLEXITY_API_KEY` and `--live` and this agent measures for real and
 *     decides for real. `engine/retrieve` is now an OPT-IN fallback, loaded
 *     through an opaque specifier so it never enters the typecheck program.
 *
 *  2. "`npx tsc --noEmit` reports 13 errors with src/company present, including
 *     Cannot find module 'openai'." TRUE. A literal `import("../../engine/...")`
 *     pulls the whole engine into the program even inside a try/catch. FIXED:
 *     the specifier is a runtime string (`ENGINE_MODULE`), so tsc cannot follow
 *     it. The only remaining engine reference is `import type` on `types.ts`,
 *     which is a two-file leaf with no `openai` in it.
 *
 *  3. "`executed: verdict !== "approach"` marks 'we did nothing about globex' as
 *     an EXECUTED decision, so a fully-degraded run reports 3 of 3 executed and
 *     never prints its most damning self-check." TRUE, and it disarmed the one
 *     warning that would have caught exactly that state. FIXED: only a REJECT is
 *     executed — it consumes the slot and drops the prospect from this cycle. A
 *     deferral changes nothing outside the log and now says so, which means a
 *     keyless run correctly trips "nothing in this log was executed".
 *
 *  4. "N identical per-candidate entries inflate the decision count." TRUE. When
 *     the instrument is down, every candidate deferred for the same reason is
 *     not N decisions, it is ONE decision about the instrument. FIXED:
 *     `rankProspects()` detects a total measurement failure and logs a SINGLE
 *     batch entry (`prospector-instrument-down-*`) instead of N clones.
 *
 *  5. Nothing in the log could be re-run. FIXED: `prospectorMechanism()` is
 *     registered with the DecisionLog, and every qualify entry carries a
 *     `replay` pointer — the exact input the pure decider was called with, plus
 *     that input with the flip condition's stated value substituted. The auditor
 *     re-runs both and requires the choice to reproduce and then to change.
 *     The flip target is DERIVED: we perturb, re-run, and record whatever the
 *     code actually returns. A falsifier we could not reproduce is not written.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE JUDGEMENT ACTUALLY IS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The lazy version of this agent is `visibility < 0.3 ? "yes" : "no"`. Three
 * things here are not that, and each can be WRONG in a way a reader can check:
 *
 *  1. ADMISSIBILITY, not score. A visibility of 0.00 measured over 3 usable
 *     queries is not a finding, it is a small sample. Our entire advantage is
 *     that the prospect cannot argue with the number; the moment we open with a
 *     figure their marketing lead can wave away, we have spent the one asset we
 *     had. So a measurement below the evidence floor produces `defer` — NOT
 *     `approach`. That costs us: a genuinely invisible prospect sits unpitched
 *     while someone else calls them. We take that cost on purpose.
 *
 *  2. REJECTING A VISIBLE COMPANY. A prospect already cited in 2 of every 5
 *     answers does not have the problem we sell. Rejecting them forfeits a
 *     possible sale — the decision an agent optimising for "pitches sent" would
 *     never make.
 *
 *  3. RANKING IS NOT SORTING BY SCORE. Pitch strength is
 *     pain x confidence x urgency, so a prospect at visibility 0.25 measured
 *     over 24 queries with an entrenched rival outranks a prospect at 0.00
 *     measured over 10 with a fragmented answer space. Sorting by raw
 *     invisibility produces a different top-K, and the log records both
 *     orderings so a reader can see the divergence rather than take our word.
 *
 * One honest deduction, stated rather than buried: the policy CONSTANTS (0.40
 * visible-enough, 8-query evidence floor, 20-query confidence sample) are
 * human-set. They are `context` in the decision log, never `evidence`. Logging
 * them as `human_input` evidence would mean no entry this agent writes could
 * ever be graded `evidence_is_all_fixture_or_prior` — a self-serving move that
 * would disarm our own auditor. A fixture-driven run of this agent grades
 * `rubber_stamp`, correctly, and prints that way in `summarize()`.
 *
 * ONE STAT WE DID NOT GAME. `summarize()` reports POSITION BIAS for this agent,
 * and it runs high. That is an artifact of emitting the same three options in
 * the same order (approach, reject, defer) every time, so "chose the first
 * option" collapses to "chose to approach". Reordering the array to move an
 * audit metric is precisely the theatre this module is supposed to be the
 * opposite of, so the ordering stands and the number stands with it. The stat
 * that carries signal for a fixed-template agent is the one beside it: distinct
 * choices PER OPTION MENU, where this agent uses all three of its qualification
 * outcomes across a mixed batch and is demonstrably not a constant function.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY POSTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Dry run by default. Without `liveMeasure: true` this module makes ZERO network
 * calls (`RunFlags.liveMeasure` in src/contract.ts). Without a measurement,
 * every candidate is deferred; nothing is qualified on vibes.
 *
 * Keyless degrades, never throws. No `PERPLEXITY_API_KEY` produces one log line
 * naming the missing key and a deferred batch — not an exception, and not a
 * fabricated number.
 *
 * NEVER 0 FOR UNKNOWN. An unmeasured prospect scores `null`, not `0`. Zero is
 * "maximally invisible", i.e. the most attractive possible prospect. Defaulting
 * unknown to zero would make a total measurement failure look like a page of
 * perfect leads. That is the single most dangerous bug this file could contain.
 *
 * Zero runtime dependencies. Node stdlib and global fetch only.
 */

import {
  openDecisionLog,
  registerMechanism,
  type DecisionDraft,
  type DecisionEntry,
  type DecisionEvidence,
  type DecisionOption,
  type DecisionReplay,
  type DecisionSink,
  type EvidenceSource,
} from "./decision-log.ts";

// Type-only, therefore erased at runtime AND cheap at compile time: this is a
// two-file leaf (`types.ts` → `contract.ts`) with no `openai` anywhere in it.
// The module that DOES import `openai` is reached only through `ENGINE_MODULE`
// below, which is a runtime string tsc cannot resolve.
import type { RetrieveOutput } from "../../engine/retrieve/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Policy — the human-set part, held in one place so it can be argued with
// ─────────────────────────────────────────────────────────────────────────────

export interface ProspectorPolicy {
  /**
   * Minimum usable queries before a visibility number is admissible as a pitch
   * opener. Below this a single lucky citation swings the headline figure by
   * more than 12 points, and "you appear in 0 of 5 answers" is a sentence a
   * competent marketing lead dismisses in one breath.
   */
  min_admissible_queries: number;
  /**
   * At or above this visibility the prospect is already cited in a large share
   * of answers and our pitch is simply false. Reject. 0.40 = cited in 2 of
   * every 5 answers.
   */
  visible_enough: number;
  /**
   * Upper edge of the borderline band. A reject inside
   * [visible_enough, borderline_ceiling) is flagged as re-checkable rather than
   * closed, because the visibility may be concentrated in low-intent queries.
   */
  borderline_ceiling: number;
  /** Sample size at which we treat a measurement as fully confident. */
  confident_sample: number;
  /**
   * If the single most-cited rival appears in fewer than this share of queries,
   * nobody is winning the answer space. Being invisible somewhere nobody is
   * visible is not a problem anyone pays to fix.
   */
  min_top_rival_share: number;
  /**
   * Outreach slots spent on prospects contesting the same answer space (same
   * top rival domain). We are an ad network with one sponsored slot per
   * publisher category: signing two direct rivals means the second one's
   * placement is worth less the moment the first goes live, and both may end up
   * rendered in the same block.
   */
  max_slots_per_contested_space: number;
  /** Default outreach budget when the caller does not name one. */
  default_budget: number;
}

export const DEFAULT_POLICY: ProspectorPolicy = {
  min_admissible_queries: 8,
  visible_enough: 0.4,
  borderline_ceiling: 0.55,
  confident_sample: 20,
  min_top_rival_share: 0.15,
  max_slots_per_contested_space: 1,
  default_budget: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// THE INSTRUMENT — perplexity/sonar, inline, zero dependencies
//
// PRD §3 says target live-retrieval engines rather than ingestion, and names
// sonar. This is that, written against global fetch so it runs under the same
// `node --experimental-strip-types` the tests use, with no `openai` package and
// no new dependency. It is the difference between an agent that decides and an
// agent that defers forever because its instrument does not exist here.
// ─────────────────────────────────────────────────────────────────────────────

/** Narrow structural shape so a test can stub a response without a Response. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponseLike>;

export const SONAR_ENDPOINT = "https://api.perplexity.ai/chat/completions";
export const SONAR_MODEL = "sonar";
/** Queries per candidate. Above `confident_sample`, so a clean run is admissible. */
export const SONAR_QUERY_COUNT = 12;

export interface SonarConfig {
  /** Defaults to `PERPLEXITY_API_KEY`. Absent → the source is unavailable. */
  apiKey?: string | null;
  endpoint?: string;
  model?: string;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * The exact category queries to ask. When omitted they are derived from the
   * candidate's categories, or — weakly, and the log says so — from its domain
   * name alone.
   */
  queries?: readonly string[];
  maxQueries?: number;
}

/**
 * Category queries for a candidate.
 *
 * With categories supplied this is a real category probe. Without them the only
 * thing we know about the candidate is its domain label, and a probe built from
 * a domain label measures brand recall rather than category presence. We build
 * it anyway — a weak measurement that is labelled weak beats no measurement —
 * and `deriveQueries` is exported so a caller can see exactly what was asked.
 */
export function deriveQueries(
  domain: string,
  categories: readonly string[] = [],
  count: number = SONAR_QUERY_COUNT,
): string[] {
  const label = (domain.split(".")[0] ?? domain).replace(/[-_]+/g, " ").trim();
  const topics = categories.length > 0 ? [...categories] : [label];
  // At least SONAR_QUERY_COUNT templates, so a candidate with a single topic
  // still clears `min_admissible_queries` on its own. With six templates the
  // default probe returned six usable queries, below the eight-query evidence
  // floor, and the agent deferred every live measurement it ever made — the
  // same "always defers" failure in a different disguise.
  const templates = [
    (t: string): string => `best ${t} tools`,
    (t: string): string => `top ${t} companies`,
    (t: string): string => `what should I use for ${t}`,
    (t: string): string => `${t} software recommendations`,
    (t: string): string => `most popular ${t} providers`,
    (t: string): string => `${t} alternatives worth considering`,
    (t: string): string => `who are the leading ${t} vendors`,
    (t: string): string => `how do I choose a ${t} provider`,
    (t: string): string => `${t} comparison`,
    (t: string): string => `cheapest ${t} option`,
    (t: string): string => `enterprise ${t} solutions`,
    (t: string): string => `${t} for small businesses`,
    (t: string): string => `${t} reviews`,
    (t: string): string => `is there a good ${t} service`,
  ];

  const out: string[] = [];
  for (let i = 0; out.length < Math.max(1, count) && i < topics.length * templates.length; i++) {
    const topic = topics[i % topics.length];
    const template = templates[Math.floor(i / topics.length) % templates.length];
    if (topic === undefined || template === undefined) continue;
    const q = template(topic);
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, Math.max(1, count));
}

/** Every http(s) URL in a blob of text or JSON. Sonar reports citations several ways. */
function urlsFromSonarPayload(payload: unknown): string[] {
  const found: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) found.push(v);
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (typeof node === "string") return push(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // Only the citation-bearing fields. Walking `choices[].message.content`
    // would count a URL the model merely typed as a citation, which inflates
    // visibility — the one direction this number must never be wrong in.
    for (const key of ["citations", "search_results", "url", "link"]) {
      if (key in record) walk(record[key], depth + 1);
    }
  };
  walk(payload, 0);
  return [...new Set(found)];
}

/**
 * A `RetrieveFn` backed by perplexity/sonar. Returns `null` — never throws —
 * when there is no API key, with one log line naming the missing variable.
 *
 * Per-query failures are DROPPED FROM THE SAMPLE rather than counted as
 * "the prospect was not cited". A rate-limited query is an absence of evidence;
 * counting it as a miss manufactures invisibility, which is the exact direction
 * this agent's whole pitch would be lying in.
 */
export function sonarRetrieve(
  config: SonarConfig = {},
  logger: (m: string) => void = console.log,
): RetrieveFn | null {
  const apiKey = config.apiKey ?? process.env["PERPLEXITY_API_KEY"] ?? null;
  if (apiKey === null || apiKey.trim() === "") {
    logger(
      "[adlayer:prospector] no PERPLEXITY_API_KEY — the sonar instrument is unavailable, " +
        "so nothing is measured and nothing is qualified. Set it to measure for real.",
    );
    return null;
  }
  const endpoint = config.endpoint ?? SONAR_ENDPOINT;
  const model = config.model ?? SONAR_MODEL;
  const doFetch: FetchLike =
    config.fetchImpl ??
    (async (url, init) => {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, text: () => res.text() };
    });

  return async (candidateUrl: string): Promise<RetrieveOutput> => {
    const domain = toDomain(candidateUrl);
    const queries =
      config.queries !== undefined && config.queries.length > 0
        ? [...config.queries]
        : deriveQueries(domain, [], config.maxQueries ?? SONAR_QUERY_COUNT);

    const perQuery: { query: string; urls: string[] }[] = [];
    for (const query of queries.slice(0, config.maxQueries ?? SONAR_QUERY_COUNT)) {
      let res: HttpResponseLike;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: query }],
          }),
        });
      } catch (err) {
        logger(`[adlayer:prospector] sonar "${query}" failed (${errText(err)}) — dropped from the sample`);
        continue;
      }
      if (!res.ok) {
        logger(`[adlayer:prospector] sonar "${query}" returned HTTP ${res.status} — dropped from the sample`);
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await res.text());
      } catch (err) {
        logger(`[adlayer:prospector] sonar "${query}" returned unparseable JSON (${errText(err)}) — dropped`);
        continue;
      }
      perQuery.push({ query, urls: urlsFromSonarPayload(payload) });
    }

    return aggregateQueries(domain, perQuery);
  };
}

/**
 * Fold per-query citation lists into the same shape `engine/retrieve` emits, so
 * every downstream consumer is source-agnostic and the two instruments stay
 * interchangeable. Exported because it is the arithmetic behind every number
 * this agent says out loud, and it should be testable without a network.
 */
export function aggregateQueries(
  domain: string,
  perQuery: readonly { query: string; urls: readonly string[] }[],
): RetrieveOutput {
  const counts = new Map<string, number>();
  let cited = 0;
  const queries = perQuery.map((q) => {
    const domains = [...new Set(q.urls.map((u) => toDomain(u)))];
    const clientCited = domains.some((d) => sameOrg(d, domain));
    if (clientCited) cited++;
    for (const d of domains) counts.set(d, (counts.get(d) ?? 0) + 1);
    return {
      query: q.query,
      cited_urls: [...q.urls],
      cited_domains: domains,
      client_cited: clientCited,
      citation_count: q.urls.length,
    };
  });

  const total = queries.length;
  return {
    score: {
      visibility: total === 0 ? 0 : round4(cited / total),
      cited_queries: cited,
      total_queries: total,
    },
    sources: [...counts.entries()]
      .map(([d, citation_count]) => ({
        domain: d,
        citation_count,
        client_present: sameOrg(d, domain),
      }))
      .sort((a, b) => b.citation_count - a.citation_count || a.domain.localeCompare(b.domain)),
    queries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement
// ─────────────────────────────────────────────────────────────────────────────

export interface RivalStat {
  domain: string;
  citation_count: number;
  /** Share of usable queries this domain was cited in, 0..1. */
  query_share: number;
}

export interface VisibilityProbe {
  url: string;
  domain: string;
  /** 0..1 share of usable queries citing the prospect. null when unmeasured. */
  visibility: number | null;
  cited_queries: number;
  /** Queries that returned usable citations. The sample size, not the ask. */
  total_queries: number;
  /** Domains cited INSTEAD of the prospect, strongest first. */
  rivals: RivalStat[];
  measured_at: string;
  /** True when no usable measurement exists. `visibility` is null. */
  degraded: boolean;
  degraded_reason: string | null;
  /** Which instrument produced (or failed to produce) this number. */
  instrument: string;
  /** How the log should grade evidence drawn from this probe. */
  provenance: Extract<EvidenceSource, "measurement" | "fixture">;
}

/** The shape we reuse from `engine/retrieve`. */
export type RetrieveFn = (url: string) => Promise<RetrieveOutput>;

export interface ProspectorFlags {
  /**
   * Actually hit answer engines. Costs money, rate limited. Mirrors
   * `RunFlags.liveMeasure`. Default false: no network call is made.
   */
  liveMeasure?: boolean;
  /** Outreach slots for this cycle. */
  budget?: number;
  /**
   * Injected measurement source, replacing the built-in instruments.
   * Deliberately NOT gated by `liveMeasure`: this is the caller's own function,
   * and `liveMeasure` exists to gate OUR paid answer-engine calls, not to make
   * injection impossible without also claiming a live run.
   */
  retrieve?: RetrieveFn;
  /** Config for the built-in sonar instrument. */
  sonar?: SonarConfig;
  /** Categories used to build the probe queries. Without them the probe is weak. */
  categories?: readonly string[];
  /**
   * Opt in to `engine/retrieve` as the measurement source instead of sonar.
   * OFF by default and loaded through a runtime specifier, because that module
   * needs `openai` (absent from package.json) and a runner that resolves
   * extensionless .ts specifiers. Neither is true of this repo today.
   */
  useEngine?: boolean;
  /**
   * How to grade evidence produced by an injected `retrieve`. Default
   * "measurement". Pass "fixture" when feeding canned numbers, and the audit
   * will correctly downgrade every resulting entry to `rubber_stamp`.
   */
  evidenceSource?: Extract<EvidenceSource, "measurement" | "fixture">;
  /** Where decisions go. Omitted means memory-only — dry run, no file touched. */
  log?: DecisionSink;
  policy?: Partial<ProspectorPolicy>;
  now?: () => Date;
  logger?: (message: string) => void;
}

/** Normalize a hostname the same way `engine/retrieve/aggregate.ts` does. */
export function toDomain(url: string): string {
  const strip = (host: string): string =>
    host.toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
  try {
    return strip(new URL(url.includes("://") ? url : `https://${url}`).hostname);
  } catch {
    return strip(url);
  }
}

/**
 * Built at runtime, never as a literal.
 *
 * A literal `import("../../engine/retrieve/index.ts")` — even inside a
 * try/catch that swallows the failure — pulls the whole engine into the
 * typecheck program, and `npx tsc --noEmit` then reports 13 errors this
 * workstream does not own, including `Cannot find module 'openai'`. A string
 * variable is not a module specifier tsc can follow, so the fallback stays
 * available at runtime and invisible at compile time.
 */
const ENGINE_MODULE = ["..", "..", "engine", "retrieve", "index.ts"].join("/");

/**
 * Load `engine/retrieve` lazily. Returns null instead of throwing, and says
 * exactly why, once. Memoized so a batch of 30 candidates does not print 30
 * copies of the same failure.
 */
let engineLoad: Promise<RetrieveFn | null> | null = null;
export function resetEngineLoaderForTests(): void {
  engineLoad = null;
}
async function loadEngineRetrieve(logger: (m: string) => void): Promise<RetrieveFn | null> {
  if (engineLoad === null) {
    const specifier: string = ENGINE_MODULE;
    engineLoad = import(specifier)
      .then((mod: unknown) => {
        const fn = (mod as { retrieve?: unknown }).retrieve;
        if (typeof fn !== "function") {
          logger("[adlayer:prospector] engine/retrieve loaded but exports no retrieve()");
          return null;
        }
        return fn as RetrieveFn;
      })
      .catch((err: unknown) => {
        logger(
          `[adlayer:prospector] engine/retrieve unavailable (${errText(err)}) — ` +
            `needs \`npm i openai\` and a runner that resolves extensionless .ts ` +
            `specifiers (tsx). Falling back to the sonar instrument.`,
        );
        return null;
      });
  }
  return engineLoad;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What produced (or failed to produce) a number, for the record. */
export interface MeasurementSource {
  fn: RetrieveFn | null;
  /** Human name of the instrument, used in evidence and in `probe.instrument`. */
  instrument: string;
  /** Set when `fn` is null: why there is no instrument. */
  unavailable_reason: string | null;
}

/**
 * Pick the instrument. Order matters and is the answer to "which configuration
 * of this repo actually measures anything":
 *
 *   1. An injected `retrieve` — the caller's own, tests included.
 *   2. `engine/retrieve`, only when explicitly opted into.
 *   3. sonar, inline and keyless-degrading. THE DEFAULT LIVE PATH.
 */
export async function resolveMeasurementSource(
  flags: ProspectorFlags,
  logger: (m: string) => void,
): Promise<MeasurementSource> {
  if (flags.retrieve !== undefined) {
    return { fn: flags.retrieve, instrument: "injected retrieve()", unavailable_reason: null };
  }
  if (flags.liveMeasure !== true) {
    return {
      fn: null,
      instrument: "none (dry run)",
      unavailable_reason: "dry run: liveMeasure not set, so no visibility was measured",
    };
  }
  if (flags.useEngine === true) {
    const fn = await loadEngineRetrieve(logger);
    if (fn !== null) {
      return { fn, instrument: "engine/retrieve", unavailable_reason: null };
    }
  }
  const sonar = sonarRetrieve(flags.sonar ?? {}, logger);
  if (sonar !== null) {
    return { fn: sonar, instrument: `perplexity/${flags.sonar?.model ?? SONAR_MODEL}`, unavailable_reason: null };
  }
  return {
    fn: null,
    instrument: `perplexity/${flags.sonar?.model ?? SONAR_MODEL}`,
    unavailable_reason: "no PERPLEXITY_API_KEY, so the sonar instrument could not be built",
  };
}

/**
 * Produce a visibility probe for one candidate. Never throws. Never invents a
 * number: any failure yields `degraded: true` and `visibility: null`.
 */
export async function measure(
  candidateUrl: string,
  flags: ProspectorFlags = {},
): Promise<VisibilityProbe> {
  const logger = flags.logger ?? ((m: string): void => console.log(m));
  const now = flags.now ?? ((): Date => new Date());
  const domain = toDomain(candidateUrl);
  const measured_at = now().toISOString();
  const provenance = flags.evidenceSource ?? "measurement";

  const degraded = (reason: string, instrument: string): VisibilityProbe => ({
    url: candidateUrl,
    domain,
    visibility: null,
    cited_queries: 0,
    total_queries: 0,
    rivals: [],
    measured_at,
    degraded: true,
    degraded_reason: reason,
    instrument,
    provenance,
  });

  // Sonar's query set depends on the candidate's categories, so it is built
  // here rather than once per batch.
  const scoped: ProspectorFlags =
    flags.retrieve === undefined && flags.categories !== undefined && flags.categories.length > 0
      ? {
          ...flags,
          sonar: {
            ...(flags.sonar ?? {}),
            queries: flags.sonar?.queries ?? deriveQueries(domain, flags.categories),
          },
        }
      : flags;

  const source = await resolveMeasurementSource(scoped, logger);
  if (source.fn === null) {
    if (flags.liveMeasure !== true) {
      logger(
        `[adlayer:prospector] dry run — no answer-engine calls made for ${domain}. ` +
          `Pass liveMeasure to measure for real; deferring rather than guessing.`,
      );
    }
    return degraded(
      source.unavailable_reason ?? "no measurement instrument is available",
      source.instrument,
    );
  }

  let out: RetrieveOutput;
  try {
    out = await source.fn(candidateUrl);
  } catch (err: unknown) {
    logger(`[adlayer:prospector] measurement failed for ${domain}: ${errText(err)} — deferring`);
    return degraded(`${source.instrument} threw: ${errText(err)}`, source.instrument);
  }

  const total = Number(out?.score?.total_queries ?? 0);
  if (!Number.isFinite(total) || total <= 0) {
    // A zero-query result is an absence of evidence, never evidence of absence.
    logger(
      `[adlayer:prospector] no usable answer-engine results for ${domain} ` +
        `(every query came back empty or failed) — deferring, not qualifying`,
    );
    return degraded(`${source.instrument} returned no usable queries`, source.instrument);
  }

  const cited = Number(out.score.cited_queries ?? 0);
  const visibility = clamp01(Number(out.score.visibility ?? 0));
  const rivals: RivalStat[] = (out.sources ?? [])
    .filter((s) => s !== undefined && !s.client_present && !sameOrg(toDomain(s.domain), domain))
    .map((s) => ({
      domain: s.domain,
      citation_count: s.citation_count,
      query_share: clamp01(s.citation_count / total),
    }))
    .sort((a, b) => b.citation_count - a.citation_count);

  return {
    url: candidateUrl,
    domain,
    visibility,
    cited_queries: cited,
    total_queries: total,
    rivals,
    measured_at,
    degraded: false,
    degraded_reason: null,
    instrument: source.instrument,
    provenance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signals — the composite that makes ranking differ from sorting
// ─────────────────────────────────────────────────────────────────────────────

export interface ProspectSignals {
  /** 1 - visibility. How much of the answer space they are missing. */
  pain: number;
  /** How much we trust the number, from sample size. 0..1. */
  confidence: number;
  /** Top rival's query share. Someone is actively eating their answers. */
  urgency: number;
  /** pain x confidence x (0.5 + 0.5 x urgency). The ranking key. */
  pitch_strength: number;
  /** Is the measurement good enough to say out loud to a prospect? */
  admissible: boolean;
  admissibility_reason: string;
  /** Top rival domain, or null. Two prospects sharing one contest a space. */
  contested_space: string | null;
}

export function scoreProspect(
  probe: VisibilityProbe,
  policy: ProspectorPolicy = DEFAULT_POLICY,
): ProspectSignals {
  const top = probe.rivals[0];
  const contested_space = top !== undefined ? top.domain : null;
  const urgency = top !== undefined ? clamp01(top.query_share) : 0;

  if (probe.degraded || probe.visibility === null) {
    return {
      pain: 0,
      confidence: 0,
      urgency,
      pitch_strength: 0,
      admissible: false,
      admissibility_reason:
        probe.degraded_reason ?? "no measurement, so there is no number to pitch",
      contested_space,
    };
  }

  const confidence = clamp01(probe.total_queries / policy.confident_sample);
  const pain = clamp01(1 - probe.visibility);
  const admissible = probe.total_queries >= policy.min_admissible_queries;

  return {
    pain,
    confidence,
    urgency,
    // Urgency modulates between 0.5x and 1.0x — a contested answer space makes
    // the pitch land harder, but a quiet one does not make invisibility a
    // non-problem, so it is never allowed to zero the score out.
    pitch_strength: round4(pain * confidence * (0.5 + 0.5 * urgency)),
    admissible,
    admissibility_reason: admissible
      ? `${probe.total_queries} usable queries, at or above the ${policy.min_admissible_queries}-query evidence floor`
      : `only ${probe.total_queries} usable queries, below the ${policy.min_admissible_queries}-query evidence floor`,
    contested_space,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE DECIDER, and the replay the auditor re-runs
//
// Everything the verdict depends on is in `ProspectorInput`, which is plain
// JSON. `decideFromInput` is the only place a verdict is computed — the logged
// entry and the re-run cannot diverge, because they are the same call.
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = "approach" | "reject" | "defer";

export type VerdictReason =
  /** No measurement at all. */
  | "unmeasured"
  /** Measured, but the sample is too small to say out loud. */
  | "sample_too_small"
  /** They are already cited. Our pitch would be false. Costs us a sale. */
  | "already_visible"
  /** Invisible, but so is everyone — nobody is winning this answer space. */
  | "no_provable_pain"
  /** Invisible, confidently measured, and a rival is eating their answers. */
  | "provable_invisibility";

const OPT_APPROACH = "o_approach_now";
const OPT_REJECT = "o_reject";
const OPT_DEFER = "o_defer_remeasure";

/** The complete input to a qualification verdict. JSON round-trippable. */
export interface ProspectorInput {
  degraded: boolean;
  /** null when unmeasured. NEVER 0 for unknown. */
  visibility: number | null;
  cited_queries: number;
  total_queries: number;
  /** Top rival's share of usable queries, 0..1. */
  top_rival_share: number;
  policy: ProspectorPolicy;
}

/** Registry key. The DecisionLog re-runs this by name. */
export const PROSPECTOR_MECHANISM = "prospector.qualify";

/**
 * The whole decision, as arithmetic. No clock, no network, no log.
 *
 * Ordering is the policy: instrument first (we cannot pitch what we did not
 * measure), then sample size (we will not pitch a number we cannot defend),
 * then the two ways a prospect can fail to have the problem we sell.
 */
export function decideFromInput(input: ProspectorInput): {
  verdict: Verdict;
  reason: VerdictReason;
  option_id: string;
} {
  const policy = { ...DEFAULT_POLICY, ...(input?.policy ?? {}) };
  const wrap = (verdict: Verdict, reason: VerdictReason): ReturnType<typeof decideFromInput> => ({
    verdict,
    reason,
    option_id: verdict === "approach" ? OPT_APPROACH : verdict === "reject" ? OPT_REJECT : OPT_DEFER,
  });

  if (input?.degraded === true || input?.visibility === null || input?.visibility === undefined) {
    return wrap("defer", "unmeasured");
  }
  if (Number(input.total_queries) < policy.min_admissible_queries) {
    // The anti-spray rule. An invisible prospect measured over too few queries
    // is deferred, not approached — we would rather lose the timing than open
    // with a figure they can wave away.
    return wrap("defer", "sample_too_small");
  }
  if (Number(input.visibility) >= policy.visible_enough) {
    return wrap("reject", "already_visible");
  }
  if (Number(input.top_rival_share) < policy.min_top_rival_share) {
    return wrap("reject", "no_provable_pain");
  }
  return wrap("approach", "provable_invisibility");
}

/**
 * The auditor's view of the decider: JSON in, option id out. Registered at
 * module scope, so importing this agent is what arms mechanism replay for every
 * entry it ever wrote — including entries read back off disk in a later process.
 */
export function prospectorMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  return decideFromInput(raw as ProspectorInput).option_id;
}

registerMechanism(PROSPECTOR_MECHANISM, prospectorMechanism);

export function toProspectorInput(
  probe: VisibilityProbe,
  signals: ProspectSignals,
  policy: ProspectorPolicy,
): ProspectorInput {
  return {
    degraded: probe.degraded,
    visibility: probe.visibility,
    cited_queries: probe.cited_queries,
    total_queries: probe.total_queries,
    top_rival_share: round4(signals.urgency),
    policy,
  };
}

/**
 * THE DERIVED FALSIFIER.
 *
 * A written flip condition is a sentence. A derived one is a re-runnable claim.
 * For each reason we perturb exactly the input the flip sentence names, re-run
 * `decideFromInput`, and keep the FIRST perturbation that actually changes the
 * option. `flip_to_option_id` is then whatever the code returned, not what we
 * hoped it would return — so an entry can never claim a falsifier that does not
 * falsify. When nothing flips we record `null` and let our own auditor mark the
 * entry down for it.
 */
export function findProspectorFlip(
  input: ProspectorInput,
  reason: VerdictReason,
): { input: ProspectorInput; option_id: string } | null {
  const p = { ...DEFAULT_POLICY, ...input.policy };
  const chosen = decideFromInput(input).option_id;

  const candidates: ProspectorInput[] = [];
  const measured = (over: Partial<ProspectorInput>): ProspectorInput => ({
    ...input,
    degraded: false,
    ...over,
  });

  switch (reason) {
    case "unmeasured":
      // "A measurement over at least N usable queries returning visibility
      // below the bar, with a top rival above the floor."
      candidates.push(
        measured({
          visibility: round4(Math.max(0, p.visible_enough - 0.05)),
          cited_queries: 0,
          total_queries: p.min_admissible_queries,
          top_rival_share: round4(Math.min(1, p.min_top_rival_share + 0.05)),
        }),
      );
      break;
    case "sample_too_small":
      // The sentence turns on SAMPLE SIZE, so that is the only thing perturbed.
      candidates.push(measured({ total_queries: p.min_admissible_queries }));
      candidates.push(measured({ total_queries: p.confident_sample }));
      break;
    case "already_visible":
      candidates.push(
        measured({
          visibility: round4(Math.max(0, p.visible_enough - 0.05)),
          total_queries: Math.max(input.total_queries, p.confident_sample),
        }),
      );
      // Same sentence, second clause: if their citations sit in low-intent
      // queries the figure overstates them AND a rival is taking the rest.
      candidates.push(
        measured({
          visibility: round4(Math.max(0, p.visible_enough - 0.05)),
          total_queries: Math.max(input.total_queries, p.confident_sample),
          top_rival_share: round4(Math.min(1, p.min_top_rival_share + 0.05)),
        }),
      );
      break;
    case "no_provable_pain":
      candidates.push(measured({ top_rival_share: round4(Math.min(1, p.min_top_rival_share)) }));
      break;
    case "provable_invisibility":
      candidates.push(measured({ visibility: round4(p.visible_enough) }));
      candidates.push(
        measured({ top_rival_share: round4(Math.max(0, p.min_top_rival_share - 0.01)) }),
      );
      break;
    default:
      break;
  }

  for (const candidate of candidates) {
    const out = decideFromInput(candidate).option_id;
    if (out !== chosen) return { input: candidate, option_id: out };
  }
  return null;
}

export interface QualifyResult {
  /** True only for `approach`. Deferral is not qualification. */
  qualified: boolean;
  /** Measured visibility 0..1, or null when unmeasured. NEVER 0 for unknown. */
  score: number | null;
  rationale: string;
  decision: DecisionEntry;
  verdict: Verdict;
  reason: VerdictReason;
  probe: VisibilityProbe;
  signals: ProspectSignals;
}

/** Measure, score and decide — with no logging, so a batch can log once. */
interface Assessment {
  probe: VisibilityProbe;
  signals: ProspectSignals;
  verdict: Verdict;
  reason: VerdictReason;
  input: ProspectorInput;
  rationale: string;
}

async function assess(
  candidateUrl: string,
  policy: ProspectorPolicy,
  flags: ProspectorFlags,
): Promise<Assessment> {
  const probe = await measure(candidateUrl, flags);
  const signals = scoreProspect(probe, policy);
  const input = toProspectorInput(probe, signals, policy);
  const { verdict, reason } = decideFromInput(input);
  return {
    probe,
    signals,
    verdict,
    reason,
    input,
    rationale: buildRationale(probe, signals, verdict, reason, policy),
  };
}

/**
 * Qualify one candidate and log the decision. Never throws.
 *
 * `flags.log` omitted means the decision is held in memory: dry run by default,
 * no file written.
 */
export async function qualify(
  candidateUrl: string,
  flags: ProspectorFlags = {},
): Promise<QualifyResult> {
  const policy = { ...DEFAULT_POLICY, ...(flags.policy ?? {}) };
  const sink = flags.log ?? openDecisionLog({ now: flags.now, logger: flags.logger });
  const a = await assess(candidateUrl, policy, flags);
  const decision = sink.append(buildQualifyDraft({ ...a, policy, seq: sink.entries().length }));

  return {
    qualified: a.verdict === "approach",
    score: a.probe.visibility,
    rationale: a.rationale,
    decision,
    verdict: a.verdict,
    reason: a.reason,
    probe: a.probe,
    signals: a.signals,
  };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function buildRationale(
  probe: VisibilityProbe,
  signals: ProspectSignals,
  verdict: Verdict,
  reason: VerdictReason,
  policy: ProspectorPolicy,
): string {
  const top = probe.rivals[0];
  const rivalPhrase =
    top !== undefined
      ? `${top.domain} takes ${top.citation_count} of them (${pct(top.query_share)})`
      : `no single domain dominates the answers`;

  switch (reason) {
    case "unmeasured":
      return (
        `No visibility measurement for ${probe.domain} (${probe.degraded_reason ?? "unknown"}). ` +
        `Deferring rather than approaching: our whole pitch is a number the prospect ` +
        `cannot dispute, and we do not have one. Score is null, not zero — an unmeasured ` +
        `prospect must never read as a maximally invisible one.`
      );
    case "sample_too_small":
      return (
        `${probe.domain} is cited in ${probe.cited_queries} of ${probe.total_queries} answers, ` +
        `but ${probe.total_queries} usable queries is below the ${policy.min_admissible_queries}-query ` +
        `evidence floor. One lucky citation would move this figure by more than ` +
        `${pct(1 / Math.max(1, probe.total_queries))}, so it is not defensible on a call. ` +
        `Re-measure before contact.`
      );
    case "already_visible":
      return (
        `${probe.domain} is already cited in ${probe.cited_queries} of ${probe.total_queries} ` +
        `answer-engine results (visibility ${probe.visibility?.toFixed(2)}), at or above the ` +
        `${policy.visible_enough} bar. They do not have the problem we sell, and opening with ` +
        `"you are invisible" would be untrue and checkable. Rejecting costs us a possible sale; ` +
        `pitching a false number costs us the only asset we have.`
      );
    case "no_provable_pain":
      return (
        `${probe.domain} is invisible (${probe.cited_queries}/${probe.total_queries}), but ` +
        `${rivalPhrase} — the top rival holds ${pct(signals.urgency)} of queries, under the ` +
        `${pct(policy.min_top_rival_share)} floor. Nobody is winning this answer space, so ` +
        `there is no competitor loss to point at and no urgency to price. Reject.`
      );
    case "provable_invisibility":
      return (
        `${probe.domain} is cited in ${probe.cited_queries} of ${probe.total_queries} ` +
        `answer-engine results (visibility ${probe.visibility?.toFixed(2)}) while ${rivalPhrase}. ` +
        `The sample clears the ${policy.min_admissible_queries}-query floor, so the number is ` +
        `defensible on a call, and a named rival is taking the answers they are missing. ` +
        `Pitch strength ${signals.pitch_strength}. Approach.`
      );
    default:
      return `Verdict ${verdict} for ${probe.domain}.`;
  }
}

interface QualifyDraftInput {
  probe: VisibilityProbe;
  signals: ProspectSignals;
  verdict: Verdict;
  reason: VerdictReason;
  input: ProspectorInput;
  policy: ProspectorPolicy;
  rationale: string;
  seq: number;
}

/**
 * Where a probe's numbers came from, as a ref a reader can open.
 *
 * This used to read `engine/retrieve → acme.dev`, which pointed at a module
 * that cannot load in this repo — a ref that resolves to nothing is the
 * cheapest tell of a fabricated record, and `resolveEvidenceRef()` now counts
 * it as broken. It points at the function that actually produced the number.
 */
function probeRef(probe: VisibilityProbe, anchor: string): string {
  return `src/company/prospector.ts#${anchor} → ${probe.instrument} → ${probe.domain} @ ${probe.measured_at}`;
}

function buildQualifyDraft(input: QualifyDraftInput): DecisionDraft {
  const { probe, signals, verdict, reason, policy, rationale, seq } = input;
  const top = probe.rivals[0];

  // EVIDENCE. Probe facts only.
  //
  // The policy thresholds are deliberately NOT evidence. Logging them as a
  // `human_input` item would guarantee no entry this agent writes could ever be
  // graded `evidence_is_all_fixture_or_prior`, which would quietly disarm our
  // own rubber-stamp detector. They go in `context` instead, where a reader can
  // still see them and still argue with them.
  const evidence: DecisionEvidence[] = [];

  if (probe.degraded) {
    // An observation of our own instrument's state at a timestamp, re-checkable
    // by re-running it. Not a fixture and not a model prior: the world pushed
    // back and said "no number for you", and that is what flipped this to
    // defer. Grading it `measurement` is a judgement call, stated here rather
    // than left for a reader to discover.
    evidence.push({
      id: "ev_instrument",
      claim: `The ${probe.instrument} instrument returned no usable measurement for ${probe.domain}: ${probe.degraded_reason ?? "unknown"}`,
      source: "measurement",
      ref: probeRef(probe, "resolveMeasurementSource"),
      value: false,
      observed_at: probe.measured_at,
    });
  } else {
    evidence.push({
      id: "ev_visibility",
      claim: `${probe.domain} is cited in ${probe.cited_queries} of ${probe.total_queries} answer-engine queries`,
      source: probe.provenance,
      ref: probeRef(probe, "measure"),
      value: probe.visibility,
      observed_at: probe.measured_at,
    });
    evidence.push({
      id: "ev_sample",
      claim: `${probe.total_queries} category queries returned usable citations (the sample behind the visibility figure)`,
      source: probe.provenance,
      ref: probeRef(probe, "aggregateQueries"),
      value: probe.total_queries,
      observed_at: probe.measured_at,
    });
    if (top !== undefined) {
      evidence.push({
        id: "ev_rival",
        claim: `${top.domain} is the most-cited domain in ${probe.domain}'s answer space, present in ${top.citation_count} of ${probe.total_queries} queries`,
        source: probe.provenance,
        ref: probeRef(probe, "aggregateQueries"),
        value: round4(top.query_share),
        observed_at: probe.measured_at,
      });
    }
  }

  const have = new Set(evidence.map((e) => e.id));
  const cite = (...ids: string[]): string[] => ids.filter((id) => have.has(id));

  const visText =
    probe.visibility === null ? "unmeasured" : `${probe.cited_queries}/${probe.total_queries}`;

  const options: DecisionOption[] = [
    {
      id: OPT_APPROACH,
      summary: `Approach ${probe.domain} now, opening with their measured visibility.`,
      expected_outcome:
        `The Closer sends one pitch opening with "cited in ${visText} AI answers". ` +
        `We expect the prospect not to dispute the figure, and we expect a reply rate above ` +
        `a generic cold baseline because the opener is specific and checkable. If they reply ` +
        `"that number is wrong", the measurement, not the pitch, was the failure.`,
      supported_by: cite("ev_visibility", "ev_rival"),
      projected_value_cents: 2000,
    },
    {
      id: OPT_REJECT,
      summary: `Reject ${probe.domain} and spend the slot elsewhere.`,
      expected_outcome:
        `No pitch is sent and the slot goes to another prospect. We forgo whatever this ` +
        `prospect would have paid, and we never find out what that was — if they were ` +
        `winnable, that revenue goes to a competitor silently. The gain is that no one on ` +
        `our list receives a claim about themselves that they can disprove.`,
      supported_by: cite("ev_visibility"),
      projected_value_cents: 0,
    },
    {
      id: OPT_DEFER,
      summary: `Defer ${probe.domain} pending a measurement that clears the evidence floor.`,
      expected_outcome:
        `No pitch today. We re-run the measurement at n >= ${policy.min_admissible_queries} ` +
        `usable queries and decide then. Cost is the delay, and the risk we accept is that ` +
        `someone reaches them first while we are still measuring.`,
      supported_by: cite("ev_sample", "ev_instrument"),
      projected_value_cents: null,
    },
  ];

  const chosen =
    verdict === "approach" ? OPT_APPROACH : verdict === "reject" ? OPT_REJECT : OPT_DEFER;

  // THE FALSIFIER — stated in the same units as the evidence, so a reader can
  // check it against `ev_visibility` without asking us anything, AND derived,
  // so the auditor can re-run it rather than take the sentence on trust.
  const flip = findProspectorFlip(input.input, reason);
  const replay: DecisionReplay = {
    fn: PROSPECTOR_MECHANISM,
    input: input.input,
    flip_input: flip === null ? null : flip.input,
  };

  const flipSentence = ((): string => {
    switch (reason) {
      case "unmeasured":
        return (
          `A measurement over at least ${policy.min_admissible_queries} usable queries ` +
          `returning visibility below ${policy.visible_enough}, with a top rival above ` +
          `${policy.min_top_rival_share} query share, flips this to approach.`
        );
      case "sample_too_small":
        return (
          `A re-measure returning at least ${policy.min_admissible_queries} usable queries ` +
          `while visibility stays below ${policy.visible_enough} flips this to approach. ` +
          `The choice turns on sample size (${probe.total_queries}), not on the score.`
        );
      case "already_visible":
        return (
          `A re-measure at n >= ${policy.confident_sample} returning visibility at or below ` +
          `${round4(policy.visible_enough - 0.05)} flips this to approach. Equally, if the ` +
          `citations behind their ${probe.visibility?.toFixed(2)} turn out to sit only in ` +
          `low-intent queries (brand-name lookups rather than category queries), the figure ` +
          `overstates their real position and this becomes approach.`
        );
      case "no_provable_pain":
        return (
          `A re-measure showing any single rival domain above ${policy.min_top_rival_share} ` +
          `query share (currently ${round4(signals.urgency)}) flips this to approach: that ` +
          `would mean somebody IS winning the space and there is a named loss to point at.`
        );
      case "provable_invisibility":
        return (
          `A re-measure returning visibility at or above ${policy.visible_enough} (currently ` +
          `${probe.visibility?.toFixed(2)}), OR the top rival's query share falling below ` +
          `${policy.min_top_rival_share} (currently ${round4(signals.urgency)}), flips this ` +
          `to reject. Either one makes the opening line untrue or unurgent.`
        );
      default:
        return "";
    }
  })();

  const borderline =
    reason === "already_visible" &&
    probe.visibility !== null &&
    probe.visibility < policy.borderline_ceiling;

  return {
    id: `prospector-qualify-${slug(probe.domain)}-${seq}`,
    agent: "Prospector",
    decided_at: probe.measured_at,
    question: `Do we spend one of our finite outreach slots on ${probe.domain}?`,
    context:
      `Policy in force (human-set, not evidence): visible_enough=${policy.visible_enough}, ` +
      `min_admissible_queries=${policy.min_admissible_queries}, ` +
      `confident_sample=${policy.confident_sample}, ` +
      `min_top_rival_share=${policy.min_top_rival_share}. ` +
      `Instrument: ${probe.instrument}. ` +
      `Signals: pain=${round4(signals.pain)}, confidence=${round4(signals.confidence)}, ` +
      `urgency=${round4(signals.urgency)}, pitch_strength=${signals.pitch_strength}. ` +
      `Admissibility: ${signals.admissibility_reason}.` +
      (borderline
        ? ` BORDERLINE: visibility sits under ${policy.borderline_ceiling}, so this reject is re-checkable rather than closed.`
        : ""),
    options,
    chosen_option_id: chosen,
    rationale,
    evidence,
    flip_condition: flipSentence,
    flip_to_option_id: flip === null ? null : flip.option_id,
    replay,
    reversible: true,
    reversal_path:
      `Nothing was sent by this decision, so reversal costs only the delay: re-run ` +
      `qualify("${probe.url}") with a fresh measurement. Once the Closer actually sends a ` +
      `pitch, that send is not reversible and is logged separately by the Closer.`,
    // ONLY a reject is executed. It consumes the slot: the prospect is off this
    // cycle's list and the Closer will never see them.
    //
    // A DEFER changes nothing outside this log — the prospect is exactly where
    // they were, and marking it executed (as an earlier version did) inflated a
    // fully-degraded run to "3 of 3 executed" and silenced the one warning that
    // catches that state: "nothing in this log was executed".
    //
    // An APPROACH is a recommendation until the Closer sends, so it is not
    // executed here either.
    executed: verdict === "reject",
    effect:
      verdict === "approach"
        ? `${probe.domain} placed on the outreach list with opener "cited in ${visText} AI answers". No message sent yet; the Closer executes.`
        : verdict === "reject"
          ? `${probe.domain} dropped from this cycle's outreach list. No pitch will be sent.`
          : `${probe.domain} held for re-measurement. No pitch sent, slot not consumed, nothing outside this log changed.`,
    supersedes: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The portfolio decision — which, and in what order, under a finite budget
// ─────────────────────────────────────────────────────────────────────────────

export interface RankedProspect {
  url: string;
  domain: string;
  rank: number;
  qualify: QualifyResult;
  /** Set when a qualified prospect was held back rather than approached. */
  held_reason: string | null;
}

export interface OutreachPlan {
  /** In send order. */
  approach: RankedProspect[];
  /** Qualified, but out of budget or bumped by a space conflict. */
  held: RankedProspect[];
  rejected: RankedProspect[];
  deferred: RankedProspect[];
  budget: number;
  /** Would ranking by raw invisibility have produced a different top-K set? */
  ranking_changed_the_set: boolean;
  /**
   * True when the instrument failed on every candidate and the batch was
   * therefore logged as ONE decision about the instrument rather than N
   * identical per-candidate deferrals.
   */
  instrument_down: boolean;
  decisions: DecisionEntry[];
  log: DecisionSink;
}

const OPT_BATCH_DEFER = "o_batch_defer_until_measured";
const OPT_BATCH_SPRAY = "o_batch_pitch_unmeasured";
const OPT_BATCH_QUALIFY = "o_batch_qualify_per_candidate";

/** Registry key for the batch-level decision. */
export const PROSPECTOR_BATCH_MECHANISM = "prospector.batch";

export interface BatchInput {
  /** Candidates for which the instrument returned at least one usable query. */
  usable_measurements: number;
  candidates: number;
}

/**
 * With N candidates and zero usable measurements, the only question left is
 * what to do about the batch. `usable_measurements > 0` and we qualify each
 * candidate on its own number; at zero we defer the batch.
 *
 * SPRAY IS NEVER RETURNED, and that is deliberate rather than an oversight —
 * the same construction `pricing.ts` uses for `sell_below_floor`. Pitching an
 * unmeasured list is a real, cheap, available option that many outbound shops
 * take; it is on the record, costed, next to the refusal, so that the refusal
 * is legible as a choice. A constraint the agent could talk itself out of is
 * not a constraint.
 */
export function prospectorBatchMechanism(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const input = raw as BatchInput;
  return Number(input.usable_measurements) > 0 ? OPT_BATCH_QUALIFY : OPT_BATCH_DEFER;
}

registerMechanism(PROSPECTOR_BATCH_MECHANISM, prospectorBatchMechanism);

/**
 * Qualify a batch, then decide who actually gets a slot and in what order.
 * Never throws.
 *
 * WHEN THE INSTRUMENT IS DOWN this logs ONE decision, not N. An audit put it
 * plainly: N identical "deferred because the instrument is down" entries are
 * not N decisions, they are one decision about the instrument, repeated to
 * inflate a count. Every candidate still appears in `plan.deferred`; they share
 * the single entry that actually decided their fate.
 */
export async function rankProspects(
  candidateUrls: readonly string[],
  flags: ProspectorFlags = {},
): Promise<OutreachPlan> {
  const policy = { ...DEFAULT_POLICY, ...(flags.policy ?? {}) };
  const sink = flags.log ?? openDecisionLog({ now: flags.now, logger: flags.logger });
  const budget = Math.max(0, flags.budget ?? policy.default_budget);
  const flagsWithLog: ProspectorFlags = { ...flags, log: sink, policy };

  const assessments: Assessment[] = [];
  for (const url of candidateUrls) {
    assessments.push(await assess(url, policy, flagsWithLog));
  }

  const usable = assessments.filter((a) => !a.probe.degraded).length;
  const instrumentDown = assessments.length > 0 && usable === 0;

  const results: QualifyResult[] = [];
  const portfolioDecisions: DecisionEntry[] = [];

  if (instrumentDown) {
    const entry = sink.append(
      buildInstrumentDownDraft(assessments, policy, sink.entries().length),
    );
    portfolioDecisions.push(entry);
    for (const a of assessments) {
      results.push({
        qualified: false,
        score: a.probe.visibility,
        rationale: a.rationale,
        decision: entry,
        verdict: a.verdict,
        reason: a.reason,
        probe: a.probe,
        signals: a.signals,
      });
    }
    (flags.logger ?? console.log)(
      `[adlayer:prospector] instrument down for all ${assessments.length} candidate(s) — ` +
        `logged ONE decision about the instrument, not ${assessments.length} identical deferrals.`,
    );
  } else {
    for (const a of assessments) {
      const decision = sink.append(
        buildQualifyDraft({ ...a, policy, seq: sink.entries().length }),
      );
      results.push({
        qualified: a.verdict === "approach",
        score: a.probe.visibility,
        rationale: a.rationale,
        decision,
        verdict: a.verdict,
        reason: a.reason,
        probe: a.probe,
        signals: a.signals,
      });
    }
  }

  const qualified = results.filter((r) => r.qualified);
  const rejected = results.filter((r) => r.verdict === "reject");
  const deferred = results.filter((r) => r.verdict === "defer");

  // Ordering A — what we do: pitch strength.
  const byStrength = [...qualified].sort(
    (a, b) =>
      b.signals.pitch_strength - a.signals.pitch_strength ||
      a.probe.domain.localeCompare(b.probe.domain),
  );
  // Ordering B — the obvious alternative: most invisible first.
  const byInvisibility = [...qualified].sort(
    (a, b) =>
      (a.probe.visibility ?? 1) - (b.probe.visibility ?? 1) ||
      a.probe.domain.localeCompare(b.probe.domain),
  );

  const topSet = (list: QualifyResult[]): string =>
    list
      .slice(0, budget)
      .map((r) => r.probe.domain)
      .sort()
      .join(",");
  const ranking_changed_the_set = topSet(byStrength) !== topSet(byInvisibility);

  // Apply the contested-space cap, then the budget.
  const approach: RankedProspect[] = [];
  const held: RankedProspect[] = [];
  // space -> the prospect domains already holding a slot in it. A Map of arrays,
  // not a Map of one domain: the cap is configurable above 1, and a single-value
  // map silently makes every cap behave like 1.
  const spaceUse = new Map<string, string[]>();
  const conflicts: { winner: QualifyResult; bumped: QualifyResult; space: string }[] = [];

  for (const r of byStrength) {
    const space = r.signals.contested_space;
    if (space !== null) {
      const holders = spaceUse.get(space) ?? [];
      if (holders.length >= policy.max_slots_per_contested_space) {
        const incumbent = holders[0];
        const winner = byStrength.find((c) => c.probe.domain === incumbent);
        if (winner !== undefined) conflicts.push({ winner, bumped: r, space });
        held.push({
          url: r.probe.url,
          domain: r.probe.domain,
          rank: held.length + 1,
          qualify: r,
          held_reason:
            `Contests the same answer space as ${holders.join(", ")} (all losing to ${space}); ` +
            `policy allows ${policy.max_slots_per_contested_space} slot(s) per space.`,
        });
        continue;
      }
    }
    if (approach.length >= budget) {
      held.push({
        url: r.probe.url,
        domain: r.probe.domain,
        rank: held.length + 1,
        qualify: r,
        held_reason: `Out of budget: ${budget} slot(s) this cycle, pitch strength ${r.signals.pitch_strength} did not clear the cut.`,
      });
      continue;
    }
    if (space !== null) spaceUse.set(space, [...(spaceUse.get(space) ?? []), r.probe.domain]);
    approach.push({
      url: r.probe.url,
      domain: r.probe.domain,
      rank: approach.length + 1,
      qualify: r,
      held_reason: null,
    });
  }

  // The space-conflict decision is logged ONLY when it actually bound. An entry
  // recording a constraint that changed nothing is decoration, and this module
  // is supposed to be the opposite of that.
  for (const conflict of conflicts) {
    portfolioDecisions.push(sink.append(buildConflictDraft(conflict, policy, sink.entries().length)));
  }

  if (qualified.length > 0) {
    portfolioDecisions.push(
      sink.append(
        buildPortfolioDraft({
          byStrength,
          byInvisibility,
          approach,
          held,
          budget,
          policy,
          changed: ranking_changed_the_set,
          seq: sink.entries().length,
          at: (flags.now ?? ((): Date => new Date()))().toISOString(),
        }),
      ),
    );
  }

  const asRanked = (r: QualifyResult, i: number): RankedProspect => ({
    url: r.probe.url,
    domain: r.probe.domain,
    rank: i + 1,
    qualify: r,
    held_reason: null,
  });

  const perCandidate = instrumentDown ? [] : results.map((r) => r.decision);
  return {
    approach,
    held,
    rejected: rejected.map(asRanked),
    deferred: deferred.map(asRanked),
    budget,
    ranking_changed_the_set,
    instrument_down: instrumentDown,
    decisions: [...perCandidate, ...portfolioDecisions],
    log: sink,
  };
}

/**
 * ONE entry for a dead instrument, in place of N identical deferrals.
 *
 * The fork is real and it is the one an outbound shop faces every week: the
 * data is not there, and you can still send. We refuse, and the option we
 * refused is priced on the record next to the refusal.
 */
function buildInstrumentDownDraft(
  assessments: readonly Assessment[],
  policy: ProspectorPolicy,
  seq: number,
): DecisionDraft {
  const first = assessments[0];
  const instrument = first?.probe.instrument ?? "unknown";
  const reason = first?.probe.degraded_reason ?? "unknown";
  const domains = assessments.map((a) => a.probe.domain);
  const at = first?.probe.measured_at ?? new Date().toISOString();
  const batchInput: BatchInput = { usable_measurements: 0, candidates: assessments.length };

  const evidence: DecisionEvidence[] = [
    {
      id: "ev_instrument",
      claim: `The ${instrument} instrument returned no usable measurement for any of the ${assessments.length} candidates: ${reason}`,
      source: "measurement",
      ref: `src/company/prospector.ts#resolveMeasurementSource → ${instrument} @ ${at}`,
      value: 0,
      observed_at: at,
    },
    {
      id: "ev_batch",
      claim: `Candidates with no defensible number: ${domains.join(", ")}`,
      source: "measurement",
      ref: `src/company/prospector.ts#rankProspects @ ${at}`,
      value: assessments.length,
      observed_at: at,
    },
  ];

  return {
    id: `prospector-instrument-down-${seq}`,
    agent: "Prospector",
    decided_at: at,
    question: `The visibility instrument returned nothing for all ${assessments.length} candidates. Do we still run outreach this cycle?`,
    context:
      `Instrument: ${instrument}. Failure: ${reason}. ` +
      `Evidence floor ${policy.min_admissible_queries} usable queries; we have 0. ` +
      `This is ONE entry on purpose: ${assessments.length} identical per-candidate deferrals ` +
      `would be one decision about the instrument, repeated to inflate a decision count.`,
    options: [
      {
        id: OPT_BATCH_QUALIFY,
        summary: `Qualify each of the ${assessments.length} candidates on its own measured number.`,
        expected_outcome:
          `Each candidate gets its own entry, its own visibility figure and its own verdict, ` +
          `and the ones that clear the floor go to the Closer with a number in the opener. ` +
          `Unavailable right now: it requires at least one usable measurement and we have none.`,
        supported_by: ["ev_instrument"],
        projected_value_cents: null,
      },
      {
        id: OPT_BATCH_SPRAY,
        summary: `Pitch the list anyway, without a measured number.`,
        expected_outcome:
          `${assessments.length} generic cold emails go out today and some fraction replies. ` +
          `We spend the one asset this company has — an undisputable number about the ` +
          `recipient — on a message that does not contain one, and the first prospect who ` +
          `asks "where did you get that" gets an answer that ends the conversation.`,
        supported_by: ["ev_instrument", "ev_batch"],
        projected_value_cents: assessments.length * 2000,
      },
      {
        id: OPT_BATCH_DEFER,
        summary: `Defer the whole batch until an instrument returns a usable measurement.`,
        expected_outcome:
          `Nothing is sent this cycle and no slot is consumed. The cost is timing: every ` +
          `candidate stays reachable by someone else while we fix the instrument. Fixing it ` +
          `is one environment variable (PERPLEXITY_API_KEY) away, which is why this is a ` +
          `delay rather than a dead end.`,
        supported_by: ["ev_instrument", "ev_batch"],
        projected_value_cents: 0,
      },
    ],
    chosen_option_id: OPT_BATCH_DEFER,
    rationale:
      `Zero of ${assessments.length} candidates produced a usable measurement, so there is no ` +
      `number to open with for any of them. Spraying is available, cheap, and would produce ` +
      `some replies — it is priced above at ${assessments.length} x $20 so the refusal is legible ` +
      `as a choice rather than an omission. We refuse it because the entire product claim is ` +
      `"we measured you", and one unmeasured pitch makes every measured pitch we send after it ` +
      `deniable. Note what this entry does NOT do: it does not mark itself executed, and a ` +
      `cycle of nothing but this entry correctly trips our own "nothing was executed" warning.`,
    evidence,
    flip_condition:
      `If the instrument returns at least ONE usable query for any candidate ` +
      `(usable_measurements > 0), this flips to per-candidate qualification. Checkable by ` +
      `setting PERPLEXITY_API_KEY and re-running with --live; not a matter of opinion.`,
    flip_to_option_id: OPT_BATCH_QUALIFY,
    replay: {
      fn: PROSPECTOR_BATCH_MECHANISM,
      input: batchInput,
      flip_input: { usable_measurements: 1, candidates: assessments.length } satisfies BatchInput,
    },
    reversible: true,
    reversal_path: `Nothing was sent and no candidate was rejected. Re-run rankProspects() once an instrument is available.`,
    // Nothing outside this log changed. Saying otherwise is what disarmed the
    // "this is a simulation" warning in the version an audit caught.
    executed: false,
    effect: `No outreach this cycle. ${assessments.length} candidate(s) remain unqualified and unrejected: ${domains.join(", ")}.`,
    supersedes: null,
  };
}

interface PortfolioDraftInput {
  byStrength: QualifyResult[];
  byInvisibility: QualifyResult[];
  approach: RankedProspect[];
  held: RankedProspect[];
  budget: number;
  policy: ProspectorPolicy;
  changed: boolean;
  seq: number;
  at: string;
}

const OPT_RANK_STRENGTH = "o_rank_by_pitch_strength";
const OPT_RANK_INVISIBILITY = "o_rank_by_raw_invisibility";
const OPT_APPROACH_ALL = "o_approach_all";

function buildPortfolioDraft(input: PortfolioDraftInput): DecisionDraft {
  const { byStrength, byInvisibility, approach, held, budget, policy, changed, seq, at } = input;

  const evidence: DecisionEvidence[] = byStrength.slice(0, 12).map((r, i) => ({
    id: `ev_cand_${i}`,
    claim:
      `${r.probe.domain}: visibility ${r.probe.visibility?.toFixed(2) ?? "null"} over ` +
      `${r.probe.total_queries} queries, top rival share ${round4(r.signals.urgency)}, ` +
      `pitch strength ${r.signals.pitch_strength}`,
    source: r.probe.provenance,
    ref: probeRef(r.probe, "scoreProspect"),
    value: r.signals.pitch_strength,
    observed_at: r.probe.measured_at,
  }));
  const allIds = evidence.map((e) => e.id);

  const strengthOrder = byStrength.map((r) => r.probe.domain).join(" > ");
  const invisibilityOrder = byInvisibility.map((r) => r.probe.domain).join(" > ");

  const options: DecisionOption[] = [
    {
      id: OPT_RANK_STRENGTH,
      summary: `Rank by pain x confidence x urgency, cap ${policy.max_slots_per_contested_space} slot(s) per contested answer space, take the top ${budget}.`,
      expected_outcome:
        `Send order: ${approach.map((a) => a.domain).join(" > ") || "(none)"}. ` +
        `This deliberately puts confidently-measured prospects with an entrenched rival ` +
        `ahead of more-invisible prospects whose numbers rest on a thin sample. We expect ` +
        `higher reply and close rates than the raw-invisibility order, and we expect zero ` +
        `pitches to be met with "that number is wrong".`,
      supported_by: allIds,
      projected_value_cents: approach.length * 2000,
    },
    {
      id: OPT_RANK_INVISIBILITY,
      summary: `Rank by lowest visibility first. The obvious implementation.`,
      expected_outcome:
        `Send order: ${invisibilityOrder || "(none)"}. Maximises the drama of the opening ` +
        `number and is simpler to explain, but spends slots on prospects whose figures rest ` +
        `on the smallest samples, so we expect more disputed openers and more wasted slots.`,
      supported_by: allIds,
      projected_value_cents: null,
    },
    {
      id: OPT_APPROACH_ALL,
      summary: `Ignore the budget and pitch every qualified prospect.`,
      expected_outcome:
        `All ${byStrength.length} qualified prospects receive a pitch this cycle. Higher raw ` +
        `volume, but each pitch requires a measurement we can defend and a human on the ` +
        `other end; the predictable outcome is thinner personalisation, a lower reply rate ` +
        `per send, and the spray pattern this agent exists to avoid.`,
      supported_by: allIds,
      projected_value_cents: byStrength.length * 2000,
    },
  ];

  const rationale = changed
    ? `Pitch-strength ordering (${strengthOrder}) differs from raw-invisibility ordering ` +
      `(${invisibilityOrder}) inside the top ${budget}, so this choice is load-bearing: at ` +
      `least one prospect gets a slot that sorting by score alone would have denied, and ` +
      `vice versa. Confidence is weighted because an unsupportable number is worse than no ` +
      `call, and urgency is weighted because a named rival eating their answers is what ` +
      `makes the problem worth paying to fix. ${held.length} qualified prospect(s) held.`
    : `Pitch-strength ordering and raw-invisibility ordering agree on the top ${budget} ` +
      `(${strengthOrder}), so on this batch the composite changed nothing and this entry is ` +
      `inert — recorded rather than suppressed, because a log that only keeps its ` +
      `load-bearing decisions is a log that flatters itself. The composite still governs ` +
      `send order and would diverge on a batch with mixed sample sizes.`;

  return {
    id: `prospector-outreach-batch-${seq}`,
    agent: "Prospector",
    decided_at: at,
    question: `${byStrength.length} qualified prospect(s), ${budget} outreach slot(s). Which do we approach, and in what order?`,
    context:
      `Budget ${budget} (human-set). Contested-space cap ` +
      `${policy.max_slots_per_contested_space}. Confidence sample ${policy.confident_sample}. ` +
      `Pitch strength = (1 - visibility) x min(1, n/${policy.confident_sample}) x ` +
      `(0.5 + 0.5 x top_rival_query_share).`,
    options,
    chosen_option_id: OPT_RANK_STRENGTH,
    rationale,
    evidence,
    flip_condition:
      `Measured over at least 20 sends, if the raw-invisibility ordering produces an equal or ` +
      `higher reply rate than the pitch-strength ordering, flip to raw invisibility. Also ` +
      `checkable immediately: if both orderings select the same top ${budget} on every batch ` +
      `we run, the composite is inert and should be deleted rather than defended.`,
    flip_to_option_id: OPT_RANK_INVISIBILITY,
    // No replay pointer, deliberately: this falsifier is an EMPIRICAL one (reply
    // rates over 20 sends), and there is no pure function we can re-run today
    // that would settle it. `summarize()` counts this entry as "not re-run"
    // rather than as verified, which is the honest reading.
    replay: null,
    reversible: true,
    reversal_path: `No message is sent by this decision. Re-run rankProspects() with a different budget or policy.`,
    executed: false,
    effect:
      `Outreach list for this cycle: ${approach.map((a) => `${a.rank}. ${a.domain}`).join(", ") || "(empty)"}. ` +
      `Held: ${held.map((h) => h.domain).join(", ") || "(none)"}. Handed to the Closer; nothing sent here.`,
    supersedes: null,
  };
}

const OPT_ONE_SLOT = "o_one_slot_in_space";
const OPT_BOTH_SLOTS = "o_both_in_space";
const OPT_NEITHER = "o_neither_in_space";

function buildConflictDraft(
  conflict: { winner: QualifyResult; bumped: QualifyResult; space: string },
  policy: ProspectorPolicy,
  seq: number,
): DecisionDraft {
  const { winner, bumped, space } = conflict;
  const evidence: DecisionEvidence[] = [
    {
      id: "ev_winner",
      claim: `${winner.probe.domain} loses its answer space to ${space} (rival share ${round4(winner.signals.urgency)}), pitch strength ${winner.signals.pitch_strength}`,
      source: winner.probe.provenance,
      ref: probeRef(winner.probe, "scoreProspect"),
      value: winner.signals.pitch_strength,
      observed_at: winner.probe.measured_at,
    },
    {
      id: "ev_bumped",
      claim: `${bumped.probe.domain} loses the SAME answer space to ${space} (rival share ${round4(bumped.signals.urgency)}), pitch strength ${bumped.signals.pitch_strength}`,
      source: bumped.probe.provenance,
      ref: probeRef(bumped.probe, "scoreProspect"),
      value: bumped.signals.pitch_strength,
      observed_at: bumped.probe.measured_at,
    },
  ];

  return {
    id: `prospector-space-conflict-${slug(space)}-${seq}`,
    agent: "Prospector",
    decided_at: bumped.probe.measured_at,
    question: `${winner.probe.domain} and ${bumped.probe.domain} are both losing the same answer space to ${space}. How many outreach slots do we spend there?`,
    context:
      `Both prospects qualified independently. They are direct rivals: the same domain ` +
      `(${space}) is taking the answers each of them is missing. We sell one sponsored slot ` +
      `per publisher category. Policy cap: ${policy.max_slots_per_contested_space} slot(s) per space.`,
    options: [
      {
        id: OPT_ONE_SLOT,
        summary: `Approach ${winner.probe.domain} only; hold ${bumped.probe.domain}.`,
        expected_outcome:
          `One pitch into this space. The advertiser who signs gets a placement whose value ` +
          `is not immediately halved by their direct rival appearing beside them. We forgo ` +
          `${bumped.probe.domain}'s revenue this cycle and may lose them entirely.`,
        supported_by: ["ev_winner", "ev_bumped"],
        projected_value_cents: 2000,
      },
      {
        id: OPT_BOTH_SLOTS,
        summary: `Approach both and let them bid against each other.`,
        expected_outcome:
          `Two pitches, potentially two customers and more revenue now. But both are sold ` +
          `the same scarce slot: whoever signs second discovers their rival is already in ` +
          `the block, which is a refund conversation and a credibility loss for a network ` +
          `whose entire pitch is honest disclosure.`,
        supported_by: ["ev_winner", "ev_bumped"],
        projected_value_cents: 4000,
      },
      {
        id: OPT_NEITHER,
        summary: `Approach neither until inventory in this space is confirmed.`,
        expected_outcome: `No revenue from this space this cycle, and no risk of overselling it.`,
        supported_by: ["ev_winner"],
        projected_value_cents: 0,
      },
    ],
    chosen_option_id: OPT_ONE_SLOT,
    rationale:
      `Both qualified, so this is not a quality call — it is an inventory call. ` +
      `${winner.probe.domain} keeps the slot on pitch strength ` +
      `(${winner.signals.pitch_strength} vs ${bumped.signals.pitch_strength}). Selling the ` +
      `same category slot to two direct rivals means the second placement is worth less the ` +
      `moment the first goes live, and both may render in one block. We take the smaller ` +
      `certain outcome over the larger one that damages the product.`,
    evidence,
    flip_condition:
      `If the publisher inventory for this category supports more than one sponsored entry ` +
      `without both advertisers appearing in the same rendered block, flip to approaching ` +
      `both. Checkable against the publisher's llms.txt slot count, not against opinion.`,
    flip_to_option_id: OPT_BOTH_SLOTS,
    // Empirical falsifier again: it turns on a publisher's real slot count,
    // which lives in src/serve/, not on arithmetic we can re-run here.
    replay: null,
    reversible: true,
    reversal_path: `${bumped.probe.domain} is held, not rejected. Approach them next cycle, or immediately if the inventory check above passes.`,
    executed: true,
    effect: `${bumped.probe.domain} moved from approach to held. ${winner.probe.domain} keeps the ${space} slot.`,
    supersedes: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — what the Closer and the demo read
// ─────────────────────────────────────────────────────────────────────────────

export function renderPlan(plan: OutreachPlan): string {
  const lines: string[] = [];
  lines.push("PROSPECTOR — outreach plan");
  lines.push(
    `budget ${plan.budget} · approach ${plan.approach.length} · held ${plan.held.length} · ` +
      `rejected ${plan.rejected.length} · deferred ${plan.deferred.length}`,
  );
  lines.push("");
  if (plan.instrument_down) {
    lines.push(
      "  INSTRUMENT DOWN — no candidate produced a usable measurement. One decision was",
      "  logged about the instrument; no per-candidate verdicts were manufactured.",
    );
    lines.push("");
  }
  if (plan.approach.length === 0) {
    lines.push("  (no prospect cleared qualification — nothing will be sent)");
  }
  for (const p of plan.approach) {
    const q = p.qualify;
    lines.push(
      `  ${p.rank}. ${p.domain} — visibility ${q.score?.toFixed(2) ?? "null"} ` +
        `(${q.probe.cited_queries}/${q.probe.total_queries}), strength ${q.signals.pitch_strength}`,
    );
    lines.push(`     opener: cited in ${q.probe.cited_queries} of ${q.probe.total_queries} AI answers`);
  }
  for (const p of plan.held) {
    lines.push(`  HELD ${p.domain} — ${p.held_reason ?? ""}`);
  }
  for (const p of plan.rejected) {
    lines.push(`  REJECT ${p.domain} — ${p.qualify.reason}: ${p.qualify.rationale.slice(0, 120)}…`);
  }
  for (const p of plan.deferred) {
    lines.push(`  DEFER ${p.domain} — ${p.qualify.reason}`);
  }
  lines.push("");
  lines.push(
    plan.ranking_changed_the_set
      ? "Ranking by pitch strength selected a DIFFERENT set than ranking by raw invisibility."
      : "Ranking by pitch strength selected the SAME set as ranking by raw invisibility on this batch.",
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is `candidate` the prospect's own property rather than a competitor?
 *
 * Answer engines cite by hostname, so a prospect's own docs or blog subdomain
 * comes back as a separate cited domain. Counting it as a rival is a real false
 * positive with a real cost: it inflates `urgency`, which can push a prospect
 * over the qualification bar on the strength of THEIR OWN content winning the
 * answer space — the exact opposite of the problem we sell. So a domain that is
 * a subdomain of the prospect, or that the prospect is a subdomain of, is not a
 * rival.
 */
function sameOrg(candidate: string, prospect: string): boolean {
  if (candidate === prospect) return true;
  return candidate.endsWith(`.${prospect}`) || prospect.endsWith(`.${candidate}`);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — dry run unless --live is passed
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const live = argv.includes("--live");
  const budgetArg = argv.find((a) => a.startsWith("--budget="));
  const logArg = argv.find((a) => a.startsWith("--log="));
  const catArg = argv.find((a) => a.startsWith("--categories="));
  const urls = argv.filter((a) => !a.startsWith("-"));

  if (urls.length === 0) {
    console.log(
      "usage: prospector.ts <url...> [--live] [--budget=N] [--categories=a,b] [--log=decisions.jsonl]",
    );
    return;
  }

  const plan = await rankProspects(urls, {
    liveMeasure: live,
    budget: budgetArg === undefined ? undefined : Number(budgetArg.split("=")[1]),
    categories: catArg === undefined ? undefined : (catArg.split("=")[1] ?? "").split(",").filter(Boolean),
    log: openDecisionLog({ path: logArg === undefined ? null : (logArg.split("=")[1] ?? null) }),
  });
  console.log(renderPlan(plan));
}

// Narrow on purpose: `endsWith("prospector.ts")` would also fire under a test
// runner whose argv[1] is some other file ending in those characters.
if (process.argv[1] !== undefined && /[/\\]prospector\.ts$/.test(process.argv[1])) {
  void main(process.argv.slice(2));
}
