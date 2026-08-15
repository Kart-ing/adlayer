// Person B — Action orchestrator + CLI entry (PRD-B §3.6). `npm run act`.
//   npm run act -- --url https://site --repo owner/repo
//     [--name "Client"] [--retrieve out/retrieve.json] [--out report.json]
//     [--no-pr] [--dry-run] [--wait-invite <secs>] [--indexnow]
// Retrieve-input addendum (Person A's module landed): explicit/on-disk
// out/retrieve.json → in-process retrieve() when an OPENAI/DEEPSEEK key exists
// (A's keyless EMPTY counts as invalid) → fixture.json → zero score.
// Everything degrades; exit code 1 only for missing/invalid --url or --repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { auditSite } from "./audit";
import { deriveGaps } from "./gaps";
import { generateActions } from "./generate";
import { openPr, parseRepoRef } from "./github";
import { pingIndexNow } from "./indexnow";
import { retrieve } from "../retrieve";
import type { QueryResult } from "../retrieve/types";

import type { Action, Client, Gap, Report, Score, Source } from "../ui/types";
import type { PrResult, RetrieveOutput, RetrieveQuery, SiteAudit } from "./types";

// ---------------------------------------------------------------- utilities

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Hand-parsed <cwd>/.env — mirrors scripts/retrieve.ts loadEnv. KEY=VALUE
 *  lines only (the regex skips `#` comments), surrounding quotes stripped,
 *  existing process.env keys never overridden, absent file skipped silently. */
