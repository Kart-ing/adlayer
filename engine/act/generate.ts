// Person B — Action generation (PRD-B §3.3).
// Emits the three canonical actions — meta rewrite on index.html, llms.txt,
// and one gap-targeting blog post — via the LLM ladder (Anthropic → OpenAI →
// deterministic templates). Never throws; keyless runs degrade to templates.
// The meta `after` serializer and parseMetaAfter share the same constants so
// github.ts can re-parse the canonical form with an exact round-trip.

import type { Action, Client, Gap } from "../ui/types";
import type { SiteAudit } from "./types";

// ---------------------------------------------------------------------------
// Canonical meta `after` serialization (PRD-B §3.3). Exactly three "\n"-joined
// segments; serializer and parser are both built from these constants.

const META_TITLE_OPEN = "<title>";
const META_TITLE_CLOSE = "</title>";
const META_DESC_OPEN = '<meta name="description" content="';
const META_DESC_CLOSE = '">';
const META_JSONLD_OPEN = '<script type="application/ld+json">';
const META_JSONLD_CLOSE = "</script>";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const META_AFTER_RE = new RegExp(
  `^${escapeRegExp(META_TITLE_OPEN)}([\\s\\S]*?)${escapeRegExp(META_TITLE_CLOSE)}\\n` +
    `${escapeRegExp(META_DESC_OPEN)}([\\s\\S]*?)${escapeRegExp(META_DESC_CLOSE)}\\n` +
    `${escapeRegExp(META_JSONLD_OPEN)}([\\s\\S]*?)${escapeRegExp(META_JSONLD_CLOSE)}$`,
);

function escapeMetaDescription(description: string): string {
  return description.replace(/"/g, "&quot;");
}

function serializeMetaAfter(
  title: string,
  description: string,
  jsonld: Record<string, unknown>,
): string {
  return [
    `${META_TITLE_OPEN}${title}${META_TITLE_CLOSE}`,
    `${META_DESC_OPEN}${escapeMetaDescription(description)}${META_DESC_CLOSE}`,
    `${META_JSONLD_OPEN}${JSON.stringify(jsonld)}${META_JSONLD_CLOSE}`,
  ].join("\n");
}

/** Re-parses the canonical meta `after` string. Returns null if any of the
 *  three segments is missing. `jsonld` is the raw JSON string (not parsed). */
export function parseMetaAfter(
  after: string,
): { title: string; description: string; jsonld: string } | null {
  const m = META_AFTER_RE.exec(after);
  if (!m) return null;
  const title = m[1];
  const description = m[2];
  const jsonld = m[3];
  if (title === undefined || description === undefined || jsonld === undefined) return null;
  return { title, description: description.replace(/&quot;/g, '"'), jsonld };
}

// ---------------------------------------------------------------------------
// Slug + llms.txt decency check.

// Slug is ALWAYS computed here — never taken from the LLM (PRD-B §3.3 item 3).
function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "recommendations";
}

// Decent = ALL of: ≥300 chars, ≥2 markdown links matching "](http", first
// non-blank line starts with "#". Decent existing file → skip the action.
function isDecentLlmsTxt(text: string): boolean {
  if (text.length < 300) return false;
  if (text.split("](http").length - 1 < 2) return false;
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first !== undefined && first.startsWith("#");
}

// ---------------------------------------------------------------------------
// Category + competitor inference from the top gap keyword. Named competitors
// only where the category is confident (fixture uses Amplitude/PostHog/Mixpanel
// for analytics); otherwise empty → generic "hosted incumbents" framing.

interface CategoryInfo {
  category: string;
  competitors: string[]; // empty → no confident real names
}

