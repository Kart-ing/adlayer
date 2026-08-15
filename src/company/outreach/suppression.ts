/**
 * ADLAYER — the SUPPRESSION LIST.
 *
 * An opt-out that lives in someone's memory is not an opt-out. This is the file
 * on disk, it is append-only, and it is read before every send.
 *
 * ── WHY APPEND-ONLY ──────────────────────────────────────────────────────────
 *
 * Same reason the DecisionLog is: the failure mode worth engineering against is
 * not disk corruption, it is a later version of us quietly dropping a row to
 * make a number look better. There is deliberately no code path in this module
 * that opens the file with any flag but `a`, and no `remove()` function. An
 * address that opts out and later opts back in gets a second `resubscribe` line
 * on top of the first — the history stays, and `isSuppressed()` reads the LAST
 * word on an address rather than the first, so the record is both complete and
 * current.
 *
 * ── WHAT COUNTS AS THE SAME ADDRESS ──────────────────────────────────────────
 *
 * Lowercased and trimmed. Deliberately NOT provider-specific normalisation
 * (Gmail dot-stripping, `+tag` removal): those rules are wrong for most domains,
 * and an over-broad match suppresses somebody who never asked to be. But the
 * list DOES accept a bare `@domain.com` entry, which suppresses the whole
 * domain — a company that tells us to stop should not have to enumerate its
 * staff.
 *
 * ── SAFETY POSTURE ───────────────────────────────────────────────────────────
 *
 *  · FAILS CLOSED. If the suppression file exists and cannot be read, this
 *    module reports the read as failed and `send.ts` treats that as a block. An
 *    unreadable opt-out list is not an empty opt-out list. A file that has never
 *    existed is genuinely empty and reads as such.
 *  · `unsubscribe()` writes. It is the ONE function in this directory that
 *    touches disk without a dry-run flag, on purpose: refusing to record an
 *    opt-out because we were in dry run is the wrong failure in every direction.
 *  · Zero runtime dependencies. Node stdlib only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SUPPRESSION_PATH } from "./transport.ts";

export type SuppressionAction = "unsubscribe" | "resubscribe";

export interface SuppressionRecord {
  /** Normalized address, or `@domain` for a domain-wide entry. */
  address: string;
  action: SuppressionAction;
  /** Free text: "replied no", "bounce", "manual". */
  reason: string;
  /** Where the request came from, so a reader can check it. */
  ref: string | null;
  recorded_at: string;
}

export interface SuppressionList {
  records: SuppressionRecord[];
  /** Current state per address: true when the last word was `unsubscribe`. */
  suppressed: Set<string>;
  path: string;
  /** True when the file exists and could not be read. Callers must fail closed. */
  read_failed: boolean;
  detail: string;
  /** Lines that did not parse, with line numbers. Never silently dropped. */
  malformed: { line: number; raw: string }[];
}

export interface SuppressionOptions {
  path?: string;
  now?: () => Date;
  logger?: (message: string) => void;
}