function loadEnv(): void {
  try {
    const raw = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (val && !process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {
    // no .env — rely on shell env
  }
}

// -------------------------------------------------------------- CLI parsing

interface CliFlags {
  url: string | null;
  repo: string | null;
  name: string | null;
  retrievePath: string | null; // as passed; null = flag not given
  out: string | null;
  noPr: boolean;
  dryRun: boolean;
  waitInvite: number | undefined;
  indexnow: boolean;
}

const VALUE_FLAGS = new Set(["--url", "--repo", "--name", "--retrieve", "--out", "--wait-invite"]);
const BOOL_FLAGS = new Set(["--no-pr", "--dry-run", "--indexnow"]);

function parseCli(argv: string[]): CliFlags {
  const f: CliFlags = {
    url: null,
    repo: null,
    name: null,
    retrievePath: null,
    out: null,
    noPr: false,
    dryRun: false,
    waitInvite: undefined,
    indexnow: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | null = null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (BOOL_FLAGS.has(arg)) {
      if (arg === "--no-pr") f.noPr = true;
      else if (arg === "--dry-run") f.dryRun = true;
      else f.indexnow = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      console.error(`[act] ignoring unknown argument: ${argv[i]}`);
      continue;
    }
    const val: string | undefined = inline ?? argv[++i];
    if (val === undefined) {
      console.error(`[act] ${arg} expects a value — ignored`);
      continue;
    }
    if (arg === "--url") f.url = val;
    else if (arg === "--repo") f.repo = val;
    else if (arg === "--name") f.name = val;
    else if (arg === "--retrieve") f.retrievePath = val;
    else if (arg === "--out") f.out = val;
    else {
      // --wait-invite
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) f.waitInvite = Math.floor(n);
      else console.error(`[act] --wait-invite expects seconds, got "${val}" — ignored`);
    }
  }
  return f;
}

function usage(): void {
  console.error(
    [
      "Usage: npm run act -- --url https://site --repo owner/repo",
      '  [--name "Client"] [--retrieve out/retrieve.json] [--out report.json]',
      "  [--no-pr] [--dry-run] [--wait-invite <secs>] [--indexnow]",
    ].join("\n")
  );
}

// ------------------------------------------------------ client construction

/** Prepend https:// when schemeless, strip trailing slashes; null if unparsable. */
function normalizeUrl(raw: string): string | null {
  let u = raw.trim();
  if (u === "") return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = `https://${u}`;
  try {
    if (!new URL(u).hostname) return null;
  } catch {
    return null;
  }
  return u.replace(/\/+$/, "");
}

/** Capitalized hostname sans www/TLD — e.g. lumenanalytics.io → "Lumenanalytics". */
function nameFromHost(url: string): string {
  try {
    const base = new URL(url).hostname.replace(/^www\./i, "").split(".")[0];
    if (base) return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    // fall through
  }
  return "Client";
}

/** og:site_name from the audited <head>, else first <title> segment (PRD §3.6). */
function nameFromAudit(audit: SiteAudit): string | null {
  const og =
    audit.head_html.match(/<meta\s[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i) ??
    audit.head_html.match(/<meta\s[^>]*content=["']([^"']*)["'][^>]*property=["']og:site_name["']/i);
  const ogName = og?.[1]?.trim();
  if (ogName) return ogName;
  if (audit.title) {
    const first = audit.title.split(/[|—-]/)[0].trim();
    if (first) return first;
  }
  return null;
}

// -------------------------------------------------- retrieve-input resolution

function coerceRetrieve(v: unknown): RetrieveOutput | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.score !== "object" || o.score === null) return null;
  const sc = o.score as Record<string, unknown>;
  if (
    typeof sc.visibility !== "number" ||
    typeof sc.cited_queries !== "number" ||
    typeof sc.total_queries !== "number" ||
    !Array.isArray(o.sources)
  ) {
    return null;
  }
  const out: RetrieveOutput = {
    score: { visibility: sc.visibility, cited_queries: sc.cited_queries, total_queries: sc.total_queries },
    sources: o.sources as Source[],
  };
  if (Array.isArray(o.queries)) out.queries = o.queries as RetrieveQuery[]; // pass through when present
  return out;
}

/** A's retrieve() now returns per-query results natively (90s deadline,
 *  partial aggregation). Adapt its QueryResult shape to the act seam. */
function adaptQueries(qs: QueryResult[] | undefined): RetrieveQuery[] | undefined {
  if (!qs || qs.length === 0) return undefined;
  return qs.map((q) => ({ query: q.query, cited: q.client_cited, citations: q.cited_urls }));
}

async function liveRetrieveWithQueries(clientUrl: string): Promise<RetrieveOutput> {
  const live = await retrieve(clientUrl);
  return { score: live.score, sources: live.sources, queries: adaptQueries(live.queries) };
}

/** Precedence ladder per PRD-B §3.6 + the in-process addendum:
 *  (a) --retrieve file (or default out/retrieve.json when it exists)
 *  (b) Person A's retrieve() when an engine key is set — EMPTY output rejected
 *  (c) fixture.json   (d) zero score. Each failure warns and falls through. */
async function resolveRetrieveInput(
  flags: CliFlags,
  clientUrl: string
): Promise<{ data: RetrieveOutput; origin: string }> {
  const cwd = process.cwd();

  const filePath = resolve(cwd, flags.retrievePath ?? "out/retrieve.json");
  if (flags.retrievePath !== null || existsSync(filePath)) {
    try {
      const parsed = coerceRetrieve(JSON.parse(readFileSync(filePath, "utf8")));
      if (parsed) return { data: parsed, origin: `file ${filePath}` };
      console.error(`[act] retrieve file ${filePath} malformed (need numeric score + sources[]) — trying next source`);
    } catch (e) {
      console.error(`[act] retrieve file ${filePath} unreadable (${msg(e)}) — trying next source`);
    }
  }

  if (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY) {
    try {
      const live = await liveRetrieveWithQueries(clientUrl);
      if (live.sources.length > 0 || live.score.total_queries > 0) {
        console.error(`[act] score/sources from live retrieve (${live.queries?.length ?? 0} per-query results)`);
        return { data: live, origin: "live retrieve" };
      }
      console.error("[act] live retrieve returned an empty result — trying fixture");
    } catch (e) {
      console.error(`[act] live retrieve failed (${msg(e)}) — trying fixture`);
    }
  }

  try {
    const parsed = coerceRetrieve(JSON.parse(readFileSync(join(cwd, "fixture.json"), "utf8")));
    if (parsed) {
      console.error("[act] using fixture score/sources");
      return { data: parsed, origin: "fixture.json" };
    }
    console.error("[act] fixture.json malformed");
  } catch (e) {
    console.error(`[act] fixture.json unreadable (${msg(e)})`);
  }

  console.error("[act] WARNING: no usable score/sources (retrieve + fixture both unavailable) — using zero score");
  return {
    data: { score: { visibility: 0, cited_queries: 0, total_queries: 0 }, sources: [] },
    origin: "zero fallback",
  };
}

// ----------------------------------------------------------------- indexnow

/** Site root + the blog URL derived from the generated blog action's file path. */
function indexnowUrls(clientUrl: string, actions: Action[]): string[] {
  const urls = [clientUrl];
  const blog = actions.find((a) => a.type === "new_page" && a.file.startsWith("blog/") && a.file.endsWith(".md"));
  if (blog) {
    const slug = blog.file.slice("blog/".length, -".md".length);
    if (slug) urls.push(`${clientUrl}/blog/${slug}`);
  }
  return urls;
}

// ------------------------------------------------------------------ summary

function printSummary(
  report: Report,
  pr: PrResult,
  retrieveOrigin: string,
  indexnowRequested: boolean,
  outPath: string
): void {
  const { client, score, gaps, actions } = report;
  const pct = Math.round(score.visibility * 100);
  console.error(
    [
      "",
      "[act] ── CITED run summary ──────────────────────────",
      `[act] client     ${client.name} (${client.url} · ${client.repo})`,
      `[act] score      ${pct}% visibility — ${score.cited_queries}/${score.total_queries} queries cited (${retrieveOrigin})`,
      `[act] gaps       ${gaps.length}${gaps.length > 0 ? ` — top: "${gaps[0].keyword}"` : ""}`,
      `[act] actions    ${actions.length}${actions.length > 0 ? ` — ${actions.map((a) => a.file).join(", ")}` : ""}`,
      `[act] pr         ${pr.mode} — ${pr.detail}${pr.pr_url ? ` → ${pr.pr_url}` : ""}`,
      `[act] indexnow   ${
        indexnowRequested
          ? report.indexnow_submitted_at ?? "not submitted (gate failed — see log)"
          : "skipped (post-deploy step; run with --indexnow)"
      }`,
      `[act] report     ${outPath}`,
      "",
    ].join("\n")
  );
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  loadEnv();
  const flags = parseCli(process.argv.slice(2));

  const url = flags.url !== null ? normalizeUrl(flags.url) : null;
  const repoRef = flags.repo !== null ? parseRepoRef(flags.repo) : null;
  if (!url || !repoRef) {
    if (!url) console.error("[act] missing or invalid --url");
    if (!repoRef) console.error("[act] missing or invalid --repo");
    usage();
    process.exitCode = 1;
    return;
  }

  const client: Client = {
    url,
    repo: `${repoRef.owner}/${repoRef.repo}`,
    name: flags.name ?? nameFromHost(url), // provisional; upgraded after audit
  };
  const outPath = resolve(process.cwd(), flags.out ?? "report.json");

  // Degraded defaults — the catch below still assembles + writes a report.
  let score: Score = { visibility: 0, cited_queries: 0, total_queries: 0 };
  let sources: Source[] = [];
  let gaps: Gap[] = [];
  let actions: Action[] = [];
  let prResult: PrResult = { pr_url: null, mode: "skipped", detail: "pipeline did not reach the PR step" };
  let indexnowAt: string | null = null;
  let retrieveOrigin = "unresolved";

  try {
    const resolved = await resolveRetrieveInput(flags, client.url);
    score = resolved.data.score;
    sources = resolved.data.sources;
    retrieveOrigin = resolved.origin;

    const audit = await auditSite(client.url);
    if (flags.name === null) client.name = nameFromAudit(audit) ?? nameFromHost(client.url);

    gaps = deriveGaps(client, audit, resolved.data);
    actions = await generateActions(client, audit, gaps);

    prResult = flags.noPr
      ? { pr_url: null, mode: "skipped", detail: "--no-pr" }
      : await openPr(client, score, sources, gaps, actions, {
          dryRun: flags.dryRun,
          waitInviteSecs: flags.waitInvite,
        });

    if (flags.indexnow) indexnowAt = await pingIndexNow(client.url, indexnowUrls(client.url, actions));
  } catch (e) {
    console.error(`[act] unexpected error — writing degraded report: ${msg(e)}`);
  }

  const report: Report = {
    client,
    score,
    sources,
    gaps,
    actions,
    pr_url: prResult.pr_url,
    indexnow_submitted_at: indexnowAt,
  };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n"); // data → file only; stdout stays clean
  } catch (e) {
    console.error(`[act] failed to write report to ${outPath}: ${msg(e)}`);
  }

  printSummary(report, prResult, retrieveOrigin, flags.indexnow, outPath);
}

main().catch((e) => {
  // Degraded runs exit 0 (PRD-B §3.6); nonzero is reserved for unusable args.
  console.error(`[act] fatal: ${msg(e)}`);
});

// ---------------------------------------------------------------- act() API
// Bridge for scripts/act.ts (Parth's runner): audit → gaps → generate without
// the PR/report steps. Accepts A's contract QueryResult shape directly.
import type { QueryResult as ContractQueryResult } from "../contract";

export interface ActInput {
  client: { url: string; repo: string; name: string };
  queries: ContractQueryResult[];
  sources: Source[];
  fixture?: boolean;
  live?: { generate?: boolean; [flag: string]: boolean | undefined };
}

export async function act(
  input: ActInput
): Promise<{ gaps: Gap[]; actions: Action[] }> {
  const url = input.client.url.includes("://") ? input.client.url : `https://${input.client.url}`;
  const client: Client = {
    url: url.replace(/\/+$/, ""),
    repo: input.client.repo,
    name: input.client.name || new URL(url).hostname,
  };
  const audit = await auditSite(client.url);
  const queries: RetrieveQuery[] = input.queries.map((q) => ({
    query: q.query,
    cited: q.client_cited,
    citations: q.cited_urls,
  }));
  const total = queries.length;
  const cited = queries.filter((q) => q.cited).length;
  const gaps = deriveGaps(client, audit, {
    score: { visibility: total ? cited / total : 0, cited_queries: cited, total_queries: total },
    sources: input.sources,
    queries,
  });
  const actions = await generateActions(client, audit, gaps);
  return { gaps, actions };
}