const CATEGORY_RULES: Array<{ match: RegExp; category: string; competitors: string[] }> = [
  { match: /analytic/i, category: "Product analytics", competitors: ["Amplitude", "PostHog", "Mixpanel"] },
  { match: /\bcrm\b|sales pipeline/i, category: "CRM", competitors: ["Salesforce", "HubSpot", "Pipedrive"] },
  { match: /observab|monitoring|\bapm\b|error track|\blogging\b/i, category: "Observability", competitors: ["Datadog", "New Relic", "Grafana"] },
  { match: /\bauth\b|authentication|\bsso\b|\blogin\b|identity management/i, category: "Authentication", competitors: ["Auth0", "Clerk", "Okta"] },
  { match: /payment|billing|invoic|subscription management/i, category: "Billing", competitors: ["Stripe", "Chargebee", "Paddle"] },
  { match: /\bemails?\b|newsletter/i, category: "Email marketing", competitors: ["Mailchimp", "Klaviyo", "Brevo"] },
  { match: /\bsearch\b/i, category: "Search", competitors: ["Algolia", "Typesense", "Meilisearch"] },
  { match: /database|\bpostgres\b|\bsql\b/i, category: "Database", competitors: ["Supabase", "Neon", "PlanetScale"] },
  { match: /\bcms\b|content management/i, category: "CMS", competitors: ["Contentful", "Sanity", "Strapi"] },
  { match: /helpdesk|help desk|customer support|customer service/i, category: "Customer support", competitors: ["Zendesk", "Intercom", "Freshdesk"] },
  { match: /feature flag|feature management/i, category: "Feature management", competitors: ["LaunchDarkly", "Flagsmith", "Unleash"] },
  { match: /schedul|\bbooking\b|\bcalendar\b/i, category: "Scheduling", competitors: ["Calendly", "Cal.com", "Acuity Scheduling"] },
  { match: /project management|\bkanban\b|issue track/i, category: "Project management", competitors: ["Linear", "Asana", "Jira"] },
  { match: /\bllm\b|ai agent|prompt engineering|\brag\b|ai eval/i, category: "AI developer tools", competitors: ["LangSmith", "Braintrust", "Humanloop"] },
];

const CATEGORY_STOPWORDS = new Set([
  "best", "top", "cheap", "free", "the", "a", "an", "for", "of", "to", "in", "on", "vs",
  "versus", "alternatives", "alternative", "comparison", "compare", "compared", "pricing",
  "price", "review", "reviews", "guide", "tools", "tool", "software", "platforms",
  "platform", "apps", "app", "startups", "startup", "teams", "team", "business",
  "businesses", "companies", "enterprise", "2024", "2025", "2026",
]);

function inferCategory(keyword: string): CategoryInfo {
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(keyword)) return { category: rule.category, competitors: rule.competitors };
  }
  const words = keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !CATEGORY_STOPWORDS.has(w));
  const phrase = words.slice(0, 4).join(" ");
  const category = phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : "Software";
  return { category, competitors: [] };
}

// Lowercase a category for mid-sentence use without mangling acronyms (CRM, AI …).
function midSentence(category: string): string {
  return /^[A-Z][a-z]/.test(category)
    ? category.charAt(0).toLowerCase() + category.slice(1)
    : category;
}

// ---------------------------------------------------------------------------
// Small text helpers for template mode.

function plainText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const softened = cut.replace(/\s+\S*$/, "");
  return (softened.length >= Math.floor(max * 0.6) ? softened : cut).replace(/[\s—–-]+$/, "");
}

