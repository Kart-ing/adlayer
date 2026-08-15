// Build 20-30 category queries from a scraped category + keyword seed.

const MAX_QUERIES = 30;

export const QUERY_TEMPLATES: string[] = [
  "best {c} tools",
  "top {c} software 2026",
  "best {c} software",
  "{c} comparison",
  "best {c} for startups",
  "best {c} for small business",
  "{c} alternatives",
  "is {c} worth it",
  "{c} pricing",
  "{c} reviews",
  "what is the best {c}",
  "{c} vs competitors",
  "top rated {c} tools",
  "best {c} platform",
  "most popular {c} tools",
  "{c} for enterprise",
  "affordable {c} tools",
  "best free {c} tools",
  "{c} recommendations",
  "which {c} should I use",
  "best {c} 2026",
  "leading {c} providers",
  "{c} buyers guide",
  "best {c} apps",
  "top {c} companies",
];

const GENERIC_FALLBACK: string[] = [
  "best software tools 2026",
  "top rated business software",
  "best tools for startups",
  "most popular saas products",
  "best productivity tools",
  "top software companies 2026",
  "best business apps",
  "software comparison guide",
];

/**
 * Interpolate templates with the category and add a few keyword-driven queries.
 * Returns a deduplicated list capped at MAX_QUERIES.
 */
export function buildQueries(category: string, keywords: string[] = []): string[] {
  const c = (category ?? "").trim().toLowerCase();
  if (!c) return dedupe(GENERIC_FALLBACK).slice(0, MAX_QUERIES);

  const queries = QUERY_TEMPLATES.map((t) => t.replace(/\{c\}/g, c));

  for (const kw of keywords.slice(0, 6)) {
    const k = kw.trim().toLowerCase();
    if (!k || k === c) continue;
    queries.push(`what is ${k}`);
    queries.push(`best ${k}`);
  }

  return dedupe(queries).slice(0, MAX_QUERIES);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const q = raw.trim().toLowerCase();
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}
