import * as cheerio from "cheerio";
import type { OutreachTarget, QueryResult, Source, AuditResult, Client } from "../contract";
import { classifyCandidates, type TargetVerdict } from "./classify";


export const NEVER_CALL: string[] = [
  "reddit.com",
  "wikipedia.org",
  "quora.com",
  "youtube.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "instagram.com",
  "tiktok.com",
  "medium.com",
  "pinterest.com",
  "amazon.com",
  "google.com",
  "apple.com",
  "github.com",
  "nytimes.com",
  "forbes.com",
  "wsj.com",
  "bbc.com",
  "cnn.com",
];

function hostname(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, "").split(/[\/\?#]/)[0];
  }
}

function isNeverCall(domain: string): boolean {
  const h = hostname(domain).replace(/^www\./, "");
  return NEVER_CALL.some(
    (d) => h === d || h.endsWith("." + d),
  );
}

// ---------------------------------------------------------------------------
// fetchHtml — shared browser-like fetcher
// ---------------------------------------------------------------------------

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "text/html",
      },
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// candidateUrls
// ---------------------------------------------------------------------------

function candidateUrls(domain: string): string[] {
  const hosts = domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`];
  const paths = ["", "/contact", "/contact-us", "/about", "/about-us", "/membership", "/join", "/advertise"];
  const urls: string[] = [];
  for (const host of hosts) {
    for (const path of paths) {
      urls.push(`https://${host}${path}`);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// classifyDomain — deterministic fallback when the LLM has no verdict
// ---------------------------------------------------------------------------

export function classifyDomain(
  domain: string,
  title?: string | null,
): OutreachTarget["category"] {
  const d = domain.toLowerCase();
  const t = (title ?? "").toLowerCase();

  if (d.includes("chamber")) return "chamber";

  if (
    d.includes("association") ||
    d.includes("assoc") ||
    d.includes("society") ||
    d.includes("council") ||
    d.includes("guild")
  ) {
    return "association";
  }

  if (
    d.includes("directory") ||
    d.includes("directories") ||
    d.includes("listings") ||
    d.includes("yellowpages") ||
    d.includes("find") ||
    d.includes("locator")
  ) {
    return "directory";
  }

  const listicleRe = /best|top \d|vs\.?|review|comparison|\d{1,2} best/i;
  if (listicleRe.test(d) || listicleRe.test(t)) {
    return "listicle";
  }

  if (
    d.includes("blog") ||
    d.includes("news") ||
    d.includes("magazine") ||
    d.includes("journal")
  ) {
    return "blog";
  }

  // title fallback when domain gave nothing
  if (t) {
    if (t.includes("chamber")) return "chamber";

    if (
      t.includes("association") ||
      t.includes("assoc") ||
      t.includes("society") ||
      t.includes("council") ||
      t.includes("guild") ||
      t.includes("board of") ||
      t.includes("institute") ||
      t.includes("academy")
    ) {
      return "association";
    }

    if (
      t.includes("directory") ||
      t.includes("directories") ||
      t.includes("listings") ||
      t.includes("yellowpages") ||
      t.includes("find") ||
      t.includes("locator") ||
      t.includes("find a") ||
      t.includes("search for a") ||
      t.includes("book a")
    ) {
      return "directory";
    }
  }

  return "other";
}

// ---------------------------------------------------------------------------
// findPhone
// ---------------------------------------------------------------------------

const NA_PHONE_RE = /(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?!\d)/;

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits[0] !== "0" && digits[0] !== "1") {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits[0] === "1") {
    return `+${digits}`;
  }
  return null;
}

function isObviousNonPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return true;
  if (/^(\d)\1{9,}$/.test(digits)) return true;
  const num = parseInt(digits.slice(0, 10), 10);
  if (num >= 1900 && num <= 2100) return true;
  return false;
}

function extractTelHref($: cheerio.CheerioAPI): string | null {
  const href = $('a[href^="tel:"]').first().attr("href");
  if (!href) return null;
  return href.replace(/^tel:/i, "").trim();
}

