/**
 * ADLAYER — Pioneer (Fastino) client.
 *
 *   moderate(text)                  -> GLiGuard LLM Guardrails 300M
 *   extractEntities(text, schema)   -> GLiNER2 Large
 *
 * Rules this file obeys, from PRD-A §4:
 *   - Zero runtime dependencies. Node stdlib + global fetch only.
 *   - Runs keyless. A missing PIONEER_API_KEY logs ONE line and degrades.
 *   - Never throws. Every failure path returns a DEGRADED result instead.
 *
 * What is CONFIRMED against Pioneer's docs and what is not:
 *   CONFIRMED  base URL, X-API-Key header, model ids, both request shapes.
 *   CONFIRMED  the response ENVELOPE (openapi.json `EncoderInferenceResponse`).
 *   NOT DOCUMENTED  the inner `result` payload. There is no worked success
 *                   example anywhere in Pioneer's documentation, and for the
 *                   chat route `choices[].message` is typed as a bare object.
 *
 * So the parser is a recursive harvester, not a shape-bound reader. It walks
 * the whole decoded body and collects anything that looks like a
 * {label, score} classification, at any nesting depth, in any of the plausible
 * layouts. Cost of tolerating every shape: about forty lines.
 *
 * The posture that matters more than the parse:
 *   ZERO HARVESTED HITS IS NOT "CLEAN". It is "unknown".
 * `ran` is false whenever we could not confirm a real moderation pass, and
 * compliance.ts fails closed on that. An unreviewed creative must never reach
 * approved because a parser missed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants — the API surface, in one place
// ─────────────────────────────────────────────────────────────────────────────

export const PIONEER_BASE_URL = "https://api.pioneer.ai";

/** Catalog id. Not "gliguard-300M" — this exact string. */
export const GLIGUARD_MODEL = "fastino/gliguard-LLMGuardrails-300M";
export const GLINER2_MODEL = "fastino/gliner2-large-v1";

/**
 * GLiGuard is documented on the OpenAI-compatible route, not the encoder route.
 * Kept as one constant: if the chat response proves opaque against a live key,
 * flipping to "/inference" (documented envelope) is a one-line change.
 */
export const GLIGUARD_PATH = "/v1/chat/completions";
export const ENCODER_PATH = "/inference";

export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_TIMEOUT_MS = 8000;

/** Labels that mean "nothing fired". Everything else is a flag. */
export const SAFE_LABELS: ReadonlySet<string> = new Set([
  "safe",
  "benign",
  "compliance",
  "none",
  "clean",
]);

const JAILBREAK_LABELS = [
  "prompt_injection",
  "jailbreak_attempt",
  "policy_evasion",
  "instruction_override",
  "system_prompt_exfiltration",
  "data_exfiltration",
  "roleplay_bypass",
  "hypothetical_bypass",
  "obfuscated_attack",
  "multi_step_attack",
  "social_engineering",
  "benign",
] as const;

const TOXICITY_LABELS = [
  "violence_and_weapons",
  "non_violent_crime",
  "sexual_content",
  "hate_and_discrimination",
  "self_harm_and_suicide",
  "pii_exposure",
  "misinformation",
  "copyright_violation",
  "child_safety",
  "political_manipulation",
  "unethical_conduct",
  "regulated_advice",
  "privacy_violation",
  "other",
  "benign",
] as const;

/**
 * All three tasks run in one pass. `jailbreak_detection` is the one that earns
 * its keep here: it carries a `prompt_injection` label, which is precisely the
 * veto AdLayer needs — an advertiser trying to smuggle agent-steering text into
 * a paid placement is the exact thing we refuse to ship.
 */
export const GLIGUARD_SCHEMA = {
  classifications: [
    {
      task: "prompt_safety",
      labels: ["safe", "unsafe"],
      multi_label: false,
      threshold: DEFAULT_THRESHOLD,
    },
    {
      task: "jailbreak_detection",
      labels: [...JAILBREAK_LABELS],
      multi_label: true,
      threshold: DEFAULT_THRESHOLD,
    },
    {
      task: "prompt_toxicity",
      labels: [...TOXICITY_LABELS],
      multi_label: true,
      threshold: DEFAULT_THRESHOLD,
    },
  ],
} as const;

