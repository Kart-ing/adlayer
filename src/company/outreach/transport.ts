/**
 * ADLAYER — the outreach TRANSPORT.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * An external audit landed the correct criticism: "AdLayer has an agent org that
 * decides and a company that does not yet execute." Specifically, the Closer
 * decides three things "and nothing that leaves the process: `sent` is a literal
 * false and no transport exists, so it has never been wrong in a way a prospect
 * could settle."
 *
 * This is the thing that leaves the process. It is deliberately the dumbest file
 * in the directory: it does not decide anything, it does not check anything, and
 * it must never be called except through `send.ts`, which runs the compliance
 * gate first. A transport that could be called directly is a compliance gate
 * that can be skipped.
 *
 * ── THE THREE TRANSPORTS ─────────────────────────────────────────────────────
 *
 *   resend — one POST to https://api.resend.com/emails on global fetch. Zero
 *     dependencies, which is why it was chosen over SES or an SDK.
 *   file   — writes an RFC 5322 `.eml` to disk. This is the WORKING DEFAULT for
 *     the hackathon: a sending domain cannot be reliably DNS-verified inside the
 *     window (see docs/OUTREACH.md §1), so the honest artifact is a byte-exact
 *     message a reader can open, not a claim about deliverability.
 *   null   — refuses and says why. Used when even the outbox is unavailable.
 *
 * ── SAFETY POSTURE ───────────────────────────────────────────────────────────
 *
 *  · MISSING CONFIG NEVER THROWS. It degrades to `file` and logs ONE line per
 *    process. A transport that throws on a missing key turns a config problem
 *    into an outage in the one subsystem where failing quiet-and-safe is right.
 *  · NO ENV VAR IN THIS FILE ARMS ANYTHING. `LIVE_SEND` is read in send.ts and
 *    nowhere else, so there is exactly one place to audit.
 *  · HEADER VALUES ARE SANITISED AT THE BOUNDARY. A CR or LF in a recipient
 *    address is header injection; `compliance.ts` blocks it and this file
 *    refuses it again, because a single check in front of a network call is one
 *    check away from a forged Bcc.
 *  · Zero runtime dependencies. Node stdlib and global fetch.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// The message. Composed by send.ts, checked by compliance.ts, carried by here.
// ─────────────────────────────────────────────────────────────────────────────

export interface OutreachMessage {
  /** Bare recipient address. */
  to: string;
  /** `Name <address>` or a bare address. Never defaulted to a plausible lie. */
  from: string;
  /** Address that accepts an opt-out and reaches a human. */
  reply_to: string | null;
  subject: string;
  /** Plain text only. We do not send HTML — an llms.txt ad network mailing
   *  tracking pixels would be a poor look, and text has no rendering surface. */
  text: string;
  /** `List-Unsubscribe` and friends. Values must not contain CR or LF. */
  headers: Record<string, string>;
}

export type TransportName = "resend" | "file" | "null";

export interface SendReceipt {
  transport: TransportName;
  /** The transport accepted the message. For `file`, that means bytes on disk. */
  ok: boolean;
  /**
   * TRUE ONLY when the message was handed to an email service provider that
   * will attempt delivery to the recipient. The file transport writes a real
   * message to a real path and still reports `false`, because a file in
   * `.outbox/` has not reached anyone and calling it "sent" is the exact
   * self-flattery this whole directory exists to prevent.
   */
  transmitted: boolean;
  /** Provider message id, so a send is checkable outside our own log. */
  provider_id: string | null;
  /** Path written, for the file transport. */
  path: string | null;
  detail: string;
  attempted_at: string;
}

export interface Transport {
  readonly name: TransportName;
  send(message: OutreachMessage): Promise<SendReceipt>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface OutreachConfig {
  resend_api_key: string | null;
  /** `OUTREACH_FROM`. Null is a blocker, never a placeholder. */
  from: string | null;
  reply_to: string | null;
  /** CAN-SPAM requires this in every commercial message. Null blocks the send. */
  postal_address: string | null;
  /** Working opt-out URL. Null blocks the send. */
  unsubscribe_url: string | null;
  outbox_dir: string;
  suppression_path: string;
  /** One line per degradation. Empty means everything needed is configured. */
  degraded: string[];
}

export const DEFAULT_OUTBOX_DIR = ".outbox";
export const DEFAULT_SUPPRESSION_PATH = "data/outreach-suppression.jsonl";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 15_000;

/**
 * Strings that look configured and are not. A placeholder postal address in a
 * real send is worse than no address: it satisfies a naive string check while
 * telling the recipient nothing about where we are.
 */
const PLACEHOLDER = /^(|-|n\/a|na|none|null|undefined|tbd|todo|xxx+|your address here|not configured|\[.*\])$/i;

function clean(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || PLACEHOLDER.test(trimmed)) return null;
  return trimmed;
}

