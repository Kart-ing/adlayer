// Person B — Action (PRD-B §3.4): GitHub ship path.
// Token ladder → access ladder (direct → invite-accept → fork → skipped) →
// fixed branch + contents-API commits → open/reuse PR. Raw GitHub REST via
// global fetch, zero new deps. openPr NEVER throws — every failure degrades
// to a PrResult with a human-readable detail.

import { execFileSync } from "node:child_process";
import type { Action, Client, Gap, Score, Source } from "../ui/types";
import type { PrResult } from "./types";
import { parseMetaAfter } from "./generate";

type GhResult = { status: number; json: any };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Accepts "owner/repo" or "https://github.com/owner/repo" (optional ".git" / trailing slash). */
export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  if (!input) return null;
  let s = input.trim();
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// §3.4 token ladder: env var → `gh auth token` (errors swallowed) → none.
function resolveToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  try {
    const cliToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    if (cliToken) return cliToken;
  } catch {
    // gh not installed or not logged in — fall through to null
  }
  return null;
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// generate.ts is authored concurrently (PRD-B §3.3); we code against its
// signature `(after: string) => { title, description, jsonld } | null` and
// validate the shape at runtime. jsonld may arrive serialized or as an object.
function coerceMeta(v: unknown): { title: string; description: string; jsonld: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.description !== "string") return null;
  const raw = o.jsonld;
  const jsonld = typeof raw === "string" ? raw : raw !== undefined && raw !== null ? JSON.stringify(raw) : "";
  if (!o.title.trim() || !o.description.trim() || !jsonld) return null;
  return { title: o.title, description: o.description, jsonld };
}

// §3.4 meta patch: sole precondition is a literal `</head>`. Title/description
// are replaced in place when present (attribute-order/quote tolerant), else
// inserted before </head>; JSON-LD is upserted between `<!-- cited:jsonld -->`
// markers so reruns converge. Function replacers avoid `$`-substitution.
function patchHead(html: string, meta: { title: string; description: string; jsonld: string }): string {
  let out = html;
  const insertBeforeHead = (doc: string, snippet: string): string => doc.replace("</head>", `${snippet}</head>`);

  const titleTag = `<title>${meta.title}</title>`;
  const titleRe = /<title\b[^>]*>[\s\S]*?<\/title>/i;
  out = titleRe.test(out) ? out.replace(titleRe, () => titleTag) : insertBeforeHead(out, `  ${titleTag}\n`);

  const descTag = `<meta name="description" content="${escapeAttr(meta.description)}">`;
  const descRe = /<meta\b(?=[^>]*\bname\s*=\s*(?:"description"|'description'|description(?=[\s\/>])))[^>]*\/?>/i;
  out = descRe.test(out) ? out.replace(descRe, () => descTag) : insertBeforeHead(out, `  ${descTag}\n`);

  const jsonldScript = `<script type="application/ld+json">${meta.jsonld}</script>`;
  const markerRe = /<!-- cited:jsonld -->[\s\S]*?<!-- \/cited:jsonld -->/;
  out = markerRe.test(out)
    ? out.replace(markerRe, () => `<!-- cited:jsonld -->\n  ${jsonldScript}\n  <!-- /cited:jsonld -->`)
    : insertBeforeHead(out, `  <!-- cited:jsonld -->\n  ${jsonldScript}\n  <!-- /cited:jsonld -->\n`);

  return out;
}

// §3.4 PR body: score line, top-sources table, gap list, per-file change table, disclosure.
function buildPrBody(
  client: Client,
  score: Score,
  sources: Source[],
  gaps: Gap[],
  committed: Array<{ file: string; note: string }>,
): string {
  const pct = Math.round(score.visibility * 100);
  const lines: string[] = [];
  lines.push(`**AI visibility:** cited in ${score.cited_queries}/${score.total_queries} queries (${pct}%)`);
  lines.push("");
  lines.push("### Who owns this category");
  lines.push("| Domain | Citations | Present |");
  lines.push("|---|---|---|");
  const top = [...sources].sort((a, b) => b.citation_count - a.citation_count).slice(0, 5);
  for (const s of top) lines.push(`| ${s.domain} | ${s.citation_count} | ${s.client_present ? "✅" : "❌"} |`);
  lines.push("");
  lines.push("### Gaps targeted");
  for (const g of gaps) lines.push(`- ${g.keyword} — ${g.type}, ${g.citations} citations`);
  lines.push("");
  lines.push("### Changes");
  lines.push("| File | What / why |");
  lines.push("|---|---|");
  for (const c of committed) lines.push(`| \`${c.file}\` | ${c.note} |`);
  lines.push("");
  lines.push(`Opened by CITED (hackathon demo) — review before merging.`);
  return lines.join("\n");
}