/**
 * The tasks a GLiGuard call ASKS ABOUT. `ran` means "every one of these
 * answered", not "I found something". The old bar was one harvested hit
 * anywhere in the body, so a 200 carrying only `prompt_safety: safe` — or a
 * queued-request ack whose only recognisable token was the string "safe" —
 * read as a completed moderation pass, and `jailbreak_detection`, the task
 * carrying the `prompt_injection` label this whole veto exists for, never ran.
 */
export const REQUIRED_TASKS: readonly string[] = GLIGUARD_SCHEMA.classifications.map(
  (c) => c.task,
);

/** Every label the documented tasks can emit. Used to reject parser noise. */
const KNOWN_LABELS: ReadonlySet<string> = new Set<string>([
  "safe",
  "unsafe",
  ...JAILBREAK_LABELS,
  ...TOXICITY_LABELS,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface Hit {
  /** Nearest task context we could attribute, or null. */
  task: string | null;
  label: string;
  /** null when the shape carried no score — treated as "fires". */
  score: number | null;
}

export interface ModerationResult {
  /**
   * True only when a COMPLETE moderation pass happened and we understood the
   * answer — every task in REQUIRED_TASKS came back with a classification.
   * False on: missing key, network error, non-2xx, unparseable body, a 200
   * whose shape yielded nothing, and a 200 that answered only some of the
   * tasks we asked about. Callers must fail closed.
   *
   * `flags` is still populated when this is false: a partial pass cannot
   * certify a creative clean, but a label that fired is real.
   */
  ran: boolean;
  degraded: boolean;
  /** One short phrase, safe to put in a rationale string. */
  degraded_reason: string | null;
  /** Resolved model id from the response, else the requested id, else "none". */
  model: string;
  /** Non-safe labels at or above threshold, as "task:label". */
  flags: string[];
  hits: Hit[];
  latency_ms: number | null;
  raw: unknown;
}

export interface EntityHit {
  text: string;
  label: string;
  start: number | null;
  end: number | null;
  score: number | null;
}

export interface EncoderSchema {
  entities?: string[];
  classifications?: Array<{
    task: string;
    labels: string[];
    multi_label?: boolean;
    threshold?: number;
  }>;
}

export interface ExtractionResult {
  ran: boolean;
  degraded: boolean;
  degraded_reason: string | null;
  model: string;
  entities: EntityHit[];
  classifications: Hit[];
  /** Classification labels above threshold, de-duped. Feeds Advertiser.categories. */
  categories: string[];
  latency_ms: number | null;
  raw: unknown;
}

export interface PioneerConfig {
  /** Explicit key. Omit to read PIONEER_API_KEY from the environment. */
  apiKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  threshold?: number;
  guardPath?: string;
  /** Pioneer retains request/response payloads by default. We do not want that. */
  store?: boolean;
  fetchImpl?: typeof fetch;
  logger?: (message: string) => void;
}

export interface PioneerClient {
  moderate(text: string): Promise<ModerationResult>;
  extractEntities(text: string, schema: EncoderSchema): Promise<ExtractionResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Log-once plumbing. A missing key is one line, not one line per creative.
// ─────────────────────────────────────────────────────────────────────────────

const warned = new Set<string>();

function warnOnce(key: string, message: string, logger?: (m: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  (logger ?? ((m: string) => console.warn(m)))(message);
}

/** Test seam. Not used in the serving path. */
export function resetPioneerWarnings(): void {
  warned.clear();
}

function readKey(cfg: PioneerConfig): string | null {
  if (cfg.apiKey !== undefined) return cfg.apiKey === "" ? null : cfg.apiKey;
  const fromEnv = process.env["PIONEER_API_KEY"];
  return fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv.trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The defensive parser
// ─────────────────────────────────────────────────────────────────────────────

/** Envelope and metadata. Never mistake these for classifications. */
const META_KEYS: ReadonlySet<string> = new Set([
  "inference_id",
  "model_id",
  "model_used",
  "routed_model",
  "latency_ms",
  "token_usage",
  "type",
  "id",
  "object",
  "created",
  "model",
  "usage",
  "x_pioneer",
  "finish_reason",
  "index",
  "role",
  "system_fingerprint",
  "service_tier",
  "logprobs",
  "start",
  "end",
  "start_char",
  "end_char",
  "offset",
  "threshold",
  "multi_label",
  "store",
  "project_id",
  "include_confidence",
  "include_spans",
]);

/**
 * Container keys carry no task meaning — descending through them keeps the
 * inherited task. Any OTHER object key becomes the task for its subtree, which
 * is what turns {"result":{"prompt_safety":{"unsafe":0.98}}} into
 * {task:"prompt_safety", label:"unsafe", score:0.98}.
 */
const CONTAINER_KEYS: ReadonlySet<string> = new Set([
  "result",
  "results",
  "classifications",
  "classification",
  "output",
  "outputs",
  "data",
  "predictions",
  "prediction",
  "choices",
  "message",
  "content",
  "items",
  "list",
  "entities",
  "spans",
  "scores",
]);

const LABEL_KEYS_CLASSIFICATION = ["label", "class", "category"] as const;
const LABEL_KEYS_ENTITY = ["label", "class", "type", "entity", "category"] as const;
const TEXT_KEYS = ["text", "value", "span", "mention", "surface"] as const;
const SCORE_KEYS = ["score", "confidence", "probability", "prob", "logit"] as const;
/** Arrays of bare label strings hang off these. */
const LABEL_ARRAY_KEYS: ReadonlySet<string> = new Set(["labels", "classes", "categories", "tags"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function firstScore(obj: Record<string, unknown>): number | null {
  for (const k of SCORE_KEYS) {
    const n = finiteNumber(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Walk the entire decoded body and harvest every {label, score}-ish pair.
 * Handles, in one pass:
 *   [{task, label, score}]                     list-of-objects form
 *   {"prompt_safety": {"unsafe": 0.98}}        label -> score map form
 *   {"prompt_safety": "unsafe"}                bare-string form
 *   {"task": "x", "labels": ["unsafe"]}        label-array form
 * ...at any depth, in any envelope.
 */
export function harvestHits(root: unknown): Hit[] {
  const out: Hit[] = [];
  walk(root, null, out, new Set<object>(), 0);
  return dedupeHits(out);
}

function walk(
  node: unknown,
  task: string | null,
  out: Hit[],
  seen: Set<object>,
  depth: number,
): void {
  if (depth > 12) return;

  if (Array.isArray(node)) {
    for (const el of node) walk(el, task, out, seen, depth + 1);
    return;
  }
  if (!isPlainObject(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  const declared = node["task"];
  const localTask = typeof declared === "string" && declared.trim() !== "" ? declared.trim() : task;

  // Form 1 — this object IS a classification.
  const label = firstString(node, LABEL_KEYS_CLASSIFICATION);
  if (label !== null) {
    out.push({ task: localTask, label: normalizeLabel(label), score: firstScore(node) });
  }

  const entries = Object.entries(node).filter(([k]) => !META_KEYS.has(k));

  // Form 2 — label -> score map. Only when every remaining value is a number.
  if (
    label === null &&
    entries.length > 0 &&
    entries.every(([, v]) => finiteNumber(v) !== null)
  ) {
    for (const [k, v] of entries) {
      out.push({ task: localTask, label: normalizeLabel(k), score: finiteNumber(v) });
    }
    return;
  }

  for (const [k, v] of entries) {
    if (LABEL_KEYS_CLASSIFICATION.includes(k as (typeof LABEL_KEYS_CLASSIFICATION)[number])) {
      continue; // consumed by form 1
    }

    // Form 3 — bare string. Gated on a known label so prose cannot fake a flag.
    if (typeof v === "string") {
      const norm = normalizeLabel(v);
      if (KNOWN_LABELS.has(norm)) {
        out.push({ task: k === "task" ? localTask : k, label: norm, score: null });
      }
      continue;
    }

    // Form 4 — array of bare label strings.
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      const isLabelArray = LABEL_ARRAY_KEYS.has(k);
      for (const s of v as string[]) {
        const norm = normalizeLabel(s);
        if (isLabelArray || KNOWN_LABELS.has(norm)) {
          out.push({ task: isLabelArray ? localTask : k, label: norm, score: null });
        }
      }
      continue;
    }

    const childTask = CONTAINER_KEYS.has(k) ? localTask : k;
    walk(v, childTask, out, seen, depth + 1);
  }
}

function dedupeHits(hits: Hit[]): Hit[] {
  const byKey = new Map<string, Hit>();
  for (const h of hits) {
    const key = `${h.task ?? ""}|${h.label}`;
    const prior = byKey.get(key);
    // Keep the most informative copy: a scored hit beats an unscored one.
    if (prior === undefined || (prior.score === null && h.score !== null)) byKey.set(key, h);
  }
  return [...byKey.values()];
}

/**
 * The GLiGuard chat route may bury the payload in a content string. Pull out
 * every plausible root before harvesting.
 */
export function contentRoots(body: unknown): unknown[] {
  const roots: unknown[] = [body];
  if (!isPlainObject(body)) return roots;

  const choices = body["choices"];
  if (!Array.isArray(choices)) return roots;

  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;
    const message = choice["message"];
    if (!isPlainObject(message)) continue;
    const content = message["content"];

    const strings: string[] = [];
    if (typeof content === "string") strings.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (isPlainObject(part) && typeof part["text"] === "string") strings.push(part["text"]);
      }
    }

    for (const s of strings) {
      try {
        roots.push(JSON.parse(s));
      } catch {
        // Not JSON. If it is a bare label token, honour it; otherwise drop it —
        // free prose must never be mistaken for a classification.
        const norm = normalizeLabel(s);
        if (KNOWN_LABELS.has(norm)) roots.push({ label: norm });
      }
    }
  }
  return roots;
}

/** Non-safe labels at or above threshold, rendered as "task:label". */
export function hitsToFlags(hits: Hit[], threshold: number): string[] {
  const flags = new Set<string>();
  for (const h of hits) {
    if (SAFE_LABELS.has(h.label)) continue;
    // A hit with no score carries no evidence that it is below threshold.
    if (h.score !== null && h.score < threshold) continue;
    flags.add(h.task !== null ? `${h.task}:${h.label}` : h.label);
  }
  return [...flags].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport — degrade, never throw
// ─────────────────────────────────────────────────────────────────────────────

interface CallOutcome {
  ok: boolean;
  reason: string | null;
  body: unknown;
  latency_ms: number;
}

function errorDetail(body: unknown, status: number): string {
  if (isPlainObject(body)) {
    const detail = body["detail"];
    if (typeof detail === "string") return `HTTP ${status}: ${detail.slice(0, 200)}`;
    if (detail !== undefined) return `HTTP ${status}: ${JSON.stringify(detail).slice(0, 200)}`;
    const error = body["error"];
    if (isPlainObject(error) && typeof error["message"] === "string") {
      return `HTTP ${status}: ${(error["message"] as string).slice(0, 200)}`;
    }
  }
  return `HTTP ${status}`;
}

async function call(
  cfg: PioneerConfig,
  key: string,
  path: string,
  payload: unknown,
): Promise<CallOutcome> {
  const base = cfg.baseUrl ?? PIONEER_BASE_URL;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const started = Date.now();

  if (typeof doFetch !== "function") {
    return { ok: false, reason: "no fetch implementation", body: null, latency_ms: 0 };
  }

  try {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }

    const latency_ms = Date.now() - started;
    if (!res.ok) return { ok: false, reason: errorDetail(body, res.status), body, latency_ms };
    return { ok: true, reason: null, body, latency_ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /abort|timeout/i.test(message) ? `timeout after ${timeoutMs}ms` : message;
    return { ok: false, reason: reason.slice(0, 200), body: null, latency_ms: Date.now() - started };
  }
}

/**
 * The inner payload is undocumented, so log it once when asked. The first real
 * call collapses every ambiguity in this file.
 */
function debugDump(label: string, body: unknown): void {
  if (process.env["PIONEER_DEBUG"] !== "1") return;
  warnOnce(`debug:${label}`, `[pioneer] raw ${label} response: ${JSON.stringify(body)}`);
}

function resolveModel(body: unknown, requested: string): string {
  if (isPlainObject(body)) {
    const used = body["model_used"] ?? body["model"];
    if (typeof used === "string" && used.trim() !== "") return used.trim();
    const x = body["x_pioneer"];
    if (isPlainObject(x) && typeof x["routed_model"] === "string") return x["routed_model"];
  }
  return requested;
}

function degradedModeration(reason: string, model: string): ModerationResult {
  return {
    ran: false,
    degraded: true,
    degraded_reason: reason,
    model,
    flags: [],
    hits: [],
    latency_ms: null,
    raw: null,
  };
}

function degradedExtraction(reason: string, model: string): ExtractionResult {
  return {
    ran: false,
    degraded: true,
    degraded_reason: reason,
    model,
    entities: [],
    classifications: [],
    categories: [],
    latency_ms: null,
    raw: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// moderate() — GLiGuard
// ─────────────────────────────────────────────────────────────────────────────

export async function moderate(text: string, cfg: PioneerConfig = {}): Promise<ModerationResult> {
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
  const key = readKey(cfg);

  if (key === null) {
    warnOnce(
      "pioneer:nokey",
      "[pioneer] PIONEER_API_KEY unset — GLiGuard moderation disabled. " +
        "Creatives will be held unreviewed, never auto-approved.",
      cfg.logger,
    );
    return degradedModeration(
      "PIONEER_API_KEY unset",
      `none (PIONEER_API_KEY unset; would be ${GLIGUARD_MODEL})`,
    );
  }

  if (text.trim() === "") {
    return degradedModeration("empty text submitted for moderation", `none (${GLIGUARD_MODEL})`);
  }

  const payload = {
    model: GLIGUARD_MODEL,
    messages: [{ role: "user", content: text }],
    schema: GLIGUARD_SCHEMA,
    // Documented in GLiGuard prose, absent from ChatCompletionRequest properties.
    // Send it; do not depend on it.
    include_confidence: true,
    store: cfg.store ?? false,
  };

  const outcome = await call(cfg, key, cfg.guardPath ?? GLIGUARD_PATH, payload);
  if (!outcome.ok) {
    warnOnce(
      "pioneer:moderate:fail",
      `[pioneer] GLiGuard unavailable (${outcome.reason}) — moderation degraded, failing closed.`,
      cfg.logger,
    );
    return degradedModeration(outcome.reason ?? "unknown error", `none (${GLIGUARD_MODEL})`);
  }

  debugDump("gliguard", outcome.body);

  const harvested = dedupeHits(contentRoots(outcome.body).flatMap((root) => harvestHits(root)));
  const model = resolveModel(outcome.body, GLIGUARD_MODEL);

  // Drop hits attributed to a task we never asked about, so a stray
  // `{"status":"safe"}` field in a queue acknowledgement can never be counted
  // as a moderation pass. Unattributed hits (task === null) are kept: they can
  // still FIRE a flag, they just cannot certify coverage.
  const hits = harvested.filter((h) => h.task === null || REQUIRED_TASKS.includes(h.task));

  // A 200 we cannot read is UNKNOWN, not clean. Do not let a parser miss
  // green-light a creative.
  if (hits.length === 0) {
    warnOnce(
      "pioneer:moderate:unparsed",
      "[pioneer] GLiGuard returned 200 but no classification was recognised in the " +
        "response shape — treating as unavailable, not as clean.",
      cfg.logger,
    );
    return {
      ...degradedModeration("response shape not recognised", model),
      latency_ms: outcome.latency_ms,
      raw: outcome.body,
    };
  }

  const answered = new Set(hits.map((h) => h.task).filter((t): t is string => t !== null));
  const missing = REQUIRED_TASKS.filter((t) => !answered.has(t));
  const flags = hitsToFlags(hits, threshold);

  if (missing.length > 0) {
    warnOnce(
      "pioneer:moderate:partial",
      `[pioneer] GLiGuard answered only ${[...answered].join(", ") || "no task"} — ` +
        `missing ${missing.join(", ")}. A partial pass is not a review; failing closed.`,
      cfg.logger,
    );
    return {
      ran: false,
      degraded: true,
      degraded_reason: `partial classification: missing ${missing.join(", ")}`,
      model,
      // Whatever DID fire is still real evidence and travels with the result.
      flags,
      hits,
      latency_ms: outcome.latency_ms,
      raw: outcome.body,
    };
  }

  return {
    ran: true,
    degraded: false,
    degraded_reason: null,
    model,
    flags,
    hits,
    latency_ms: outcome.latency_ms,
    raw: outcome.body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractEntities() — GLiNER2 Large
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entity harvest is separate from classification harvest: an entity is an
 * object carrying BOTH a surface string and a label.
 */
export function harvestEntities(root: unknown): EntityHit[] {
  const out: EntityHit[] = [];
  walkEntities(root, null, out, new Set<object>(), 0);
  const byKey = new Map<string, EntityHit>();
  for (const e of out) byKey.set(`${e.label}|${e.text.toLowerCase()}`, e);
  return [...byKey.values()];
}

function walkEntities(
  node: unknown,
  label: string | null,
  out: EntityHit[],
  seen: Set<object>,
  depth: number,
): void {
  if (depth > 12) return;

  if (Array.isArray(node)) {
    for (const el of node) {
      // Map form: {"organization": ["Acme", "Apple"]}
      if (typeof el === "string" && label !== null && el.trim() !== "") {
        out.push({ text: el.trim(), label: normalizeLabel(label), start: null, end: null, score: null });
      } else {
        walkEntities(el, label, out, seen, depth + 1);
      }
    }
    return;
  }
  if (!isPlainObject(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  const own = firstString(node, LABEL_KEYS_ENTITY);
  const surface = firstString(node, TEXT_KEYS);
  if (surface !== null && (own ?? label) !== null) {
    out.push({
      text: surface,
      label: normalizeLabel((own ?? label) as string),
      start: finiteNumber(node["start"]),
      end: finiteNumber(node["end"]),
      score: firstScore(node),
    });
  }

  for (const [k, v] of Object.entries(node)) {
    if (META_KEYS.has(k)) continue;
    if (typeof v === "string" || typeof v === "number") continue;
    const childLabel = CONTAINER_KEYS.has(k) ? label : k;
    walkEntities(v, childLabel, out, seen, depth + 1);
  }
}

export async function extractEntities(
  text: string,
  schema: EncoderSchema,
  cfg: PioneerConfig = {},
): Promise<ExtractionResult> {
  const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
  const key = readKey(cfg);

  if (key === null) {
    warnOnce(
      "pioneer:nokey",
      "[pioneer] PIONEER_API_KEY unset — GLiNER2 extraction disabled, returning empty.",
      cfg.logger,
    );
    return degradedExtraction(
      "PIONEER_API_KEY unset",
      `none (PIONEER_API_KEY unset; would be ${GLINER2_MODEL})`,
    );
  }

  if (text.trim() === "") {
    return degradedExtraction("empty text submitted for extraction", `none (${GLINER2_MODEL})`);
  }

  // openapi.json is the machine-readable source of truth and uses the object
  // form; every prose page uses flat strings. Send objects, retry flat on 422.
  const build = (objectForm: boolean): Record<string, unknown> => {
    const s: Record<string, unknown> = {};
    if (schema.entities !== undefined && schema.entities.length > 0) {
      s["entities"] = objectForm ? schema.entities.map((name) => ({ name })) : schema.entities;
    }
    if (schema.classifications !== undefined && schema.classifications.length > 0) {
      s["classifications"] = schema.classifications;
    }
    return {
      model_id: GLINER2_MODEL,
      text,
      schema: s,
      threshold,
      include_confidence: true,
      store: cfg.store ?? false,
    };
  };

  let outcome = await call(cfg, key, ENCODER_PATH, build(true));
  if (!outcome.ok && outcome.reason !== null && outcome.reason.startsWith("HTTP 422")) {
    outcome = await call(cfg, key, ENCODER_PATH, build(false));
  }

  if (!outcome.ok) {
    warnOnce(
      "pioneer:extract:fail",
      `[pioneer] GLiNER2 unavailable (${outcome.reason}) — extraction degraded, returning empty.`,
      cfg.logger,
    );
    return degradedExtraction(outcome.reason ?? "unknown error", `none (${GLINER2_MODEL})`);
  }

  debugDump("gliner2", outcome.body);

  const model = resolveModel(outcome.body, GLINER2_MODEL);
  const entities = harvestEntities(outcome.body);
  const classifications = harvestHits(outcome.body).filter((h) => !SAFE_LABELS.has(h.label));
  const categories = [
    ...new Set(
      classifications
        .filter((h) => h.score === null || h.score >= threshold)
        .map((h) => h.label),
    ),
  ].sort();

  return {
    ran: true,
    degraded: false,
    degraded_reason: null,
    model,
    entities,
    classifications,
    categories,
    latency_ms: outcome.latency_ms,
    raw: outcome.body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory — bind config once, inject a fake in tests
// ─────────────────────────────────────────────────────────────────────────────

export function createPioneerClient(cfg: PioneerConfig = {}): PioneerClient {
  return {
    moderate: (text: string) => moderate(text, cfg),
    extractEntities: (text: string, schema: EncoderSchema) => extractEntities(text, schema, cfg),
  };
}

export const pioneer: PioneerClient = createPioneerClient();
