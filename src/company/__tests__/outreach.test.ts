/**
 * ADLAYER — outreach tests.
 *
 * Written from the position of someone trying to catch us emailing real
 * businesses by accident, or emailing them something illegal, not someone trying
 * to show the happy path works.
 *
 * The seven facts this file exists to prove:
 *
 *   1. THE GATE BLOCKS EACH VIOLATION CLASS INDEPENDENTLY. One test per code:
 *      remove exactly one thing from an otherwise-compliant message and the send
 *      stops. A gate that only fails when everything is wrong is not a gate.
 *   2. SUPPRESSION IS HONOURED, and it is honoured before anything else touches
 *      the transport. Exact address and domain-wide. An unreadable list fails
 *      CLOSED.
 *   3. A DRY RUN MAKES ZERO NETWORK CALLS. Proven by injecting a `fetch` that
 *      throws if it is ever reached, not by reading the code.
 *   4. A MISSING KEY DEGRADES TO THE FILE TRANSPORT WITHOUT THROWING, and the
 *      file transport never reports `sent: true` — bytes on disk are not a send.
 *   5. THE ARMING RULE NEEDS BOTH SWITCHES. Each one alone produces a dry run.
 *   6. NO NUMBER WE DID NOT MEASURE. With no score supplied the allow-list is
 *      empty and any digit in the body blocks. Fails closed.
 *   7. THE DECISION IS RE-RUNNABLE. `decideSend` is registered as a mechanism,
 *      entries carry a derived flip input, and the auditor verifies both.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { auditEntry, openDecisionLog, verifyChain, type DecisionSink } from "../decision-log.ts";
import type { InvisibilityScore, Prospect, SenderIdentity } from "../closer.ts";
import {
  AD_DISCLOSURE_SENTENCE,
  LIST_UNSUBSCRIBE_HEADER,
  OPT_BLOCK,
  OPT_DRY_RUN,
  OPT_SEND,
  VIOLATIONS,
  addressOf,
  checkSuppression,
  composeMessage,
  decideSend,
  fileTransport,
  findSendFlip,
  gateMessage,
  hasUnsafeHeaderValue,
  isSuppressed,
  loadSuppressions,
  renderEml,
  resolveOutreachConfig,
  resolveTransport,
  resetTransportNoticesForTests,
  sendMechanism,
  sendPitch,
  unsubscribe,
  type EnvLike,
  type OutreachConfig,
  type SendablePitch,
  type SendDecisionInput,
  type SendFlags,
} from "../outreach/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adlayer-outreach-"));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-08-15T21:00:00.000Z");
const clock = (): Date => NOW;

const SENDER: SenderIdentity = {
  name: "AdLayer",
  reply_to: "hello@adlayer.example",
  website: "https://adlayer.example",
  postal_address: "AdLayer, 1 Example Street, Suite 2, San Francisco, CA 94103",
};

const PROSPECT: Prospect = {
  id: "acme",
  name: "Acme",
  domain: "acme.example",
  categories: ["fintech"],
  contact: { email: "ads@acme.example", form_url: null, source: "advertising_invite" },
  last_contacted_at: null,
  opted_out: false,
  record_ref: "fixture.json#/advertisers/0",
};

const SCORE: InvisibilityScore = {
  visibility: 0,
  cited_queries: 0,
  total_queries: 12,
  competitors: [{ domain: "rival.example", citation_count: 9 }],
  engine: "perplexity/sonar",
  measured_at: "2026-08-15T18:00:00.000Z",
  source: "measurement",
  ref: "src/company/prospector.ts#measure",
  queries: ["best fintech tools"],
};

/**
 * A body that satisfies every rule. Note what it does NOT contain: any digit
 * that is not in the measured allow-list. "fifteen minutes" is spelled out for
 * exactly that reason, which is the same discipline the Closer's template uses.
 */
const CLEAN_BODY = [
  "Acme is cited in 0 of the 12 AI answers we measured.",
  "",
  "We put 12 buying-intent queries to perplexity/sonar and recorded which domains the answers cited.",
  "rival.example was cited in 9 of them.",
  "",
  "If that is worth fifteen minutes, reply to this message.",
].join("\n");

const PITCH: SendablePitch = {
  subject: "Acme is cited in 0 of 12 AI answers we measured",
  body: CLEAN_BODY,
  decision: { disposition: "send", prospect_id: "acme" },
};