export type EnvLike = Record<string, string | undefined>;

/**
 * Read the environment. Never throws, never invents a value, and reports every
 * missing piece rather than filling it in.
 */
export function resolveOutreachConfig(env: EnvLike = process.env): OutreachConfig {
  const degraded: string[] = [];
  const key = clean(env["RESEND_API_KEY"]);
  const from = clean(env["OUTREACH_FROM"]);
  const reply = clean(env["OUTREACH_REPLY_TO"]);
  const postal = clean(env["OUTREACH_POSTAL_ADDRESS"]);
  const unsub = clean(env["OUTREACH_UNSUBSCRIBE_URL"]);

  if (key === null) {
    degraded.push("RESEND_API_KEY absent — no network transport, falling back to the file transport");
  }
  if (from === null) {
    degraded.push(
      "OUTREACH_FROM absent — no identifiable sender, so no network send is possible and nothing is invented",
    );
  }
  if (reply === null) {
    degraded.push("OUTREACH_REPLY_TO absent — the opt-out reply would reach nobody, so compliance will block");
  }
  if (postal === null) {
    degraded.push("OUTREACH_POSTAL_ADDRESS absent — CAN-SPAM requires one, so compliance will block");
  }
  if (unsub === null) {
    degraded.push("OUTREACH_UNSUBSCRIBE_URL absent — no working opt-out link, so compliance will block");
  }

  return {
    resend_api_key: key,
    from,
    reply_to: reply,
    postal_address: postal,
    unsubscribe_url: unsub,
    outbox_dir: clean(env["OUTREACH_OUTBOX"]) ?? DEFAULT_OUTBOX_DIR,
    suppression_path: clean(env["OUTREACH_SUPPRESSION_PATH"]) ?? DEFAULT_SUPPRESSION_PATH,
    degraded,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Log-once. A batch of thirty prospects must not print thirty copies of
// "RESEND_API_KEY absent", or the one line that matters scrolls away.
// ─────────────────────────────────────────────────────────────────────────────

const announced = new Set<string>();

/** Test hook. Nothing in the product calls this. */
export function resetTransportNoticesForTests(): void {
  announced.clear();
}

function announceOnce(logger: (m: string) => void, message: string): void {
  if (announced.has(message)) return;
  announced.add(message);
  logger(`[adlayer:outreach] ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Header hygiene
// ─────────────────────────────────────────────────────────────────────────────

/** CR, LF, and NUL. A newline in a header value forges the headers after it. */
export const HEADER_UNSAFE = /[\r\n\0]/;

export function hasUnsafeHeaderValue(message: OutreachMessage): string | null {
  const fields: [string, string | null][] = [
    ["to", message.to],
    ["from", message.from],
    ["reply_to", message.reply_to],
    ["subject", message.subject],
    ...Object.entries(message.headers).map(
      ([k, v]) => [`headers.${k}`, v] as [string, string | null],
    ),
  ];
  for (const [name, value] of fields) {
    if (typeof value === "string" && HEADER_UNSAFE.test(value)) return name;
  }
  return null;
}

/** RFC 5322 wire form. Used by the file transport and by the tests. */
export function renderEml(message: OutreachMessage, now: Date, note: string | null): string {
  const headers: [string, string][] = [
    ["Date", now.toUTCString()],
    ["From", message.from],
    ["To", message.to],
  ];
  if (message.reply_to !== null) headers.push(["Reply-To", message.reply_to]);
  headers.push(["Subject", message.subject]);
  for (const [name, value] of Object.entries(message.headers)) headers.push([name, value]);
  headers.push(["MIME-Version", "1.0"]);
  headers.push(["Content-Type", 'text/plain; charset="utf-8"']);
  headers.push(["Content-Transfer-Encoding", "8bit"]);
  if (note !== null) headers.push(["X-AdLayer-Note", note]);

  const head = headers.map(([name, value]) => `${name}: ${value}`).join("\r\n");
  return `${head}\r\n\r\n${message.text.replace(/\r?\n/g, "\r\n")}\r\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The transports
// ─────────────────────────────────────────────────────────────────────────────

export interface TransportOptions {
  config?: OutreachConfig;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger?: (message: string) => void;
  /** Overrides `config.outbox_dir` for the file transport. */
  outboxDir?: string;
  /** Written into `X-AdLayer-Note` so a `.eml` on disk says what it is. */
  note?: string | null;
  timeoutMs?: number;
}

function receipt(
  transport: TransportName,
  now: Date,
  over: Partial<SendReceipt> & { ok: boolean; detail: string },
): SendReceipt {
  return {
    transport,
    ok: over.ok,
    transmitted: over.transmitted ?? false,
    provider_id: over.provider_id ?? null,
    path: over.path ?? null,
    detail: over.detail,
    attempted_at: now.toISOString(),
  };
}

/**
 * Resend. One POST. Never throws — a network failure is a receipt with
 * `ok: false`, because the caller has already written a decision log entry that
 * has to be completed truthfully either way.
 */
export function resendTransport(options: TransportOptions = {}): Transport {
  const config = options.config ?? resolveOutreachConfig();
  const clock = options.now ?? ((): Date => new Date());
  const timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;

  return {
    name: "resend",
    async send(message: OutreachMessage): Promise<SendReceipt> {
      const now = clock();
      const key = config.resend_api_key;
      if (key === null) {
        return receipt("resend", now, { ok: false, detail: "no RESEND_API_KEY — refusing to call the API" });
      }
      const unsafe = hasUnsafeHeaderValue(message);
      if (unsafe !== null) {
        return receipt("resend", now, {
          ok: false,
          detail: `refusing to send: ${unsafe} contains a line break, which would forge headers`,
        });
      }
      const doFetch = options.fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== "function") {
        return receipt("resend", now, { ok: false, detail: "no fetch available in this runtime" });
      }

      const payload: Record<string, unknown> = {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        headers: message.headers,
      };
      if (message.reply_to !== null) payload["reply_to"] = message.reply_to;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const body = await response.text();
        if (!response.ok) {
          return receipt("resend", now, {
            ok: false,
            detail: `Resend returned HTTP ${response.status}: ${body.slice(0, 300)}`,
          });
        }
        let id: string | null = null;
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed !== null && typeof parsed === "object") {
            const value = (parsed as Record<string, unknown>)["id"];
            if (typeof value === "string") id = value;
          }
        } catch {
          // A 2xx with an unparseable body still means Resend accepted it. We
          // just lose the id, and the receipt says so rather than inventing one.
        }
        return receipt("resend", now, {
          ok: true,
          transmitted: true,
          provider_id: id,
          detail: id === null ? "Resend accepted the message but returned no id" : `Resend accepted the message as ${id}`,
        });
      } catch (err) {
        return receipt("resend", now, {
          ok: false,
          detail: `Resend call failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Write an `.eml` to disk. The working default today, and honest about it:
 * `transmitted` stays false, so nothing downstream can report a file as a send.
 */
export function fileTransport(options: TransportOptions = {}): Transport {
  const config = options.config ?? resolveOutreachConfig();
  const clock = options.now ?? ((): Date => new Date());
  const dir = options.outboxDir ?? config.outbox_dir;

  return {
    name: "file",
    async send(message: OutreachMessage): Promise<SendReceipt> {
      const now = clock();
      const unsafe = hasUnsafeHeaderValue(message);
      if (unsafe !== null) {
        return receipt("file", now, {
          ok: false,
          detail: `refusing to write: ${unsafe} contains a line break, which would forge headers`,
        });
      }
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const stamp = now.toISOString().replace(/[:.]/g, "-");
        const base = `${stamp}-${slugAddress(message.to)}`;
        let path = join(dir, `${base}.eml`);
        let n = 2;
        while (existsSync(path)) {
          path = join(dir, `${base}-${n}.eml`);
          n++;
        }
        writeFileSync(path, renderEml(message, now, options.note ?? null), { encoding: "utf8" });
        return receipt("file", now, {
          ok: true,
          transmitted: false,
          path,
          detail: `wrote ${path} — a real message on disk, delivered to nobody`,
        });
      } catch (err) {
        return receipt("file", now, {
          ok: false,
          detail: `could not write to ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

/** Refuses everything and says why. The floor of the degradation ladder. */
export function nullTransport(reason: string, options: TransportOptions = {}): Transport {
  const clock = options.now ?? ((): Date => new Date());
  return {
    name: "null",
    async send(): Promise<SendReceipt> {
      return receipt("null", clock(), { ok: false, detail: reason });
    },
  };
}

/**
 * Pick a transport.
 *
 * Resend needs BOTH a key and an identifiable sender. A key with no
 * `OUTREACH_FROM` is not "nearly configured" — it is a message with no valid
 * header information, which is CAN-SPAM violation number one, so it degrades
 * rather than guessing an address.
 */
export function resolveTransport(options: TransportOptions = {}): Transport {
  const config = options.config ?? resolveOutreachConfig();
  const logger = options.logger ?? ((m: string): void => console.log(m));

  if (config.resend_api_key !== null && config.from !== null) {
    return resendTransport({ ...options, config });
  }
  for (const line of config.degraded) {
    if (line.startsWith("RESEND_API_KEY") || line.startsWith("OUTREACH_FROM")) {
      announceOnce(logger, line);
    }
  }
  announceOnce(
    logger,
    "using the file transport — messages are written to disk as .eml and reach nobody. " +
      "Set RESEND_API_KEY and OUTREACH_FROM to send for real.",
  );
  return fileTransport({ ...options, config });
}

function slugAddress(address: string): string {
  const cleaned = address.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "recipient" : cleaned.slice(0, 60);
}