/** Lowercase and trim. Nothing cleverer — see the header. */
export function normalizeAddress(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** `alice@acme.com` → `@acme.com`. Empty when there is no domain part. */
export function domainKeyOf(address: string): string | null {
  const at = normalizeAddress(address).lastIndexOf("@");
  if (at < 0) return null;
  const domain = normalizeAddress(address).slice(at);
  return domain === "@" ? null : domain;
}

/**
 * Read the list. Never throws.
 *
 * A missing file is an empty list, which is correct: nobody has opted out yet.
 * A file that exists and cannot be read sets `read_failed`, which the caller
 * MUST treat as a block — see `isSuppressed`'s contract below.
 */
export function loadSuppressions(options: SuppressionOptions = {}): SuppressionList {
  const path = options.path ?? DEFAULT_SUPPRESSION_PATH;
  const empty: SuppressionList = {
    records: [],
    suppressed: new Set<string>(),
    path,
    read_failed: false,
    detail: "",
    malformed: [],
  };

  if (!existsSync(path)) {
    return { ...empty, detail: `${path} does not exist — nobody has opted out yet` };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return {
      ...empty,
      read_failed: true,
      detail: `${path} exists but could not be read (${err instanceof Error ? err.message : String(err)}) — treating every recipient as suppressed`,
    };
  }

  const records: SuppressionRecord[] = [];
  const malformed: { line: number; raw: string }[] = [];
  const state = new Map<string, SuppressionAction>();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformed.push({ line: i + 1, raw });
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      malformed.push({ line: i + 1, raw });
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const address = typeof record["address"] === "string" ? normalizeAddress(record["address"]) : "";
    const action = record["action"] === "resubscribe" ? "resubscribe" : "unsubscribe";
    if (address === "") {
      malformed.push({ line: i + 1, raw });
      continue;
    }
    records.push({
      address,
      action,
      reason: typeof record["reason"] === "string" ? record["reason"] : "",
      ref: typeof record["ref"] === "string" ? record["ref"] : null,
      recorded_at: typeof record["recorded_at"] === "string" ? record["recorded_at"] : "",
    });
    state.set(address, action);
  }

  const suppressed = new Set<string>();
  for (const [address, action] of state) {
    if (action === "unsubscribe") suppressed.add(address);
  }

  return {
    records,
    suppressed,
    path,
    read_failed: false,
    detail: `${path}: ${records.length} record(s), ${suppressed.size} address(es) currently suppressed`,
    malformed,
  };
}

export interface SuppressionCheck {
  suppressed: boolean;
  /** Which entry matched: the exact address, the domain, or nothing. */
  matched: string | null;
  reason: string;
}

/**
 * Is this address on the list?
 *
 * FAILS CLOSED on an unreadable file. That is the whole contract: the only
 * acceptable direction for this function to be wrong is to refuse to mail
 * somebody we were allowed to mail.
 */
export function checkSuppression(address: string, list: SuppressionList): SuppressionCheck {
  if (list.read_failed) {
    return {
      suppressed: true,
      matched: null,
      reason: `the suppression list could not be read (${list.detail}) — refusing to send rather than risk mailing somebody who opted out`,
    };
  }
  const normalized = normalizeAddress(address);
  if (normalized === "") {
    return { suppressed: true, matched: null, reason: "no recipient address to check against the list" };
  }
  if (list.suppressed.has(normalized)) {
    return { suppressed: true, matched: normalized, reason: `${normalized} has opted out` };
  }
  const domain = domainKeyOf(normalized);
  if (domain !== null && list.suppressed.has(domain)) {
    return { suppressed: true, matched: domain, reason: `${domain} is suppressed domain-wide` };
  }
  return { suppressed: false, matched: null, reason: `${normalized} is not on the suppression list` };
}

/** Convenience: load and check in one call. */
export function isSuppressed(address: string, options: SuppressionOptions = {}): boolean {
  return checkSuppression(address, loadSuppressions(options)).suppressed;
}

/**
 * Record an opt-out. Appends; never rewrites.
 *
 * This is the entry point a human calls when somebody replies "no", and the one
 * an unsubscribe endpoint would call. It writes even in dry run — see the
 * header. It throws only when the append genuinely fails, because an opt-out we
 * silently failed to record is the single worst outcome in this directory and
 * the caller must find out.
 */
export function unsubscribe(
  address: string,
  reason: string = "requested",
  options: SuppressionOptions & { ref?: string | null; action?: SuppressionAction } = {},
): SuppressionRecord {
  const path = options.path ?? DEFAULT_SUPPRESSION_PATH;
  const now = (options.now ?? ((): Date => new Date()))();
  const normalized = normalizeAddress(address);
  if (normalized === "") {
    throw new Error("refusing to record an opt-out with no address");
  }

  const record: SuppressionRecord = {
    address: normalized,
    action: options.action ?? "unsubscribe",
    reason,
    ref: options.ref ?? null,
    recorded_at: now.toISOString(),
  };

  const dir = dirname(path);
  if (dir !== "" && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Append-only. There is deliberately no other write path in this module.
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });

  (options.logger ?? ((m: string): void => console.log(m)))(
    `[adlayer:outreach] recorded ${record.action} for ${normalized} in ${path}`,
  );
  return record;
}
