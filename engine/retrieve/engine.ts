// LLM answer-engine adapters. Each runs the full query list and returns the URLs
// the engine cited per query. Primary: OpenAI Responses API (web_search tool,
// structured url_citation annotations). Fallback: OpenRouter :online.
//
// Both engines cache per-query results to disk and never throw — a failed query
// yields an empty url list rather than aborting the run.

import { createRequire } from "module";
import OpenAI from "openai";
import { EngineResult } from "./types";
import { getCache, setCache } from "./cache";

const OPENAI_MODEL = "gpt-5.2";
const OPENROUTER_MODEL = "openai/gpt-5.2:online";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// DeepSeek's API has NO built-in web search (even V4 Pro) — it answers from
// training memory and we regex URLs out of the text. Domains are a real
// brand-association signal; the exact URLs are recalled, not browsed.
// (deepseek-chat / deepseek-reasoner are discontinued 2026-07-24 → use V4.)
const DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export const QUERY_TIMEOUT_MS = 45000;
const MAX_RETRIES = 2;
export const CONCURRENCY = Number(process.env.RETRIEVE_CONCURRENCY ?? 4);
// "low" is fastest; bump to medium/high to trade latency for richer citations.
const SEARCH_CONTEXT_SIZE = (process.env.OPENAI_SEARCH_CONTEXT_SIZE || "low") as
  | "low"
  | "medium"
  | "high";

// Shared keep-alive dispatcher so the raw-fetch engines (OpenRouter, DeepSeek)
// reuse TCP+TLS connections across queries instead of a fresh handshake each
// time. Guarded: if undici isn't importable we fall back to fetch's global
// dispatcher (which also pools), so this can never break the run.
const keepAliveDispatcher = (() => {
  try {
    const req = createRequire(import.meta.url);
    const { Agent } = req("undici");
    return new Agent({
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      connections: 64,
    });
  } catch {
    return undefined;
  }
})();
const dispatcherInit: Record<string, unknown> = keepAliveDispatcher
  ? { dispatcher: keepAliveDispatcher }
  : {};

const RETRYABLE_ERROR_NAMES = new Set([
  "APIConnectionTimeoutError",
  "APIConnectionError",
  "AbortError",
]);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableErr(err: any): boolean {
  if (typeof err?.status === "number" && isRetryableStatus(err.status)) return true;
  if (err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET") return true;
  if (err?.type === "request_timeout") return true;
  if (err?.name && RETRYABLE_ERROR_NAMES.has(err.name)) return true;
  return false;
}

/** Exponential backoff (1s, 2s, 4s…), honoring a Retry-After hint (seconds) when present. */
function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return 1000 * Math.pow(2, attempt);
}

/** Run `fn` over items with at most `limit` in flight; preserves input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEBUG = !!process.env.RETRIEVE_DEBUG;
const VERBOSE = !!process.env.RETRIEVE_VERBOSE || DEBUG;
const NO_CACHE = !!process.env.RETRIEVE_NO_CACHE;

function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[retrieve]", ...args);
}
function verbose(...args: unknown[]): void {
  if (VERBOSE) console.error("  ·", ...args);
}

function prompt(query: string): string {
  return `${query}\n\nList the most authoritative sources and cite their URLs.`;
}

export async function runOpenAI(queries: string[]): Promise<EngineResult[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const client = new OpenAI({ apiKey });

  return mapPool(queries, CONCURRENCY, async (query) => {
    const urls = await cached("openai", query, () => openAIQuery(client, query));
    return { query, urls, source: "openai" as const };
  });
}

export async function runOpenRouter(queries: string[]): Promise<EngineResult[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return [];

  return mapPool(queries, CONCURRENCY, async (query) => {
    const urls = await cached("openrouter", query, () => openRouterQuery(apiKey, query));
    return { query, urls, source: "openrouter" as const };
  });
}

export async function runDeepSeek(queries: string[]): Promise<EngineResult[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];

  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });

  return mapPool(queries, CONCURRENCY, async (query) => {
    const urls = await cached("deepseek", query, () => deepSeekQuery(client, query));
    return { query, urls, source: "deepseek" as const };
  });
}

/** Cache wrapper: reuse a fresh cached url list, else run and cache non-empty results. */
async function cached(
  engine: string,
  query: string,
  run: () => Promise<string[]>
): Promise<string[]> {
  const key = `${engine}:${query}`;
  const hit = NO_CACHE ? null : await getCache(key);
  if (Array.isArray(hit)) {
    verbose(`${engine} ▸ "${query}" → ${hit.length} urls (cache)`);
    return hit as string[];
  }

  const t = Date.now();
  const urls = await run();
  verbose(`${engine} ▸ "${query}" → ${urls.length} urls (${Date.now() - t}ms)`);
  if (urls.length) await setCache(key, urls);
  return urls;
}