/**
 * PRD-B §3.4 — resolve token, walk the access ladder (direct → invite → fork
 * → skipped), commit actions to the fixed branch, open or reuse the PR.
 * dryRun is strictly read-only (no accept / fork / refs / PUT / PR).
 */
export async function openPr(
  client: Client,
  score: Score,
  sources: Source[],
  gaps: Gap[],
  actions: Action[],
  opts?: { branch?: string; dryRun?: boolean; waitInviteSecs?: number },
): Promise<PrResult> {
  const token = resolveToken();
  if (!token) {
    console.error("[github] no GitHub token — skipping PR step");
    return { pr_url: null, mode: "skipped", detail: "no GitHub token (set GITHUB_TOKEN or `gh auth login`)" };
  }

  const repoRef = parseRepoRef(client.repo);
  if (!repoRef) return { pr_url: null, mode: "skipped", detail: `invalid repo ref: "${client.repo}"` };
  const { owner, repo } = repoRef;
  const fullName = `${owner}/${repo}`;
  const branch = opts?.branch ?? "cited/visibility-fixes"; // FIXED — reruns must converge (§3.4)
  const dryRun = opts?.dryRun === true;

  // Every network call goes through this helper (§3.4).
  const gh = async (path: string, init?: { method?: string; body?: unknown }): Promise<GhResult> => {
    const payload = init?.body;
    const res = await fetch("https://api.github.com" + path, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cited-hackathon",
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null; // 204s / non-JSON bodies
    }
    return { status: res.status, json };
  };

  let mode: PrResult["mode"] = "skipped"; // "skipped" until access is established
  let step = "check repo access";
  try {
    // ---- access ladder (§3.4) ----
    const repoRes = await gh(`/repos/${owner}/${repo}`);
    let targetOwner = owner;
    let defaultBranch: string =
      typeof repoRes.json?.default_branch === "string" ? repoRes.json.default_branch : "main";
    let baseBranch = defaultBranch; // orig repo's default branch — PR base
    const isPublic = repoRes.status === 200 && repoRes.json?.private === false;
    let havePush = repoRes.status === 200 && repoRes.json?.permissions?.push === true;

    if (havePush) {
      mode = "direct";
      console.error("[github] direct access confirmed");
      if (dryRun) return { pr_url: null, mode, detail: "push access confirmed — would open PR" };
    } else {
      // (2) invite — poll every 5s up to waitInviteSecs (0 ⇒ exactly one
      // immediate check; dryRun ⇒ always a single check). SAFETY: the account
      // holds real unrelated pending invitations — accept ONLY on an exact
      // full_name match; never call the accept endpoint otherwise.
      step = "check invitations";
      const waitSecs = opts?.waitInviteSecs ?? 0;
      const deadline = Date.now() + waitSecs * 1000;
      let invitation: { id: number; full_name: string } | null = null;
      for (;;) {
        const inv = await gh("/user/repository_invitations");
        if (inv.status === 200 && Array.isArray(inv.json)) {
          const hit = inv.json.find(
            (i: any) =>
              typeof i?.repository?.full_name === "string" &&
              i.repository.full_name.toLowerCase() === fullName.toLowerCase(),
          );
          if (hit) invitation = { id: hit.id, full_name: hit.repository.full_name };
        }
        if (invitation || dryRun || Date.now() >= deadline) break;
        console.error(`[github] no invitation for ${fullName} yet — polling again in 5s`);
        await sleep(5000);
      }

      if (invitation) {
        mode = "invite";
        console.error(`[github] invitation found for ${invitation.full_name}`);
        if (dryRun) return { pr_url: null, mode, detail: "invitation found — would accept" };
        step = "accept invitation";
        const accepted = await gh(`/user/repository_invitations/${invitation.id}`, { method: "PATCH" });
        if (accepted.status !== 204) {
          return { pr_url: null, mode, detail: `accept invitation: HTTP ${accepted.status}` };
        }
        console.error(`[github] accepted invitation ${invitation.id} for ${invitation.full_name}`);
        step = "confirm access after invitation";
        havePush = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          const recheck = await gh(`/repos/${owner}/${repo}`);
          if (recheck.status === 200 && recheck.json?.permissions?.push === true) {
            havePush = true;
            if (typeof recheck.json.default_branch === "string") {
              defaultBranch = recheck.json.default_branch;
              baseBranch = defaultBranch;
            }
            break;
          }
          if (attempt < 4) await sleep(3000);
        }
        if (!havePush) return { pr_url: null, mode, detail: "invitation accepted but push access not confirmed" };
        console.error("[github] push access confirmed after invitation");
      } else if (repoRes.status === 404) {
        return { pr_url: null, mode: "skipped", detail: "repo not found or no access" };
      } else if (repoRes.status === 403) {
        return { pr_url: null, mode: "skipped", detail: `access to ${fullName} forbidden (HTTP 403)` };
      } else if (!isPublic) {
        return { pr_url: null, mode: "skipped", detail: `no push access to ${fullName} and no pending invitation` };
      } else {
        // (3) fork — repo is public but we cannot push to it
        mode = "fork";
        if (dryRun) return { pr_url: null, mode, detail: "would fork and open cross-repo PR" };
        step = "resolve authed login";
        const me = await gh("/user");
        const login: string | null =
          me.status === 200 && typeof me.json?.login === "string" ? me.json.login : null;
        if (!login) return { pr_url: null, mode, detail: `get authed user: HTTP ${me.status}` };
        step = "create fork";
        const fork = await gh(`/repos/${owner}/${repo}/forks`, { method: "POST" });
        if (fork.status !== 202) return { pr_url: null, mode, detail: `create fork: HTTP ${fork.status}` };
        step = "wait for fork";
        let forkReady = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          const f = await gh(`/repos/${login}/${repo}`);
          if (f.status === 200) {
            forkReady = true;
            if (typeof f.json?.default_branch === "string") defaultBranch = f.json.default_branch;
            break;
          }
          if (attempt < 5) await sleep(5000);
        }
        if (!forkReady) return { pr_url: null, mode, detail: "fork not ready after 30s" };
        targetOwner = login;
        console.error(`[github] fork ready: ${login}/${repo}`);
      }
    }

    // ---- ship steps (§3.4): fixed branch + contents-API commits ----
    const target = `${targetOwner}/${repo}`;
    step = "resolve branch";
    const branchRef = await gh(`/repos/${target}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (branchRef.status === 200) {
      console.error("[github] branch reused");
    } else if (branchRef.status === 404) {
      step = "create branch";
      const baseRef = await gh(`/repos/${target}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
      const baseSha: string | null =
        baseRef.status === 200 && typeof baseRef.json?.object?.sha === "string" ? baseRef.json.object.sha : null;
      if (!baseSha) return { pr_url: null, mode, detail: `get ${defaultBranch} ref: HTTP ${baseRef.status}` };
      const created = await gh(`/repos/${target}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: baseSha },
      });
      if (created.status === 201) console.error(`[github] branch created: ${branch}`);
      else if (created.status === 422) console.error("[github] branch reused (already existed)"); // create race → reuse
      else return { pr_url: null, mode, detail: `create branch: HTTP ${created.status}` };
    } else {
      return { pr_url: null, mode, detail: `get branch ref: HTTP ${branchRef.status}` };
    }

    const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");
    // File SHAs are always branch-current (?ref={branch}) so re-PUTs on a reused branch converge (§3.4).
    const getFile = async (
      path: string,
      refName: string,
    ): Promise<{ status: number; sha: string | null; text: string | null }> => {
      const res = await gh(`/repos/${target}/contents/${encodePath(path)}?ref=${encodeURIComponent(refName)}`);
      if (res.status === 200 && typeof res.json?.content === "string") {
        return {
          status: res.status,
          sha: typeof res.json.sha === "string" ? res.json.sha : null,
          text: Buffer.from(res.json.content, "base64").toString("utf8"),
        };
      }
      return { status: res.status, sha: null, text: null };
    };
    const putFile = async (path: string, message: string, text: string, sha: string | null): Promise<number> => {
      const res = await gh(`/repos/${target}/contents/${encodePath(path)}`, {
        method: "PUT",
        body: {
          message,
          content: Buffer.from(text, "utf8").toString("base64"),
          branch,
          ...(sha ? { sha } : {}),
        },
      });
      if (res.status === 200 || res.status === 201) console.error(`[github] committed ${path}`);
      return res.status;
    };
    const committed: Array<{ file: string; note: string }> = [];
    const commit = async (path: string, message: string, text: string, note: string): Promise<PrResult | null> => {
      const existing = await getFile(path, branch);
      const status = await putFile(path, message, text, existing.sha);
      if (status !== 200 && status !== 201) return { pr_url: null, mode, detail: `commit ${path}: HTTP ${status}` };
      committed.push({ file: path, note });
      return null;
    };

    for (const action of actions) {
      if (action.type === "meta") {
        step = "commit metadata";
        const htmlPath = action.file || "index.html";
        const onBranch = await getFile(htmlPath, branch);
        let html = onBranch.text;
        const htmlSha = onBranch.sha; // null ⇒ file absent on branch (PUT will create it there)
        if (onBranch.status !== 200) {
          const onDefault = await getFile(htmlPath, defaultBranch);
          html = onDefault.text;
        }
        const meta = coerceMeta(parseMetaAfter(action.after));
        if (html !== null && html.includes("</head>") && meta) {
          const patched = patchHead(html, meta);
          const status = await putFile(htmlPath, "cited: rewrite metadata for AI visibility", patched, htmlSha);
          if (status !== 200 && status !== 201) {
            return { pr_url: null, mode, detail: `commit ${htmlPath}: HTTP ${status}` };
          }
          committed.push({
            file: htmlPath,
            note: "Rewritten <title> + meta description, JSON-LD upserted so AI answer engines can identify the product",
          });
        } else {
          // §3.4 fallback: add-only recommendations file — NEVER create index.html where none existed.
          const failed = await commit(
            "seo/meta-recommendations.html",
            "cited: add metadata recommendations",
            action.after,
            "Recommended metadata (index.html missing or lacked </head> — nothing overwritten)",
          );
          if (failed) return failed;
        }
      } else {
        step = `commit ${action.file}`;
        const message =
          action.file === "llms.txt"
            ? "cited: add llms.txt"
            : action.file.startsWith("blog/")
              ? "cited: add gap-targeting page"
              : `cited: update ${action.file}`;
        const note =
          action.file === "llms.txt"
            ? "llms.txt — canonical site summary for LLM crawlers"
            : action.file.startsWith("blog/")
              ? "Gap-targeting page for an uncited, high-citation query"
              : "Content generated by CITED";
        const failed = await commit(action.file, message, action.after, note);
        if (failed) return failed;
      }
    }

    const indexNowKey = process.env.INDEXNOW_KEY;
    if (indexNowKey) {
      step = "commit IndexNow key file";
      const failed = await commit(
        `${indexNowKey}.txt`,
        "cited: add IndexNow key file",
        indexNowKey,
        "IndexNow key file — proves site ownership for the post-deploy ping (§3.5)",
      );
      if (failed) return failed;
    }

    // ---- PR: reuse by head, else open (§3.4) ----
    step = "check for existing PR";
    const prBody = buildPrBody(client, score, sources, gaps, committed);
    const headFilter = `${targetOwner}:${branch}`;
    const existingPrs = await gh(
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(headFilter)}`,
    );
    if (existingPrs.status === 200 && Array.isArray(existingPrs.json) && existingPrs.json.length > 0) {
      const existing = existingPrs.json[0];
      const prUrl: string | null = typeof existing?.html_url === "string" ? existing.html_url : null;
      try {
        await gh(`/repos/${owner}/${repo}/pulls/${existing.number}`, { method: "PATCH", body: { body: prBody } });
      } catch {
        // body refresh is best-effort — ignore failures
      }
      console.error(`[github] existing PR reused: ${prUrl ?? "(unknown url)"}`);
      return { pr_url: prUrl, mode, detail: "existing PR reused" };
    }

    step = "open PR";
    const createdPr = await gh(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: {
        title: `CITED: AI-visibility fixes for ${client.name}`,
        head: mode === "fork" ? `${targetOwner}:${branch}` : branch, // cross-repo form when forked
        base: baseBranch,
        body: prBody,
        // not a draft — demo needs the green Open badge
      },
    });
    if (createdPr.status === 201 && typeof createdPr.json?.html_url === "string") {
      console.error(`[github] PR opened: ${createdPr.json.html_url}`);
      const detail =
        mode === "invite"
          ? "invitation accepted, PR opened"
          : mode === "fork"
            ? "forked and opened cross-repo PR"
            : "PR opened";
      return { pr_url: createdPr.json.html_url, mode, detail };
    }
    const apiMessage = typeof createdPr.json?.message === "string" ? ` — ${createdPr.json.message}` : "";
    return { pr_url: null, mode, detail: `open PR: HTTP ${createdPr.status}${apiMessage}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { pr_url: null, mode, detail: `${step}: ${reason}` };
  }
}