function regexPhoneFromHtml($: cheerio.CheerioAPI): string | null {
  $("script, style").remove();
  const body = $("body").text() || "";
  const lines = body.split("\n");
  const collapsed = lines.join(" ").replace(/\s+/g, " ").trim();

  const re = new RegExp(NA_PHONE_RE.source, "g");
  let m;
  while ((m = re.exec(collapsed)) !== null) {
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;

    if (
      matchStart > 0 && /[\d.\-]/.test(collapsed[matchStart - 1])
    ) {
      continue;
    }
    if (matchEnd < collapsed.length && /[\d.\-]/.test(collapsed[matchEnd])) {
      continue;
    }

    const before = collapsed.slice(Math.max(0, matchStart - 60), matchStart).toLowerCase();
    const kw = /phone|tel(?:ephone)?|call us|call:|contact|toll|office|mobile|cell|fax/i;
    const kwMatch = before.match(kw);
    if (!kwMatch) continue;
    if (/^fax$/i.test(kwMatch[0])) continue;

    const digits = `${m[1]}${m[2]}${m[3]}`;
    if (isObviousNonPhone(digits)) continue;
    return digits;
  }

  return null;
}

function findTelephoneIn(obj: unknown): string | null {
  if (typeof obj === "string") return null;
  if (typeof obj !== "object" || obj === null) return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findTelephoneIn(item);
      if (result) return result;
    }
    return null;
  }

  const rec = obj as Record<string, unknown>;
  if ("telephone" in rec && typeof rec.telephone === "string") {
    return rec.telephone;
  }

  for (const val of Object.values(rec)) {
    const result = findTelephoneIn(val);
    if (result) return result;
  }

  return null;
}

function extractJsonLdPhone($: cheerio.CheerioAPI): string | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    const text = $(el).html();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const phone = findTelephoneIn(parsed);
      if (phone) return phone;
    } catch {
      continue;
    }
  }
  return null;
}

function tryExtractPhone(html: string): string | null {
  const $ = cheerio.load(html);

  const jsonLdPhone = extractJsonLdPhone($);
  if (jsonLdPhone) {
    const e164 = toE164(jsonLdPhone);
    if (e164) return e164;
  }

  const telRaw = extractTelHref($);
  if (telRaw && !isObviousNonPhone(telRaw)) {
    const e164 = toE164(telRaw);
    if (e164) return e164;
  }

  const digits = regexPhoneFromHtml($);
  if (digits) {
    const e164 = toE164(digits);
    if (e164) return e164;
  }

  return null;
}

export async function findPhone(domain: string): Promise<string | null> {
  for (const url of candidateUrls(domain)) {
    const html = await fetchHtml(url);
    if (!html) continue;
    const phone = tryExtractPhone(html);
    if (phone) return phone;
  }

  return null;
}

// ---------------------------------------------------------------------------
// fetchOrgIdentity
// ---------------------------------------------------------------------------

export async function fetchOrgIdentity(domain: string): Promise<{ name: string | null; title: string | null }> {
  const baseUrls = [`https://${domain}`];
  if (!domain.startsWith("www.")) {
    baseUrls.push(`https://www.${domain}`);
  }

  for (const url of baseUrls) {
    const html = await fetchHtml(url);
    if (!html) continue;

    const $ = cheerio.load(html);

    let name: string | null = $('meta[property="og:site_name"]').attr("content") ?? null;
    const rawTitle = $("title").text().trim() || null;

    if (!name && rawTitle) {
      name = rawTitle.replace(/\s*[|—–-]\s*.+$/, "").trim() || null;
    }

    return { name, title: rawTitle };
  }

  return { name: null, title: null };
}

// ---------------------------------------------------------------------------
// extractLocality — best-effort human-readable city for the client
// ---------------------------------------------------------------------------

