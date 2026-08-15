// Retrieval orchestrator — scrape → queries → engines → aggregate → output.
// Person A (Retrieval) entry point. Delivers score + sources per fixture.json.
//
// Hard deadline: engine work cancels at ENGINE_TIMEOUT_MS (90s). Scrape has
// its own timeout (5s). Any results collected before the deadline are kept;
// unfinished engine work is dropped.

import { RetrieveOutput, QueryResult } from "./types";
import type { EngineResult } from "./types";
import { scrapeHomepage } from "./scrape";
import { buildQueries } from "./queries";
import { runOpenAI, runDeepSeek } from "./engine";
// import { runOpenRouter } from "./engine";  // slower than OpenAI — disabled
import { aggregate, extractDomain } from "./aggregate";

const EMPTY: RetrieveOutput = {
  score: { visibility: 0, cited_queries: 0, total_queries: 0 },
  sources: [],
  queries: [],
};

const ENGINE_TIMEOUT_MS = parseInt(process.env.RETRIEVE_TIMEOUT ?? "90000", 10);

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms));
}

/**
 * Run the full retrieval pipeline for a client URL. Primary engine: OpenAI
 * Responses API (web_search tool, structured citations). DeepSeek runs through
 * the OpenAI SDK (OpenAI-compatible API, prompting for URLs from training data).
 * OpenRouter is disabled — adds latency without better results.
 *
 * Hard deadline at ENGINE_TIMEOUT_MS from when engine work starts. After it
 * fires any unfinished engine task is dropped and partial results aggregated.
 * Never throws.
 */
export async function retrieve(clientUrl: string): Promise<RetrieveOutput> {
  const clientDomain = extractDomain(clientUrl);

  const { category, keywords } = await scrapeHomepage(clientUrl);
  const queries = buildQueries(category, keywords);

  if (process.env.RETRIEVE_VERBOSE || process.env.RETRIEVE_DEBUG) {
    console.error(
      `[retrieve] domain=${clientDomain} category="${category}" ` +
        `keywords=[${keywords.join(", ")}] queries=${queries.length}`
    );
  }

  const engineTasks: Promise<EngineResult[]>[] = [];
  if (process.env.OPENAI_API_KEY) engineTasks.push(runOpenAI(queries));
  // if (process.env.OPENROUTER_API_KEY) engineTasks.push(runOpenRouter(queries));
  if (process.env.DEEPSEEK_API_KEY) engineTasks.push(runDeepSeek(queries));

  if (engineTasks.length === 0) return EMPTY;

  const deadline = Date.now() + ENGINE_TIMEOUT_MS;

  // Race each engine task against a timeout that respects the shared deadline.
  // After the deadline fires, Promise.allSettled collects whatever completed.
  const timedOut = engineTasks.map((task) => {
    const remaining = Math.max(0, deadline - Date.now());
    return Promise.race([task, timeoutAfter(remaining)]);
  });

  const settled = await Promise.allSettled(timedOut);

  if (process.env.RETRIEVE_VERBOSE || process.env.RETRIEVE_DEBUG) {
    const timedOutCount = settled.filter((s) => s.status === "rejected").length;
    if (timedOutCount) {
      console.error(`[retrieve] ${timedOutCount} engine(s) timed out at ${ENGINE_TIMEOUT_MS / 1000}s`);
    }
  }

  const combined: EngineResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") combined.push(...s.value);
  }

  if (!combined.length) return EMPTY;
  return aggregate(combined, clientDomain);
}

export type { RetrieveOutput, Score, SourceStats, QueryResult } from "./types";
