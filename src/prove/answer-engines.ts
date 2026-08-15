/**
 * Answer-engine adapters for MEASUREMENT.
 *
 * Why this exists separately from engine/retrieve/engine.ts: that engine captures
 * only the URLs an answer cited and throws the prose away. Propagation
 * classification needs the full answer TEXT — that is the only place the
 * [SPONSORED] label and our block's copy can survive or be stripped. So we reuse
 * the engine's disk cache (engine/retrieve/cache.ts) and mirror its retry/backoff
 * and citation-extraction patterns, but return `{ answerText, citedUrls }`.
 *
 * Two engines, two mechanisms — never conflate them (PRD-B §2.1):
 *   - perplexity/sonar  → LIVE RETRIEVAL. Fetches at query time; can surface a
 *                         page within minutes. Poll this FIRST.
 *   - openai            → INGESTION / index refresh. The slow control arm.
 *
 * Everything degrades on a missing key (returns an empty answer → classified
 * `absent`) rather than throwing, so a poll never aborts the run.
 *
 * Run via tsx (`npm run measure`), which resolves the engine's extensionless
 * imports — this module is not meant to load under `node --test`.
 */

import OpenAI from "openai";
import { getCache, setCache } from "../../engine/retrieve/cache.ts";

export interface EngineAnswer {
  answerText: string;
  citedUrls: string[];
}

export type EngineKind = "live_retrieval" | "ingestion";

export interface EngineDef {
  /** Stable identity written into PropagationCheck.engine. */
  name: string;
  kind: EngineKind;
  ask: (query: string) => Promise<EngineAnswer>;
}

const QUERY_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SONAR_MODEL = "perplexity/sonar";
const OPENAI_MODEL = "gpt-5.2";
const NO_CACHE = !!process.env.RETRIEVE_NO_CACHE;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff (1s, 2s, 4s…), honoring a Retry-After hint (seconds). */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return 1000 * Math.pow(2, attempt);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Same prompt the retrieve engine uses, so cached answers line up across tools. */
function prompt(query: string): string {
  return `${query}\n\nList the most authoritative sources and cite their URLs.`;
}

function isEngineAnswer(v: unknown): v is EngineAnswer {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as EngineAnswer).answerText === "string" &&
    Array.isArray((v as EngineAnswer).citedUrls)
  );
}

/** Reuse the disk cache: return a fresh cached answer, else run and cache a non-empty one. */
async function cached(key: string, run: () => Promise<EngineAnswer>): Promise<EngineAnswer> {
  const hit = NO_CACHE ? null : await getCache(key);
  if (isEngineAnswer(hit)) return hit;
  const ans = await run();
  if (ans.answerText || ans.citedUrls.length) await setCache(key, ans);
  return ans;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls.filter(Boolean))];
}

// ── perplexity/sonar via OpenRouter — LIVE RETRIEVAL (poll first) ─────────────

export async function askSonar(query: string): Promise<EngineAnswer> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[measure] OPENROUTER_API_KEY unset — sonar returns empty (→ absent)");
    return { answerText: "", citedUrls: [] };
  }
  return cached(`measure:sonar:${query}`, () => sonarQuery(apiKey, query));
}

async function sonarQuery(apiKey: string, query: string): Promise<EngineAnswer> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://adlayer.dev",
          "X-Title": "AdLayer measurement",
        },
        body: JSON.stringify({
          model: SONAR_MODEL,
          messages: [{ role: "user", content: prompt(query) }],
        }),
      });
      clearTimeout(timer);

      if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt, res.headers.get("Retry-After")));
        continue;
      }
      if (!res.ok) {
        console.warn(`[measure] sonar "${query}" HTTP ${res.status}`);
        return { answerText: "", citedUrls: [] };
      }
      const data: any = await res.json();
      const msg = data?.choices?.[0]?.message ?? {};
      const answerText: string = typeof msg.content === "string" ? msg.content : "";
      // Perplexity surfaces citations two ways through OpenRouter: structured
      // url_citation annotations, and a bare top-level `citations` URL array.
      const fromAnnotations = extractOpenRouterCitations(data);
      const fromTopLevel: string[] = Array.isArray(data?.citations)
        ? data.citations.filter((u: unknown): u is string => typeof u === "string")
        : [];
      return { answerText, citedUrls: dedupe([...fromAnnotations, ...fromTopLevel]) };
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError" && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      console.warn(`[measure] sonar "${query}" failed:`, err?.message ?? err);
      return { answerText: "", citedUrls: [] };
    }
  }
  return { answerText: "", citedUrls: [] };
}

function extractOpenRouterCitations(data: any): string[] {
  const urls: string[] = [];
  for (const ann of data?.choices?.[0]?.message?.annotations ?? []) {
    if (ann?.type === "url_citation") {
      const url = ann?.url_citation?.url ?? ann?.url;
      if (url) urls.push(url);
    }
  }
  return urls;
}

// ── OpenAI Responses API — INGESTION control arm ─────────────────────────────

export async function askOpenAI(query: string): Promise<EngineAnswer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[measure] OPENAI_API_KEY unset — openai returns empty (→ absent)");
    return { answerText: "", citedUrls: [] };
  }
  const client = new OpenAI({ apiKey });
  return cached(`measure:openai:${query}`, () => openAIQuery(client, query));
}

async function openAIQuery(client: OpenAI, query: string): Promise<EngineAnswer> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response: any = await client.responses.create(
        {
          model: OPENAI_MODEL,
          input: prompt(query),
          tools: [{ type: "web_search", search_context_size: "low" } as any],
        },
        { timeout: QUERY_TIMEOUT_MS },
      );
      return {
        answerText: extractOpenAIText(response),
        citedUrls: dedupe(extractOpenAICitations(response)),
      };
    } catch (err: any) {
      const status = err?.status;
      if ((status === 429 || status >= 500) && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt, err?.headers?.["retry-after"]));
        continue;
      }
      console.warn(`[measure] openai "${query}" failed:`, status ?? "", err?.message ?? err);
      return { answerText: "", citedUrls: [] };
    }
  }
  return { answerText: "", citedUrls: [] };
}

function extractOpenAIText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function extractOpenAICitations(response: any): string[] {
  const urls: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      for (const ann of content?.annotations ?? []) {
        if (ann?.type === "url_citation" && ann?.url) urls.push(ann.url);
      }
    }
  }
  return urls;
}

// ── Default engine set — live retrieval FIRST, ingestion as the control arm ───

export const SONAR: EngineDef = { name: "perplexity/sonar", kind: "live_retrieval", ask: askSonar };
export const OPENAI: EngineDef = { name: "openai", kind: "ingestion", ask: askOpenAI };

/** Sonar first. Ingestion engines follow and are reported separately, never averaged. */
export const DEFAULT_ENGINES: EngineDef[] = [SONAR, OPENAI];