export function extractLocality(audit: AuditResult): string | null {
  if (audit.nap.city && audit.nap.state) {
    return `${audit.nap.city}, ${audit.nap.state}`;
  }

  const re = /([A-Z][A-Za-z.\- ]+),\s*([A-Z]{2})\b/;

  if (audit.title) {
    const m = audit.title.match(re);
    if (m) return `${m[1]}, ${m[2]}`;
  }

  if (audit.meta_description) {
    const m = audit.meta_description.match(re);
    if (m) return `${m[1]}, ${m[2]}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// inferTrade — short trade phrase for the LLM classifier
// ---------------------------------------------------------------------------

export function inferTrade(audit: AuditResult, client: Client): string | null {
  if (audit.category_hint) return audit.category_hint;

  if (audit.title) {
    const cleaned = audit.title
      .replace(/\s*[|—–-]\s*.+$/, "")
      .trim();
    return cleaned.split(/\s+/).slice(0, 4).join(" ");
  }

  return client.name;
}

// ---------------------------------------------------------------------------
// discoverTargets
// ---------------------------------------------------------------------------

function registrableDomain(domain: string): string {
  return hostname(domain).replace(/^www\./, "");
}

interface Candidate {
  domain: string;
  score: number;
  bestQuery: string;
}

export async function discoverTargets(input: {
  client: Client;
  queries: QueryResult[];
  sources: Source[];
  audit: AuditResult;
  limit?: number;
}): Promise<OutreachTarget[]> {
  const { client, queries, audit, limit } = input;

  const clientHost = (() => {
    try {
      return new URL(client.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const auditPageDomains = new Set(
    audit.pages.map((p) => {
      try {
        return new URL(p.url).hostname.toLowerCase();
      } catch {
        return "";
      }
    }),
  );

  // (a) build and score all candidate domains
  const candMap = new Map<string, { score: number; bestQuery: string; bestCount: number }>();

  for (const q of queries) {
    if (q.client_cited) continue;
    if (q.citation_count <= 0) continue;
    for (const domain of q.cited_domains) {
      const key = registrableDomain(domain);
      const existing = candMap.get(key);
      const newScore = (existing?.score ?? 0) + 1;
      const hasBetterQuery =
        !existing || q.citation_count > existing.bestCount;
      candMap.set(key, {
        score: newScore,
        bestQuery: hasBetterQuery ? q.query : existing!.bestQuery,
        bestCount: hasBetterQuery ? q.citation_count : existing!.bestCount,
      });
    }
  }

  // (b) apply client-domain / NEVER_CALL drops, sort, take top 20
  const candidates: Candidate[] = [];
  for (const [domain, data] of candMap) {
    if (domain === clientHost) continue;
    if (domain === "") continue;
    if (isNeverCall(domain)) continue;
    if (auditPageDomains.has(domain)) continue;
    candidates.push({
      domain,
      score: data.score,
      bestQuery: data.bestQuery,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
  const pool = candidates.slice(0, 20);

  // (c) resolve org identities in parallel
  const identityResults = await Promise.all(
    pool.map(async (c) => {
      try {
        return { candidate: c, identity: await fetchOrgIdentity(c.domain) };
      } catch {
        return { candidate: c, identity: { name: null, title: null } };
      }
    }),
  );

  // (d) call classifyCandidates ONCE — treat rejection as empty map
  let verdictMap = new Map<string, TargetVerdict>();
  try {
    verdictMap = await classifyCandidates(
      {
        name: client.name,
        trade: inferTrade(audit, client),
        locality: extractLocality(audit),
      },
      identityResults.map((r) => ({
        domain: r.candidate.domain,
        title: r.identity.title,
        description: r.identity.name ?? r.identity.title,
      })),
    );
  } catch {
    /* empty map fallback */
  }

  // (e) filter by verdict: callable=true, is_competitor=false
  //     fallback to classifyDomain when no verdict for a domain
  const linkableTargets: {
    candidate: Candidate;
    identity: { name: string | null; title: string | null };
    category: OutreachTarget["category"];
    verdictReason?: string;
  }[] = [];

  for (const r of identityResults) {
    const verdict = verdictMap.get(r.candidate.domain);
    if (verdict) {
      if (verdict.callable && !verdict.is_competitor) {
        linkableTargets.push({
          candidate: r.candidate,
          identity: r.identity,
          category: verdict.category as OutreachTarget["category"],
          verdictReason: verdict.reason,
        });
      }
    } else {
      const cat = classifyDomain(r.candidate.domain, r.identity.title);
      if (cat !== "other") {
        linkableTargets.push({
          candidate: r.candidate,
          identity: r.identity,
          category: cat,
        });
      }
    }
  }

  // (f) resolve phones in parallel for survivors, drop those without a phone
  const withPhones = await Promise.all(
    linkableTargets.map(async (r) => {
      let phone: string | null = null;
      try {
        phone = await findPhone(r.candidate.domain);
      } catch {
        /* leave null */
      }
      if (phone === null) return null;

      const c = r.candidate;
      let whyRelevant =
        c.score === 1
          ? `Cited for "${c.bestQuery}" where ${client.name} does not appear.`
          : `Cited for "${c.bestQuery}" and ${c.score - 1} other quer${c.score - 1 === 1 ? "y" : "ies"} where ${client.name} does not appear.`;

      if (r.verdictReason) {
        whyRelevant += ` ${r.verdictReason}`;
      }

      return {
        name: r.identity.name ?? c.domain,
        domain: c.domain,
        phone,
        category: r.category,
        contact_person: null,
        contact_title: null,
        why_relevant: whyRelevant,
        cited_by_engine: true,
        _score: c.score,
      };
    }),
  );

  const valid = withPhones.filter((r): r is NonNullable<typeof r> => r !== null);

  // (g) sort by category weight desc, then score desc, then domain alpha
  const CATEGORY_WEIGHT: Record<OutreachTarget["category"], number> = {
    chamber: 3,
    association: 3,
    directory: 3,
    listicle: 2,
    blog: 1,
    other: 0,
  };

  valid.sort((a, b) => {
    const wa = CATEGORY_WEIGHT[a.category];
    const wb = CATEGORY_WEIGHT[b.category];
    if (wa !== wb) return wb - wa;
    if (a._score !== b._score) return b._score - a._score;
    return (a.domain ?? "").localeCompare(b.domain ?? "");
  });

  const result: OutreachTarget[] = valid.slice(0, limit ?? 5).map(({ _score, ...t }) => t);

  return result;
}

// ---------------------------------------------------------------------------
// buildCallBrief
// ---------------------------------------------------------------------------

export function buildCallBrief(target: OutreachTarget, client: Client): string {
  const parts: string[] = [];

  parts.push(`You are calling on behalf of ${client.name}.`);

  if (target.contact_person) {
    const title = target.contact_title ? `, the ${target.contact_title}` : "";
    parts.push(`Ask for ${target.contact_person}${title}.`);
  }

  const domainStr = target.domain ? ` ${target.domain}` : "";

  switch (target.category) {
    case "chamber":
    case "association":
      parts.push(
        `Confirm ${client.name} membership and ask to be added to the online member directory with a link to ${client.url}.`,
      );
      break;
    case "directory":
      parts.push(
        `Ask what is required to get ${client.name} listed on${domainStr}, including any fees and the timeline.`,
      );
      break;
    case "blog":
    case "listicle":
      parts.push(
        `Ask who handles editorial updates and whether ${client.name} can be considered for inclusion in the relevant roundup on${domainStr}.`,
      );
      break;
    default:
      parts.push(
        `Ask who handles website listings and how ${client.name} can be included on${domainStr}.`,
      );
      break;
  }

  parts.push(
    "Ask for the concrete next step and the expected timeline.",
  );
  parts.push(
    "Be honest that you are an automated assistant calling on behalf of the client, never claim to be a person, accept \"no\" gracefully and end the call, and never offer payment or anything of value in exchange for a link.",
  );

  return parts.join(" ");
}