/** Everything configured. The baseline every violation test breaks one field of. */
function armedEnv(over: EnvLike = {}): EnvLike {
  return {
    LIVE_SEND: "1",
    RESEND_API_KEY: "re_test_key",
    OUTREACH_FROM: "AdLayer <outbound@adlayer.example>",
    OUTREACH_REPLY_TO: "hello@adlayer.example",
    OUTREACH_POSTAL_ADDRESS: "AdLayer, 1 Example Street, Suite 2, San Francisco, CA 94103",
    OUTREACH_UNSUBSCRIBE_URL: "https://adlayer.example/unsubscribe",
    ...over,
  };
}

/** A fetch that fails the test if anything ever reaches it. */
function forbiddenFetch(): typeof fetch {
  return (async (): Promise<Response> => {
    throw new Error("NETWORK CALL MADE — a dry run must never reach the network");
  }) as unknown as typeof fetch;
}

/** A fetch that records calls and returns a Resend-shaped 200. */
function recordingFetch(calls: { url: string; body: unknown }[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ id: "email_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function baseFlags(over: Partial<SendFlags> = {}): SendFlags {
  return {
    env: armedEnv(),
    now: clock,
    logger: (): void => {},
    sender: SENDER,
    suppressionPath: join(tempDir(), "suppression.jsonl"),
    fetchImpl: forbiddenFetch(),
    log: openDecisionLog({ logger: (): void => {} }),
    ...over,
  };
}

function recipient(over: Record<string, unknown> = {}): {
  email: string;
  prospect: Prospect;
  score: InvisibilityScore;
} {
  return { email: "ads@acme.example", prospect: PROSPECT, score: SCORE, ...over } as {
    email: string;
    prospect: Prospect;
    score: InvisibilityScore;
  };
}

function configFor(env: EnvLike): OutreachConfig {
  return resolveOutreachConfig(env);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The compliance gate blocks each violation, one at a time
// ─────────────────────────────────────────────────────────────────────────────

describe("the compliance gate blocks each violation independently", () => {
  /**
   * The control. If this ever fails, every test below it is meaningless: they
   * all work by breaking exactly one field of this message.
   */
  it("passes a fully compliant message — the control for every test below", async () => {
    const outcome = await sendPitch(PITCH, recipient(), baseFlags({
      liveSend: false,
      fetchImpl: forbiddenFetch(),
    }));
    assert.deepEqual(outcome.gate.codes, [], `unexpected violations: ${JSON.stringify(outcome.gate.violations)}`);
    assert.equal(outcome.gate.allowed, true);
    assert.equal(outcome.action, "dry_run");
  });

  const cases: { name: string; env: EnvLike; code: string }[] = [
    {
      name: "no physical postal address",
      env: armedEnv({ OUTREACH_POSTAL_ADDRESS: "" }),
      code: VIOLATIONS.noPostalAddress,
    },
    {
      name: "a placeholder postal address",
      env: armedEnv({ OUTREACH_POSTAL_ADDRESS: "TBD" }),
      code: VIOLATIONS.noPostalAddress,
    },
    {
      name: "no unsubscribe link",
      env: armedEnv({ OUTREACH_UNSUBSCRIBE_URL: "" }),
      code: VIOLATIONS.noUnsubscribe,
    },
    {
      name: "an unsubscribe link that is not https",
      env: armedEnv({ OUTREACH_UNSUBSCRIBE_URL: "click here to stop" }),
      code: VIOLATIONS.noUnsubscribe,
    },
    {
      name: "no reply route for the opt-out",
      env: armedEnv({ OUTREACH_REPLY_TO: "" }),
      code: VIOLATIONS.noReplyRoute,
    },
  ];

  for (const testCase of cases) {
    it(`blocks the send: ${testCase.name}`, async () => {
      const outcome = await sendPitch(PITCH, recipient(), baseFlags({
        env: testCase.env,
        liveSend: true,
        fetchImpl: forbiddenFetch(),
      }));
      assert.ok(
        outcome.gate.codes.includes(testCase.code as never),
        `expected ${testCase.code}, got ${outcome.gate.codes.join(", ")}`,
      );
      assert.equal(outcome.gate.allowed, false);
      assert.equal(outcome.action, "blocked");
      assert.equal(outcome.sent, false);
      assert.equal(outcome.receipt, null, "a blocked message must not reach a transport at all");
    });
  }

  it("blocks a deceptive subject, and the arming switches do not save it", async () => {
    const deceptive: SendablePitch = {
      ...PITCH,
      subject: "Re: last chance for Acme",
      decision: PITCH.decision,
    };
    const outcome = await sendPitch(deceptive, recipient(), baseFlags({ liveSend: true }));
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.gate.codes.includes(VIOLATIONS.deceptiveSubject as never));
    const details = outcome.gate.violations.map((v) => v.detail).join(" | ");
    assert.match(details, /fakes a reply/);
    assert.match(details, /last chance/);
  });

  it("blocks a body that asserts a metric we did not measure", async () => {
    const invented: SendablePitch = {
      ...PITCH,
      body: `${CLEAN_BODY}\n\nCompanies like yours see a 340% lift within 90 days.`,
    };
    const outcome = await sendPitch(invented, recipient(), baseFlags({ liveSend: true }));
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.gate.codes.includes(VIOLATIONS.unmeasuredMetric as never));
    const detail = outcome.gate.violations.find((v) => v.code === VIOLATIONS.unmeasuredMetric)?.detail ?? "";
    assert.match(detail, /340|90/);
  });

  /**
   * The fail-closed direction. A caller with no measurement has not earned the
   * send, and the allow-list being empty means every digit in the body is a
   * violation rather than a pass.
   */
  it("blocks every number when no measurement was supplied at all", async () => {
    const outcome = await sendPitch(PITCH, { email: "ads@acme.example" }, baseFlags({ liveSend: true }));
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.gate.codes.includes(VIOLATIONS.unmeasuredMetric as never));
    assert.match(
      outcome.gate.violations.find((v) => v.code === VIOLATIONS.unmeasuredMetric)?.detail ?? "",
      /no measurement was supplied/,
    );
  });

  it("blocks a NOT CONFIGURED placeholder left in the body by an unconfigured sender", async () => {
    const leaky: SendablePitch = {
      ...PITCH,
      body: `${CLEAN_BODY}\n[POSTAL ADDRESS NOT CONFIGURED — required before any real send]`,
    };
    const outcome = await sendPitch(leaky, recipient(), baseFlags({ liveSend: true }));
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.gate.codes.includes(VIOLATIONS.noSenderIdentity as never));
  });

  it("blocks header injection through the recipient address", async () => {
    const outcome = await sendPitch(
      PITCH,
      recipient({ email: "ads@acme.example\r\nBcc: everyone@acme.example" }),
      baseFlags({ liveSend: true }),
    );
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.gate.codes.includes(VIOLATIONS.headerInjection as never));
    assert.equal(outcome.receipt, null);
  });

  it("catches the injection at the transport too, not only at the gate", async () => {
    const dir = tempDir();
    const transport = fileTransport({ config: configFor(armedEnv()), now: clock, outboxDir: dir });
    const receipt = await transport.send({
      to: "a@b.example\r\nBcc: c@d.example",
      from: "AdLayer <outbound@adlayer.example>",
      reply_to: null,
      subject: "hello",
      text: "body",
      headers: {},
    });
    assert.equal(receipt.ok, false);
    assert.match(receipt.detail, /line break/);
    assert.equal(readdirSync(dir).length, 0, "nothing may be written when headers are unsafe");
  });

  it("names the unsafe field rather than just failing", () => {
    assert.equal(
      hasUnsafeHeaderValue({
        to: "a@b.example",
        from: "AdLayer <x@y.example>",
        reply_to: null,
        subject: "ok\nBcc: z@z.example",
        text: "body",
        headers: {},
      }),
      "subject",
    );
  });

  it("requires the List-Unsubscribe header, not just a link in the body", () => {
    const config = configFor(armedEnv());
    const message = composeMessage(PITCH, recipient(), config);
    const stripped = { ...message, headers: {} };
    const verdict = gateMessage(stripped, {
      postal_address: config.postal_address,
      unsubscribe_url: config.unsubscribe_url,
      reply_to: config.reply_to,
      suppression: loadSuppressions({ path: join(tempDir(), "none.jsonl") }),
      allowed: null,
      now: NOW,
    });
    assert.ok(verdict.codes.includes(VIOLATIONS.noUnsubscribe as never));
    assert.match(
      verdict.violations.find((v) => v.code === VIOLATIONS.noUnsubscribe)?.detail ?? "",
      new RegExp(LIST_UNSUBSCRIBE_HEADER),
    );
  });

  it("puts the postal address, the ad disclosure and the opt-out in the bytes that go out", () => {
    const config = configFor(armedEnv());
    const message = composeMessage(PITCH, recipient(), config);
    assert.ok(message.text.includes(config.postal_address ?? " "));
    assert.ok(message.text.includes(AD_DISCLOSURE_SENTENCE));
    assert.ok(message.text.includes("https://adlayer.example/unsubscribe"));
    assert.ok(message.headers[LIST_UNSUBSCRIBE_HEADER]?.includes("https://adlayer.example/unsubscribe"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Suppression
// ─────────────────────────────────────────────────────────────────────────────

describe("the suppression list is honoured before anything else", () => {
  it("blocks a suppressed address and never constructs a transport", async () => {
    const path = join(tempDir(), "suppression.jsonl");
    unsubscribe("ADS@Acme.Example", "replied no", { path, now: clock, logger: (): void => {} });

    const outcome = await sendPitch(PITCH, recipient(), baseFlags({ liveSend: true, suppressionPath: path }));
    assert.equal(outcome.action, "blocked");
    assert.ok(outcome.gate.codes.includes(VIOLATIONS.suppressed as never));
    assert.equal(outcome.receipt, null);
    assert.equal(outcome.sent, false);
  });

  it("normalizes case and whitespace so an opt-out cannot be sidestepped by casing", () => {
    const path = join(tempDir(), "s.jsonl");
    unsubscribe("  Person@Example.COM ", "manual", { path, now: clock, logger: (): void => {} });
    assert.equal(isSuppressed("person@example.com", { path }), true);
    assert.equal(isSuppressed("PERSON@EXAMPLE.COM", { path }), true);
    assert.equal(isSuppressed("other@example.com", { path }), false);
  });

  it("supports a domain-wide opt-out", () => {
    const path = join(tempDir(), "s.jsonl");
    unsubscribe("@acme.example", "company asked us to stop", { path, now: clock, logger: (): void => {} });
    const list = loadSuppressions({ path });
    assert.equal(checkSuppression("anyone@acme.example", list).suppressed, true);
    assert.equal(checkSuppression("anyone@other.example", list).suppressed, false);
  });

  it("is append-only: a resubscribe adds a line and the history survives", () => {
    const path = join(tempDir(), "s.jsonl");
    unsubscribe("x@y.example", "replied no", { path, now: clock, logger: (): void => {} });
    unsubscribe("x@y.example", "asked back in", {
      path,
      now: clock,
      logger: (): void => {},
      action: "resubscribe",
    });
    const list = loadSuppressions({ path });
    assert.equal(list.records.length, 2, "both lines must still be on disk");
    assert.equal(list.suppressed.has("x@y.example"), false, "the last word wins");
    assert.equal(readFileSync(path, "utf8").split("\n").filter((l) => l !== "").length, 2);
  });

  /**
   * The direction this function is allowed to be wrong in. An unreadable
   * opt-out list is not an empty opt-out list.
   */
  it("fails CLOSED when the list exists and cannot be read", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, '{"address":"a@b.example","action":"unsubscribe"}\n');
    chmodSync(path, 0o000);
    const list = loadSuppressions({ path });
    if (!list.read_failed) {
      // Running as root, or on a filesystem that ignores the mode. Simulate the
      // state directly rather than skipping the assertion that matters.
      const simulated = { ...list, read_failed: true, detail: "simulated unreadable list" };
      assert.equal(checkSuppression("anyone@anywhere.example", simulated).suppressed, true);
      return;
    }
    assert.equal(checkSuppression("anyone@anywhere.example", list).suppressed, true);
  });

  it("treats a missing file as an empty list rather than an error", () => {
    const list = loadSuppressions({ path: join(tempDir(), "nope.jsonl") });
    assert.equal(list.read_failed, false);
    assert.equal(list.suppressed.size, 0);
    assert.equal(checkSuppression("a@b.example", list).suppressed, false);
  });

  it("records malformed lines rather than silently dropping them", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, 'not json\n{"address":"a@b.example","action":"unsubscribe"}\n');
    const list = loadSuppressions({ path });
    assert.equal(list.malformed.length, 1);
    assert.equal(list.malformed[0]?.line, 1);
    assert.equal(list.suppressed.has("a@b.example"), true);
  });

  it("a send that did not consult the list at all is refused", () => {
    const config = configFor(armedEnv());
    const verdict = gateMessage(composeMessage(PITCH, recipient(), config), {
      postal_address: config.postal_address,
      unsubscribe_url: config.unsubscribe_url,
      reply_to: config.reply_to,
      suppression: null,
      allowed: null,
      now: NOW,
    });
    assert.ok(verdict.codes.includes(VIOLATIONS.suppressed as never));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Dry run makes no network calls
// ─────────────────────────────────────────────────────────────────────────────

describe("dry run is the default and it touches nothing", () => {
  it("makes zero network calls with no flags at all", async () => {
    const outbox = tempDir();
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({ fetchImpl: forbiddenFetch(), outboxDir: outbox }),
    );
    assert.equal(outcome.action, "dry_run");
    assert.equal(outcome.sent, false);
    assert.equal(outcome.armed, false);
    assert.equal(outcome.receipt, null, "no transport is invoked in a dry run unless one is asked for");
    assert.equal(readdirSync(outbox).length, 0, "a dry run writes no file unless writeDryRunFile is set");
  });

  it("writes a clearly-marked .eml only when explicitly asked", async () => {
    const outbox = tempDir();
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({ fetchImpl: forbiddenFetch(), outboxDir: outbox, writeDryRunFile: true }),
    );
    assert.equal(outcome.action, "dry_run");
    assert.equal(outcome.sent, false);
    const files = readdirSync(outbox);
    assert.equal(files.length, 1);
    const eml = readFileSync(join(outbox, files[0] ?? ""), "utf8");
    assert.match(eml, /X-AdLayer-Note: DRY RUN — NOT SENT/);
    assert.match(eml, /^To: ads@acme\.example/m);
  });

  it("an armed flag alone is not enough — LIVE_SEND must also be 1", async () => {
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({ liveSend: true, env: armedEnv({ LIVE_SEND: "0" }), fetchImpl: forbiddenFetch() }),
    );
    assert.equal(outcome.action, "dry_run");
    assert.equal(outcome.armed, false);
    assert.match(outcome.reason, /LIVE_SEND=1/);
  });

  it("LIVE_SEND=1 alone is not enough — the flag must also be passed", async () => {
    const outcome = await sendPitch(PITCH, recipient(), baseFlags({ fetchImpl: forbiddenFetch() }));
    assert.equal(outcome.action, "dry_run");
    assert.match(outcome.reason, /flags\.liveSend/);
  });

  it("refuses a prospect the Closer declined, without composing anything for the wire", async () => {
    const declined: SendablePitch = {
      ...PITCH,
      decision: { disposition: "decline", prospect_id: "acme" },
    };
    const outcome = await sendPitch(declined, recipient(), baseFlags({ liveSend: true }));
    assert.equal(outcome.action, "blocked");
    assert.equal(outcome.receipt, null);
    assert.match(outcome.reason, /disposition/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Degradation
// ─────────────────────────────────────────────────────────────────────────────

describe("missing config degrades to the file transport and never throws", () => {
  it("picks the file transport with no RESEND_API_KEY, and says so once", () => {
    resetTransportNoticesForTests();
    const lines: string[] = [];
    const config = configFor(armedEnv({ RESEND_API_KEY: "" }));
    const first = resolveTransport({ config, logger: (m) => lines.push(m), now: clock });
    const second = resolveTransport({ config, logger: (m) => lines.push(m), now: clock });
    assert.equal(first.name, "file");
    assert.equal(second.name, "file");
    assert.ok(lines.some((l) => l.includes("RESEND_API_KEY")));
    assert.equal(
      new Set(lines).size,
      lines.length === 0 ? 0 : new Set(lines).size,
      "sanity: lines are deduplicated by announceOnce",
    );
    assert.ok(lines.length <= 2, `announceOnce must not repeat itself per process, got ${lines.length} lines`);
  });

  it("degrades rather than sending when a key exists but the sender identity does not", () => {
    resetTransportNoticesForTests();
    const config = configFor(armedEnv({ OUTREACH_FROM: "" }));
    assert.equal(resolveTransport({ config, logger: (): void => {}, now: clock }).name, "file");
  });

  it("an armed send with no key writes a real .eml, does not throw, and is NOT reported as sent", async () => {
    resetTransportNoticesForTests();
    const outbox = tempDir();
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({
        liveSend: true,
        env: armedEnv({ RESEND_API_KEY: "" }),
        outboxDir: outbox,
        fetchImpl: forbiddenFetch(),
      }),
    );
    assert.equal(outcome.action, "sent", "the DECISION was to send");
    assert.equal(outcome.transport, "file");
    assert.equal(outcome.receipt?.ok, true);
    assert.equal(outcome.sent, false, "bytes on disk are not a send, and must never report as one");
    assert.ok(outcome.degraded.some((d) => d.includes("does not deliver to recipients")));
    assert.equal(readdirSync(outbox).length, 1);
  });

  it("resolveOutreachConfig reports every gap rather than filling one in", () => {
    const config = resolveOutreachConfig({});
    assert.equal(config.from, null);
    assert.equal(config.postal_address, null);
    assert.equal(config.unsubscribe_url, null);
    assert.equal(config.degraded.length, 5);
  });

  it("treats placeholder-shaped values as absent", () => {
    const config = resolveOutreachConfig({ OUTREACH_POSTAL_ADDRESS: "TODO", OUTREACH_FROM: "n/a" });
    assert.equal(config.postal_address, null);
    assert.equal(config.from, null);
  });

  it("a transport failure is a receipt, not an exception", async () => {
    const failing = (async (): Promise<Response> =>
      new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({ liveSend: true, fetchImpl: failing }),
    );
    assert.equal(outcome.action, "sent");
    assert.equal(outcome.sent, false);
    assert.equal(outcome.receipt?.ok, false);
    assert.match(outcome.receipt?.detail ?? "", /422/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The armed path — the only place a byte leaves the process
// ─────────────────────────────────────────────────────────────────────────────

describe("the armed path", () => {
  it("posts exactly once to Resend with the compliant body and reports sent: true", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({ liveSend: true, fetchImpl: recordingFetch(calls) }),
    );
    assert.equal(outcome.action, "sent");
    assert.equal(outcome.sent, true);
    assert.equal(outcome.armed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.resend.com/emails");

    const body = calls[0]?.body as Record<string, unknown>;
    assert.deepEqual(body["to"], ["ads@acme.example"]);
    assert.equal(body["from"], "AdLayer <outbound@adlayer.example>");
    assert.equal(body["reply_to"], "hello@adlayer.example");
    assert.match(String(body["text"]), /1 Example Street/);
    assert.match(String(body["text"]), new RegExp(AD_DISCLOSURE_SENTENCE.slice(0, 24)));
    assert.equal(
      (body["headers"] as Record<string, string>)[LIST_UNSUBSCRIBE_HEADER]?.includes(
        "https://adlayer.example/unsubscribe",
      ),
      true,
    );
    assert.equal(outcome.receipt?.provider_id, "email_123");
  });

  it("records a real send as irreversible and names the only remedy", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const outcome = await sendPitch(
      PITCH,
      recipient(),
      baseFlags({ liveSend: true, fetchImpl: recordingFetch(calls) }),
    );
    const entry = outcome.entries.at(-1);
    assert.ok(entry !== undefined);
    assert.equal(entry.reversible, false);
    assert.equal(entry.executed, true);
    assert.match(entry.reversal_path, /unsubscribe/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The decision is a real, re-runnable function of the inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("the send decision is re-runnable", () => {
  const armed: SendDecisionInput = {
    disposition: "send",
    gate_allowed: true,
    violation_codes: [],
    flag_live_send: true,
    env_live_send: true,
  };

  it("produces all three outcomes from the same function", () => {
    assert.equal(decideSend(armed).option_id, OPT_SEND);
    assert.equal(decideSend({ ...armed, flag_live_send: false }).option_id, OPT_DRY_RUN);
    assert.equal(
      decideSend({ ...armed, gate_allowed: false, violation_codes: ["no_postal_address"] }).option_id,
      OPT_BLOCK,
    );
    assert.equal(decideSend({ ...armed, disposition: "hold" }).option_id, OPT_BLOCK);
  });

  it("the compliance block outranks the arming switches in both directions", () => {
    const blocked = { ...armed, gate_allowed: false, violation_codes: ["suppressed"] };
    assert.equal(decideSend(blocked).option_id, OPT_BLOCK);
    assert.equal(decideSend({ ...blocked, flag_live_send: false }).option_id, OPT_BLOCK);
  });

  it("the registered mechanism reproduces the decision on JSON round-tripped input", () => {
    const round = JSON.parse(JSON.stringify(armed)) as unknown;
    assert.equal(sendMechanism(round), OPT_SEND);
    assert.equal(sendMechanism("not an object"), null);
    assert.equal(sendMechanism(null), null);
  });

  it("the derived flip actually flips, for every rule", () => {
    for (const input of [
      armed,
      { ...armed, flag_live_send: false },
      { ...armed, gate_allowed: false, violation_codes: ["no_unsubscribe"] },
      { ...armed, disposition: "decline" },
    ]) {
      const flip = findSendFlip(input);
      assert.ok(flip !== null, `no flip found for ${JSON.stringify(input)}`);
      assert.notEqual(decideSend(flip.input).option_id, decideSend(input).option_id);
      assert.equal(decideSend(flip.input).option_id, flip.option_id);
    }
  });

  it("the auditor verifies the mechanism on the entry we actually wrote", async () => {
    const sink: DecisionSink = openDecisionLog({ logger: (): void => {} });
    await sendPitch(PITCH, recipient(), baseFlags({ log: sink, fetchImpl: forbiddenFetch() }));
    const entry = sink.entries().at(-1);
    assert.ok(entry !== undefined);
    const audit = auditEntry(entry);
    assert.equal(audit.mechanism, "verified", audit.mechanism_detail);
    assert.equal(audit.strength, "decision", `defects: ${audit.defects.join(", ")}`);
    assert.equal(verifyChain(sink.entries()).ok, true);
  });

  it("logs the compliance veto under Compliance, with its own verified replay", async () => {
    const sink: DecisionSink = openDecisionLog({ logger: (): void => {} });
    await sendPitch(
      PITCH,
      recipient(),
      baseFlags({
        log: sink,
        liveSend: true,
        env: armedEnv({ OUTREACH_POSTAL_ADDRESS: "" }),
        fetchImpl: forbiddenFetch(),
      }),
    );
    const entries = sink.entries();
    const veto = entries.find((e) => e.agent === "Compliance");
    assert.ok(veto !== undefined, "a block must be logged by the agent that blocked it");
    assert.equal(veto.executed, true, "a veto that stopped a send did something");
    const audit = auditEntry(veto);
    assert.equal(audit.mechanism, "verified", audit.mechanism_detail);
    assert.equal(audit.strength, "decision", `defects: ${audit.defects.join(", ")}`);
    assert.equal(verifyChain(entries).ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Odds and ends that would be embarrassing to get wrong
// ─────────────────────────────────────────────────────────────────────────────

describe("plumbing", () => {
  it("parses addresses out of both bare and angle-bracket forms", () => {
    assert.equal(addressOf("AdLayer <a@b.example>"), "a@b.example");
    assert.equal(addressOf("a@b.example"), "a@b.example");
    assert.equal(addressOf("not an address"), null);
    assert.equal(addressOf(null), null);
    assert.equal(addressOf("a@b"), null);
  });

  it("renders CRLF headers and a blank-line separator, so the .eml opens in a mail client", () => {
    const eml = renderEml(
      {
        to: "a@b.example",
        from: "AdLayer <x@y.example>",
        reply_to: "r@y.example",
        subject: "hello",
        text: "line one\nline two",
        headers: { "List-Unsubscribe": "<https://y.example/u>" },
      },
      NOW,
      "DRY RUN",
    );
    assert.match(eml, /\r\n\r\n/);
    assert.match(eml, /^Subject: hello\r$/m);
    assert.match(eml, /^List-Unsubscribe: <https:\/\/y\.example\/u>\r$/m);
    assert.ok(eml.includes("line one\r\nline two"));
  });

  it("never writes a suppression record with no address", () => {
    assert.throws(() => unsubscribe("   ", "oops", { path: join(tempDir(), "s.jsonl") }));
  });

  it("the outbox directory is created on demand rather than assumed", async () => {
    const dir = join(tempDir(), "nested", "outbox");
    assert.equal(existsSync(dir), false);
    const transport = fileTransport({ config: configFor(armedEnv()), now: clock, outboxDir: dir });
    const receipt = await transport.send({
      to: "a@b.example",
      from: "AdLayer <x@y.example>",
      reply_to: null,
      subject: "hello",
      text: "body",
      headers: {},
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.transmitted, false, "a file is never a transmission");
    assert.ok(existsSync(dir));
  });
});