async function openAIQuery(client: OpenAI, query: string): Promise<string[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.responses.create(
        {
          model: OPENAI_MODEL,
          input: prompt(query),
          tools: [{ type: "web_search", search_context_size: SEARCH_CONTEXT_SIZE } as any],
        },
        { timeout: QUERY_TIMEOUT_MS }
      );
      return dedupe(extractOpenAICitations(response));
    } catch (err: any) {
      if (isRetryableErr(err) && attempt < MAX_RETRIES) {
        const delay = backoffMs(attempt, err?.headers?.["retry-after"]);
        debug(`openai retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: "${query}"`, err?.status ?? "");
        await sleep(delay);
        continue;
      }
      debug(`openai "${query}" failed:`, err?.status ?? "", err?.message ?? err);
      return [];
    }
  }
  return [];
}

async function openRouterQuery(apiKey: string, query: string): Promise<string[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: controller.signal,
        ...dispatcherInit,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://cited.dev",
          "X-Title": "CITED",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [{ role: "user", content: prompt(query) }],
        }),
      } as any);
      clearTimeout(timer);

      if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
        const delay = backoffMs(attempt, res.headers.get("Retry-After"));
        debug(`openrouter retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: "${query}" (HTTP ${res.status})`);
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        debug(`openrouter "${query}" HTTP ${res.status}:`, (await res.text()).slice(0, 200));
        return [];
      }
      return dedupe(extractOpenRouterCitations(await res.json()));
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError" && attempt < MAX_RETRIES) {
        const delay = backoffMs(attempt);
        debug(`openrouter retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: "${query}" (timeout)`);
        await sleep(delay);
        continue;
      }
      debug(`openrouter "${query}" failed:`, err?.message ?? err);
      return [];
    }
  }
  return [];
}

async function deepSeekQuery(client: OpenAI, query: string): Promise<string[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create(
        {
          model: DEEPSEEK_MODEL,
          messages: [
            {
              role: "user" as const,
              content:
                `${query}\n\nList the leading companies, products or resources. ` +
                `For each, give its official website as a full https:// URL.`,
            },
          ],
        },
        { timeout: QUERY_TIMEOUT_MS }
      );
      const text = (response as any).choices?.[0]?.message?.content ?? "";
      return dedupe(extractUrlsFromText(text));
    } catch (err: any) {
      if (isRetryableErr(err) && attempt < MAX_RETRIES) {
        const delay = backoffMs(attempt, err?.headers?.["retry-after"]);
        debug(`deepseek retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: "${query}"`, err?.status ?? "");
        await sleep(delay);
        continue;
      }
      debug(`deepseek "${query}" failed:`, err?.status ?? "", err?.message ?? err);
      return [];
    }
  }
  return [];
}

/** Pull bare http(s) URLs out of free text, trimming trailing punctuation/markdown. */
function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]}"'<>]+/g) ?? [];
  return matches.map((u) => u.replace(/[.,;:!?)\]}>'"]+$/, ""));
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

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
