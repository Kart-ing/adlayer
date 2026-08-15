// Fetch the client homepage and extract a category + keyword seed for queries.
// Best-effort: any failure falls back to a slug derived from the hostname.

export interface ScrapeResult {
  category: string;
  keywords: string[];
}

// On cached runs the homepage scrape is the only network call, so it sets the
// floor latency for every run. 5s is plenty for a live site; override if needed.
const FETCH_TIMEOUT_MS = parseInt(process.env.SCRAPE_TIMEOUT || "5000", 10);

/**
 * Scrape the homepage for <title>, meta description, meta keywords and OG tags,
 * returning a category string and a list of seed keywords. Never throws.
 */
export async function scrapeHomepage(clientUrl: string): Promise<ScrapeResult> {
  // Operator override — a scan parameter (like any SEO tool's keyword input).
  // Rescues sites whose title taglines derive garbage categories.
  if (process.env.RETRIEVE_CATEGORY) {
    return { category: process.env.RETRIEVE_CATEGORY.toLowerCase(), keywords: [] };
  }
  const url = normalizeUrl(clientUrl);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CITED-bot/0.1)" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const html = await res.text();
      const parsed = parseMeta(html);
      // Read the site first: LLM classifies what the company actually does
      // from its own homepage, so queries match how buyers search. Heuristic
      // title-parsing is the fallback (it mangles taglines like "The
      // open-source platform for everything user" → garbage queries).
      const llm = await llmCategorize(html, parsed);
      if (llm) return llm;
      if (parsed.category || parsed.keywords.length) return parsed;
    }
  } catch {
    // fall through to hostname fallback
  }
  return { category: hostnameSlug(url), keywords: [] };
}

/** LLM categorization from the homepage itself (title + description + visible
 *  text). Strict JSON, 15s timeout, null on any failure — never throws. */
async function llmCategorize(html: string, parsed: ScrapeResult): Promise<ScrapeResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const title = readTitle(html) ?? "";
    const description = readMeta(html, "description") ?? readMeta(html, "og:description") ?? "";
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 2500);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `Classify what this company sells from its homepage. Return STRICT JSON: ` +
              `{"category":"2-5 word product category phrased the way a buyer would search ` +
              `(e.g. \\"user authentication platform\\", \\"product analytics tool\\")",` +
              `"keywords":["up to 4 distinguishing keywords"]}\n\n` +
              `TITLE: ${title}\nDESCRIPTION: ${description}\nPAGE TEXT: ${text}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      category?: unknown;
      keywords?: unknown;
    };
    const category = typeof obj.category === "string" ? obj.category.trim().toLowerCase() : "";
    if (category.length < 3 || category.length > 60 || category.split(/\s+/).length > 6) {
      throw new Error("category failed validation");
    }
    const keywords = Array.isArray(obj.keywords)
      ? obj.keywords.filter((k): k is string => typeof k === "string" && !!k.trim()).slice(0, 4)
      : [];
    console.error(`[scrape] LLM category: "${category}" (heuristic was "${parsed.category}")`);
    return { category, keywords: keywords.map((k) => k.toLowerCase()) };
  } catch (e) {
    console.error(`[scrape] LLM categorization failed (${e instanceof Error ? e.message : e}) — using heuristic`);
    return null;
  }
}

function parseMeta(html: string): ScrapeResult {
  const metaKeywords = readMeta(html, "keywords");
  const description = readMeta(html, "description") ?? readMeta(html, "og:description");
  const title = readTitle(html) ?? readMeta(html, "og:title");

  const keywords = new Set<string>();
  if (metaKeywords) {
    for (const k of metaKeywords.split(",").map((s) => s.trim()).filter(Boolean)) {
      keywords.add(k.toLowerCase());
    }
  }

  let category = "";
  if (keywords.size) {
    category = [...keywords][0];
  } else if (title) {
    category = cleanTitle(title);
  } else if (description) {
    category = description.split(/[.,]/)[0].trim();
  }

  return { category: category.toLowerCase(), keywords: [...keywords] };
}

function readTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function readMeta(html: string, name: string): string | null {
  // Handle both attribute orders: name/property first, or content first.
  const attr = `(?:name|property)=["']${escapeRe(name)}["']`;
  const content = `content=["']([^"']*)["']`;
  const forward = html.match(new RegExp(`<meta[^>]+${attr}[^>]*${content}`, "i"));
  if (forward) return decodeEntities(forward[1].trim());
  const backward = html.match(new RegExp(`<meta[^>]+${content}[^>]*${attr}`, "i"));
  return backward ? decodeEntities(backward[1].trim()) : null;
}

/** Take the descriptive segment of a title, dropping a leading brand name. */
function cleanTitle(title: string): string {
  const segments = title.split(/[|\-–—:•]/).map((s) => s.trim()).filter(Boolean);
  // Prefer the longest segment — usually the descriptive phrase, not the brand.
  return segments.sort((a, b) => b.length - a.length)[0] ?? title.trim();
}

function normalizeUrl(url: string): string {
  return url.includes("://") ? url : `https://${url}`;
}

function hostnameSlug(url: string): string {
  try {
    const host = new URL(normalizeUrl(url)).hostname.replace(/^www\./, "");
    const label = host.split(".")[0] ?? host;
    return label.replace(/[-_]+/g, " ").trim();
  } catch {
    return url;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