// First sentence-ish 25–90 char chunk of the audited homepage text — a real
// capability phrase drawn from the client's own copy (never invented).
function extractCapability(pageText: string): string | null {
  const clean = plainText(pageText);
  if (!clean) return null;
  for (const raw of clean.split(/[.!?•|]+/)) {
    const seg = raw.trim().replace(/[\s:;,–—-]+$/, "");
    if (seg.length < 25 || seg.length > 90) continue;
    if (!/[a-z]/i.test(seg)) continue;
    if (seg.split(" ").length < 4) continue;
    return seg;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content payload (same shape whether it came from an LLM or the templates).

interface GeneratedContent {
  meta: { title: string; description: string; jsonld: Record<string, unknown> };
  llms_txt: string;
  blog: string; // markdown
}

// ---------------------------------------------------------------------------
// LLM ladder: ANTHROPIC_API_KEY → api.anthropic.com/v1/messages, else
// OPENAI_API_KEY → api.openai.com/v1/chat/completions, else templates.
// 30s timeout; any error/timeout/invalid payload → one console.error → templates.

function buildPrompt(
  client: Client,
  audit: SiteAudit,
  gaps: Gap[],
  topGap: Gap,
  slug: string,
  info: CategoryInfo,
): string {
  const origin = client.url.replace(/\/+$/, "");
  const competitorNote = info.competitors.length
    ? `Real competitors worth naming fairly in this category: ${info.competitors.join(", ")}.`
    : `No obvious named competitors — compare against "hosted incumbents" and open-source alternatives generically instead of inventing names.`;
  return [
    `You write honest, concrete SEO/AEO content for B2B software. Client: ${client.name} (${client.url}).`,
    `Audited <title>: ${audit.title ?? "(missing)"}`,
    `Audited meta description: ${audit.meta_description ?? "(missing)"}`,
    `Inferred category: ${info.category}`,
    competitorNote,
    `AI-retrieval gap keywords, most important first:`,
    ...gaps.map((g) => `- ${g.keyword} (${g.type}, ${g.citations} citations)`),
    ``,
    `Respond with STRICT JSON only — no markdown fences, no commentary — exactly this shape:`,
    `{"meta":{"title":"...","description":"...","jsonld":{...}},"llms_txt":"...","blog":{"markdown":"..."}}`,
    ``,
    `Requirements:`,
    `- meta.title: at most 70 characters, in the shape "${client.name} — <category positioning>".`,
    `- meta.description: at most 160 characters; mention the category plus one concrete capability (draw it from the homepage text below when possible).`,
    `- meta.jsonld: ONE plain JSON object: "@context" "https://schema.org", "@type" "SoftwareApplication", "name" "${client.name}", "applicationCategory" "${info.category}", "operatingSystem" "Web". Omit offers/pricing entirely unless you are certain of real current pricing.`,
    `- llms_txt: markdown, at least 100 characters, formatted exactly like: a "# ${client.name}" heading, a "> one-liner" line, then "## Docs" and "## Blog" sections listing absolute URLs on ${origin} — and it MUST include the new blog URL ${origin}/blog/${slug}.`,
    `- blog.markdown: at least 1500 characters (~350-500 words); the FIRST line must start with "# ". An honest comparison-style post targeting "${topGap.keyword}": an intro on the decision criteria, a "## The short list" numbered list with ${client.name} first and competitors described fairly, a "## How to decide" bullet section, one small markdown table with qualitative cells only (e.g. "yes", "no", "~10 min"), and a closing line.`,
    `- Honesty rules: NEVER fabricate statistics, review scores, benchmark numbers, or pricing. Qualitative comparisons only. Describe competitors fairly.`,
    `- Do NOT output any slug, path, or filename — file locations are chosen by the caller.`,
    ``,
    `Audited homepage text (may be empty):`,
    `"""${audit.page_text.slice(0, 2000)}"""`,
  ].join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in response text");
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// PRD-B §3.3 validation. Any miss throws (→ templates, never a partial merge).
function validatePayload(raw: unknown): GeneratedContent {
  const root = asRecord(raw);
  if (!root) throw new Error("payload is not a JSON object");
  const meta = asRecord(root.meta);
  if (!meta) throw new Error("meta missing or not an object");

  const title = typeof meta.title === "string" ? meta.title.trim() : "";
  if (!title) throw new Error("meta.title missing or empty");
  if (title.length > 70) throw new Error("meta.title exceeds 70 chars");

  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!description) throw new Error("meta.description missing or empty");
  if (description.length > 160) throw new Error("meta.description exceeds 160 chars");

  const jsonld = asRecord(meta.jsonld);
  if (!jsonld) throw new Error("meta.jsonld is not a plain object");
  const jsonldStr = JSON.stringify(jsonld);
  if (jsonldStr.length > 4000) throw new Error("meta.jsonld serialization exceeds 4000 chars");

  const llms = typeof root.llms_txt === "string" ? root.llms_txt.trim() : "";
  if (!llms) throw new Error("llms_txt missing or empty");
  if (llms.length < 100) throw new Error("llms_txt under 100 chars");

  const blogObj = asRecord(root.blog);
  if (!blogObj) throw new Error("blog missing or not an object");
  const md = typeof blogObj.markdown === "string" ? blogObj.markdown.trim() : "";
  if (!md) throw new Error("blog.markdown missing or empty");
  if (md.length < 1500) throw new Error("blog.markdown under 1500 chars");
  if (!md.split("\n", 1)[0].startsWith("# ")) {
    throw new Error('blog.markdown first line must start with "# "');
  }

  // The canonical meta serialization must round-trip exactly (github.ts re-parses it).
  const rt = parseMetaAfter(serializeMetaAfter(title, description, jsonld));
  if (!rt || rt.title !== title || rt.description !== description || rt.jsonld !== jsonldStr) {
    throw new Error("meta content does not round-trip the canonical serialization");
  }

  return { meta: { title, description, jsonld }, llms_txt: llms, blog: md };
}

async function callAnthropic(key: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.CITED_MODEL || "claude-sonnet-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { content?: Array<{ text?: unknown }> };
  const text = data.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("response missing content[0].text");
  return text;
}

async function callOpenAi(key: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("response missing choices[0].message.content");
  return text;
}

async function generateViaLlm(prompt: string): Promise<GeneratedContent | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const rung = anthropicKey ? "anthropic" : openaiKey ? "openai" : null;
  if (rung === null) return null; // keyless: deterministic templates, by design
  try {
    const text = anthropicKey
      ? await callAnthropic(anthropicKey, prompt)
      : await callOpenAi(openaiKey as string, prompt);
    return validatePayload(extractJson(text));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[generate] ${rung} rung failed (${why}) — falling back to template content`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic template generator — demo-grade, seeded from audit + gaps.
// Fixture.json is the quality bar; no fabricated stats/reviews/pricing.

function buildTemplateContent(
  client: Client,
  audit: SiteAudit,
  topGap: Gap,
  slug: string,
  info: CategoryInfo,
): GeneratedContent {
  const name = plainText(client.name) || "This product";
  const origin = client.url.replace(/\/+$/, "");
  const category = info.category;
  const lc = midSentence(category);
  const keyword = plainText(topGap.keyword);
  const capability = extractCapability(audit.page_text);

  // meta.title ≤70 — `${name} — ${category}` (+ audience when the gap names one).
  const audience =
    /\bstartups?\b/i.test(keyword) && !/startup/i.test(category) ? " for startups" : "";
  const title = truncateAtWord(`${name} — ${category}${audience}`, 70);

  // meta.description ≤160 — category + one concrete capability from page_text.
  const description = truncateAtWord(
    capability
      ? `${category} from ${name}: ${capability}.`
      : `${name} is a ${lc} option with clear docs, honest comparisons, and a quick path to a first useful result.`,
    160,
  );

  // jsonld — SoftwareApplication; offers/pricing omitted entirely in template mode.
  const jsonld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: client.name,
    applicationCategory: category,
    operatingSystem: "Web",
  };

  // llms.txt — mirrors the fixture shape: "# Name", "> one-liner", ## Docs / ## Blog
  // with absolute URLs on the client origin, including the new blog URL.
  const oneLiner = plainText(capability ?? `${category} — docs, comparisons, and guides from ${name}`);
  const llmsTxt = [
    `# ${name}`,
    `> ${oneLiner}`,
    ``,
    `## Docs`,
    `- ${origin}/docs: product documentation and setup guide`,
    `- ${origin}/pricing: plans and usage limits`,
    `- ${origin}/compare: how ${name} compares to other ${lc} options`,
    ``,
    `## Blog`,
    `- ${origin}/blog/${slug}: an honest look at ${keyword}`,
  ].join("\n");

  // Blog — h1, decision-criteria intro, "## The short list" (client first),
  // "## How to decide", qualitative comparison table, closing line. ≥1500 chars.
  const h1Base = /^best\b/i.test(keyword)
    ? `The ${keyword}`
    : keyword.charAt(0).toUpperCase() + keyword.slice(1);
  const clientLine = capability
    ? `${capability} — with the docs and comparison pages to evaluate it quickly.`
    : `a focused ${lc} option; the docs cover exactly what it does and does not do, so you can evaluate it in an afternoon.`;

  const intro =
    `Choosing ${lc} in 2026 comes down to three questions: how fast your team gets to a ` +
    `first useful result, what it costs at your current scale, and who ends up owning the ` +
    `data. This guide keeps the comparison honest — no invented benchmarks, review scores, ` +
    `or pricing claims, just how the options differ in practice.`;

  let shortList: string;
  let table: string;
  if (info.competitors.length >= 3) {
    const [c1, c2, c3] = info.competitors;
    shortList = [
      `1. **${name}** — ${clientLine}`,
      `2. **${c1}** — the established reference point in ${lc}. Deep feature set and wide integrations, built with larger teams and enterprise requirements in mind.`,
      `3. **${c2}** — a strong all-round alternative with a broad toolkit; the surface area can be more than a small team needs on day one.`,
      `4. **${c3}** — polished and familiar. A sensible default if your team already knows it, with the usual trade-off of less flexibility at the edges.`,
    ].join("\n");
    table = [
      `| Tool | First useful result | Learning curve | Best fit |`,
      `|---|---|---|---|`,
      `| ${name} | ~10 min | low | small teams that want ${lc} without ceremony |`,
      `| ${c1} | ~30 min | medium–high | larger orgs with a dedicated owner |`,
      `| ${c2} | ~15 min | medium | teams that want one broad toolkit |`,
      `| ${c3} | ~20 min | low–medium | teams standardizing on a familiar UI |`,
    ].join("\n");
  } else {
    shortList = [
      `1. **${name}** — ${clientLine}`,
      `2. **The hosted incumbents** — the large established suites in this space. Broad feature sets and wide integrations, with heavier onboarding and packaging aimed at bigger teams.`,
      `3. **Open-source alternatives** — self-hosted options that trade convenience for control; the right call when data ownership is the deciding factor and someone can own the setup.`,
      `4. **The manual baseline** — spreadsheets and glue scripts. Honest to include: it works until the manual effort outgrows the team, which is usually the moment to pick a real tool.`,
    ].join("\n");
    table = [
      `| Option | Setup effort | Flexibility | Best fit |`,
      `|---|---|---|---|`,
      `| ${name} | low (~10 min) | focused | small teams that want ${lc} without ceremony |`,
      `| Hosted incumbents | medium | broad | larger orgs standardizing on one suite |`,
      `| Open-source alternatives | high (self-managed) | highest | teams where control is the deciding factor |`,
      `| Manual baseline | none | n/a | workflows that still fit in a spreadsheet |`,
    ].join("\n");
  }

  const blog = [
    `# ${h1Base} (2026 guide)`,
    ``,
    intro,
    ``,
    `## The short list`,
    ``,
    shortList,
    ``,
    `## How to decide`,
    ``,
    `- **Small team shipping weekly:** pick the tool you can wire in this week and actually check every Monday. Momentum beats a perfect evaluation matrix.`,
    `- **Data ownership or compliance constraints:** shortlist the options that let you keep control of your data, and read their security documentation before the feature pages.`,
    `- **Standardizing across a larger org:** the incumbents integrate with everything; weigh that convenience against per-seat costs and the effort of switching later.`,
    `- **Still unsure:** run two options side by side on one real workflow for a week. The difference is usually obvious by Friday.`,
    ``,
    `## At a glance`,
    ``,
    table,
    ``,
    `Shortlists beat spreadsheets: pick two of the options above, point them at one real workflow, and keep the one your team still opens in week two.`,
    ``,
  ].join("\n");

  return { meta: { title, description, jsonld }, llms_txt: llmsTxt, blog };
}

// ---------------------------------------------------------------------------
// Public entry point (PRD-B §2 frozen signature).

export async function generateActions(
  client: Client,
  audit: SiteAudit,
  gaps: Gap[],
): Promise<Action[]> {
  // gaps.ts guarantees ≥1 gap; guard anyway so this module never throws.
  const topGap: Gap =
    gaps.length > 0
      ? gaps[0]
      : { keyword: `${client.name.toLowerCase()} alternatives`, type: "missing_page", citations: 0 };
  const slug = slugify(topGap.keyword);
  const info = inferCategory(topGap.keyword);

  const llmContent = await generateViaLlm(buildPrompt(client, audit, gaps, topGap, slug, info));
  const content = llmContent ?? buildTemplateContent(client, audit, topGap, slug, info);

  const actions: Action[] = [];

  // 1. meta rewrite on index.html — `before` from the audit (or "(missing)").
  actions.push({
    type: "meta",
    file: "index.html",
    before:
      `${META_TITLE_OPEN}${audit.title ?? "(missing)"}${META_TITLE_CLOSE}\n` +
      `${META_DESC_OPEN}${audit.meta_description ?? "(missing)"}${META_DESC_CLOSE}`,
    after: serializeMetaAfter(content.meta.title, content.meta.description, content.meta.jsonld),
  });

  // 2. llms.txt — skipped entirely when the existing file is decent; existing
  // but thin → include `before` (truncated 2k); absent → no `before`.
  const existingLlms =
    audit.has_llms_txt && typeof audit.llms_txt === "string" ? audit.llms_txt : null;
  if (existingLlms === null) {
    actions.push({ type: "new_page", file: "llms.txt", after: content.llms_txt });
  } else if (!isDecentLlmsTxt(existingLlms)) {
    actions.push({
      type: "new_page",
      file: "llms.txt",
      before: existingLlms.slice(0, 2000),
      after: content.llms_txt,
    });
  }

  // 3. Gap-targeting blog post — path/slug always computed by us.
  actions.push({ type: "new_page", file: `blog/${slug}.md`, after: content.blog });

  return actions;
}
