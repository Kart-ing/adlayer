import OpenAI from "openai";

export interface TargetVerdict {
  domain: string;
  category: "chamber" | "directory" | "association" | "blog" | "listicle" | "other";
  is_competitor: boolean;
  callable: boolean;
  reason: string;
}

const VALID_CATEGORIES = new Set([
  "chamber", "directory", "association", "blog", "listicle", "other",
]);

const SYSTEM_PROMPT = `You are a domain classifier for a link-building outreach campaign.

CONTEXT: A local business (the "client") is building backlinks. For each candidate domain you are given, decide whether it is a link-granting organisation (chamber of commerce, business directory, trade association, blog, or roundup/listicle publisher) that the client SHOULD phone, OR a direct COMPETITOR that the client must NEVER phone.

DEFINITIONS:
- "competitor" means the candidate sells the SAME SERVICE to the SAME KIND of customer as the client. A directory, marketplace, review site, chamber of commerce, association, news site, or blog is NEVER a competitor — even when its domain name, title, or description contains the client's trade words. A plumbing contractor listed on a plumbing-directory domain is still a directory, not a plumber.
- "callable" means a human at that organisation could plausibly add or approve a listing/link for the client. Directories, chambers, associations, local blogs, and roundup/listicle publishers are callable. Competitors are never callable. Huge consumer platforms with no reachable listings desk (search engines, social networks, Wikipedia, Reddit, YouTube, Facebook, Instagram, TikTok, LinkedIn, Twitter/X, Pinterest, Amazon, Apple, Google) are not callable.

RULES:
- is_competitor MUST be false when category is chamber, directory, association, blog, or listicle.
- callable is true ONLY when is_competitor is false AND the organisation is reachable for listings.
- reason is one short clause, maximum 15 words.`;

function buildUserPrompt(
  client: { name: string; trade: string | null; locality: string | null },
  candidates: { domain: string; title: string | null; description: string | null }[],
): string {
  const lines: string[] = [];
  lines.push(`CLIENT:`);
  lines.push(`  name: ${client.name}`);
  if (client.trade) lines.push(`  trade: ${client.trade}`);
  if (client.locality) lines.push(`  locality: ${client.locality}`);

  lines.push("");
  lines.push("CANDIDATES:");
  candidates.forEach((c, i) => {
    lines.push(`  ${i + 1}. domain: ${c.domain}`);
    if (c.title) lines.push(`     title: ${c.title}`);
    if (c.description) lines.push(`     description: ${c.description}`);
  });

  lines.push("");
  lines.push(`Return STRICT JSON: {"verdicts":[{"domain":"…","category":"…","is_competitor":bool,"callable":bool,"reason":"…"}]} and nothing else.`);

  return lines.join("\n");
}

function parseLoose(raw: string | null): unknown {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  s = s.replace(/^\s*```(?:json)?\s*\n?/, "");
  s = s.replace(/\n?\s*```\s*$/, "");

  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }

  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(s.slice(firstBrace, lastBrace + 1));
    } catch {
      // fall through
    }
  }

  const firstBracket = s.indexOf("[");
  const lastBracket = s.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(s.slice(firstBracket, lastBracket + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

function normalizeCategory(raw: unknown): TargetVerdict["category"] {
  if (typeof raw !== "string") return "other";
  const lowered = raw.trim().toLowerCase();
  if (VALID_CATEGORIES.has(lowered as TargetVerdict["category"])) {
    return lowered as TargetVerdict["category"];
  }
  return "other";
}

function buildVerdictsFromRaw(
  data: unknown,
  candidates: { domain: string }[],
): TargetVerdict[] {
  const verdicts: TargetVerdict[] = [];
  const candidateDomains = new Set(candidates.map((c) => c.domain.toLowerCase()));

  let rawList: unknown[] | null = null;

  if (data !== null && typeof data === "object") {
    if ("verdicts" in (data as Record<string, unknown>)) {
      rawList = (data as Record<string, unknown>).verdicts as unknown[];
    } else if (Array.isArray(data)) {
      rawList = data;
    }
  }

  if (!Array.isArray(rawList)) return [];

  for (const entry of rawList) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const domain = typeof e.domain === "string" ? e.domain.trim() : "";
    if (!domain) continue;

    const originalDomain = candidates.find(
      (c) => c.domain.toLowerCase() === domain.toLowerCase(),
    )?.domain;
    if (!originalDomain) continue;

    const category = normalizeCategory(e.category);

    const is_competitor = e.is_competitor === true;
    const callable = e.callable === true;

    const reason =
      typeof e.reason === "string"
        ? e.reason.trim().slice(0, 200)
        : `${category} site`;

    verdicts.push({
      domain: originalDomain,
      category,
      is_competitor,
      callable,
      reason,
    });
  }

  return verdicts;
}

async function complete(system: string, user: string): Promise<string | null> {
  const timeoutMs = 45_000;

  async function doComplete(): Promise<string | null> {
    if (!process.env.OPENROUTER_API_KEY) return null;

    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
    const resp = await client.chat.completions.create({
      model: "anthropic/claude-sonnet-5",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return resp.choices[0]?.message?.content ?? null;
  }

  try {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    );
    return await Promise.race([doComplete(), timeout]);
  } catch {
    return null;
  }
}

export async function classifyCandidates(
  client: { name: string; trade: string | null; locality: string | null },
  candidates: { domain: string; title: string | null; description: string | null }[],
): Promise<Map<string, TargetVerdict>> {
  if (!process.env.OPENROUTER_API_KEY || candidates.length === 0) {
    return new Map();
  }

  const userPrompt = buildUserPrompt(client, candidates);

  let verdicts: TargetVerdict[] = [];

  try {
    const raw = await complete(SYSTEM_PROMPT, userPrompt);
    if (raw) {
      const parsed = parseLoose(raw);
      verdicts = buildVerdictsFromRaw(parsed, candidates);
    }
  } catch {
    // return empty Map below
  }

  const map = new Map<string, TargetVerdict>();
  for (const v of verdicts) {
    map.set(v.domain, v);
  }

  const competitorCount = verdicts.filter((v) => v.is_competitor).length;
  console.error(
    `classifyCandidates: ${candidates.length} candidates → ${verdicts.length} verdicts, ${competitorCount} competitors`,
  );

  return map;
}
