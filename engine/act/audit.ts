// Person B — Action (PRD-B §3.1)
// Site audit: fetch client homepage + {origin}/llms.txt + {origin}/sitemap.xml
// and extract title / meta description / schema.org / content signals using
// regex + string ops only (no HTML-parser dep). The three fetches degrade
// independently — this module never throws.

import type { SiteAudit } from "./types";

const TEXT_CAP = 20_000;
const SITEMAP_CAP = 200;

// Minimal entity decode; &amp; last so &amp;lt; doesn't double-decode.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const title = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : null;
}

// Handles attribute-order variants: name before/after content, '/" quoting.
function extractMetaDescription(html: string): string | null {
  const nameFirst =
    /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  const contentFirst =
    /<meta\b[^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\bname\s*=\s*["']description["']/i;
  const m = html.match(nameFirst) ?? html.match(contentFirst);
  if (!m) return null;
  const value = decodeEntities(m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : null;
}

// Collect "@type" values from parsed JSON-LD, including arrays and @graph.
function collectTypes(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  if (typeof t === "string") out.push(t);
  else if (Array.isArray(t)) for (const v of t) if (typeof v === "string") out.push(v);
  if (Array.isArray(obj["@graph"])) collectTypes(obj["@graph"], out);
}

function extractSchema(html: string): { has: boolean; types: string[] } {
  const types: string[] = [];
  let parsedAny = false;
  const re =
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      collectTypes(JSON.parse(m[1]), types);
      parsedAny = true;
    } catch {
      // malformed JSON-LD block — skip it
    }
  }
  return { has: parsedAny, types: [...new Set(types)] };
}

function extractHeadHtml(html: string): string {
  const m = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1].slice(0, TEXT_CAP) : "";
}

// Visible text: drop <head>/<script>/<style> blocks + comments, strip tags,
// decode entities, collapse whitespace, cap.
function extractPageText(html: string): string {
  const stripped = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim().slice(0, TEXT_CAP);
}

type HomepageSignals = Pick<
  SiteAudit,
  "ok" | "title" | "meta_description" | "has_schema_org" | "schema_types" | "page_text" | "head_html"
>;
type LlmsSignals = Pick<SiteAudit, "has_llms_txt" | "llms_txt">;

function degradedHomepage(): HomepageSignals {
  return {
    ok: false,
    title: null,
    meta_description: null,
    has_schema_org: false,
    schema_types: [],
    page_text: "",
    head_html: "",
  };
}

async function fetchHomepage(url: string, timeoutMs: number): Promise<HomepageSignals> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return degradedHomepage();
    const html = await res.text();
    const schema = extractSchema(html);
    return {
      ok: true,
      title: extractTitle(html),
      meta_description: extractMetaDescription(html),
      has_schema_org: schema.has,
      schema_types: schema.types,
      page_text: extractPageText(html),
      head_html: extractHeadHtml(html),
    };
  } catch {
    return degradedHomepage();
  }
}

async function fetchLlmsTxt(origin: string | null, timeoutMs: number): Promise<LlmsSignals> {
  const missing: LlmsSignals = { has_llms_txt: false, llms_txt: null };
  if (!origin) return missing;
  try {
    const res = await fetch(`${origin}/llms.txt`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return missing;
    const body = await res.text();
    // A body starting with "<" is an HTML fallback/404 page, not a real llms.txt.
    if (body.trimStart().startsWith("<")) return missing;
    return { has_llms_txt: true, llms_txt: body.slice(0, TEXT_CAP) };
  } catch {
    return missing;
  }
}

async function fetchSitemap(origin: string | null, timeoutMs: number): Promise<string[]> {
  if (!origin) return [];
  try {
    const res = await fetch(`${origin}/sitemap.xml`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const urls: string[] = [];
    const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null && urls.length < SITEMAP_CAP) {
      const loc = decodeEntities(
        m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1"),
      ).trim();
      if (loc) urls.push(loc);
    }
    return urls;
  } catch {
    return [];
  }
}

export async function auditSite(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<SiteAudit> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const fetched_at = new Date().toISOString();

  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    // unparseable url — homepage fetch degrades too; skip origin-based fetches
  }

  const [home, llms, sitemap_urls] = await Promise.all([
    fetchHomepage(url, timeoutMs),
    fetchLlmsTxt(origin, timeoutMs),
    fetchSitemap(origin, timeoutMs),
  ]);

  return { url, fetched_at, ...home, ...llms, sitemap_urls };
}
