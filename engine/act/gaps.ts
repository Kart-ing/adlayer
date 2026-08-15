// Person B — Action (PRD-B §3.2)
// Diff A's retrieval keywords against the site audit → Gap[]. Source ladder:
// (1) uncited retrieve queries → (2) fixture.json gaps → (3) synthesized from
// the client name. Postcondition: always returns ≥1 gap.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client, Gap } from "../ui/types";
import type { RetrieveOutput, SiteAudit } from "./types";

const MAX_GAPS = 6;

const STOPWORDS = new Set([
  "a", "an", "the", "for", "of", "to", "in", "on", "and", "or", "vs",
  "best", "top", "with", "is", "what", "how",
]);

function tokenize(keyword: string): string[] {
  return keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// ≥60% of keyword tokens found in page text or a sitemap URL → the topic
// exists but isn't landing ("thin_content"); otherwise it's absent entirely.
function classify(keyword: string, pageText: string, sitemapUrls: string[]): string {
  const tokens = tokenize(keyword);
  if (tokens.length === 0) return "missing_page";
  const present = tokens.filter(
    (t) => pageText.includes(t) || sitemapUrls.some((u) => u.includes(t)),
  ).length;
  return present / tokens.length >= 0.6 ? "thin_content" : "missing_page";
}

// Rung 2: <cwd>/fixture.json's gaps array, entries validated field-by-field.
function readFixtureGaps(): Gap[] | null {
  try {
    const raw = readFileSync(path.join(process.cwd(), "fixture.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const arr = (parsed as { gaps?: unknown } | null)?.gaps;
    if (!Array.isArray(arr)) return null;
    const gaps: Gap[] = [];
    for (const entry of arr) {
      if (entry === null || typeof entry !== "object") continue;
      const g = entry as Record<string, unknown>;
      if (
        typeof g.keyword === "string" &&
        typeof g.type === "string" &&
        typeof g.citations === "number"
      ) {
        gaps.push({ keyword: g.keyword, type: g.type, citations: g.citations });
      }
    }
    return gaps.length > 0 ? gaps : null;
  } catch {
    return null;
  }
}

export function deriveGaps(client: Client, audit: SiteAudit, retrieve: RetrieveOutput): Gap[] {
  // Rung 1: uncited retrieve queries ranked by citation count, classified
  // against the audit's page text + sitemap slugs.
  const queries = retrieve.queries;
  if (queries && queries.length > 0) {
    const uncited = queries.filter((q) => q.cited === false);
    if (uncited.length > 0) {
      const pageText = audit.page_text.toLowerCase();
      const sitemapUrls = audit.sitemap_urls.map((u) => u.toLowerCase());
      // Prefer content-worthy keywords: ≥3 meaningful tokens ("user management
      // platform buyers guide") beat truncated ones ("best open-source") that
      // only rank high because generic queries attract the most citations.
      const ranked = uncited.sort((a, b) => b.citations.length - a.citations.length);
      const meaty = ranked.filter((q) => tokenize(q.query).length >= 3);
      return (meaty.length >= 3 ? meaty : ranked)
        .slice(0, MAX_GAPS)
        .map((q) => ({
          keyword: q.query,
          type: classify(q.query, pageText, sitemapUrls),
          citations: q.citations.length,
        }));
    }
  }

  // Rung 2: fixture gaps (types kept as given).
  const fixture = readFixtureGaps();
  if (fixture) {
    console.error("[gaps] fallback: fixture");
    return fixture.sort((a, b) => b.citations - a.citations).slice(0, MAX_GAPS);
  }

  // Rung 3: synthesize one gap so the ≥1 postcondition always holds.
  return [
    { keyword: `${client.name.toLowerCase()} alternatives`, type: "missing_page", citations: 0 },
  ];
}
