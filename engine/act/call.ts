import type {
  BacklinkCallAction,
  BacklinkOutcome,
  OutreachTarget,
  VoygrCallResult,
  TranscriptTurn,
} from "../contract";
import { voygr } from "./adapters/voygr";

export function mapOutcome(result: VoygrCallResult): BacklinkOutcome {
  const s = (result.status ?? "").toLowerCase();
  const ot = (result.outcome_type ?? "").toLowerCase();
  const sum = (result.outcome_summary ?? "").toLowerCase();

  if (!["completed", "failed", "no_answer", "voicemail", "declined", "error"].includes(s)) {
    return "pending";
  }

  if (
    ot.includes("no_answer") ||
    ot.includes("noanswer") ||
    sum.includes("no answer") ||
    ot.includes("voicemail") ||
    sum.includes("voicemail") ||
    sum.includes("busy")
  ) {
    return "no_answer";
  }

  if (
    sum.includes("added") ||
    sum.includes("listed") ||
    sum.includes("will add") ||
    sum.includes("added you to")
  ) {
    return "listed";
  }

  if (
    sum.includes("form") ||
    sum.includes("submit") ||
    sum.includes("application") ||
    sum.includes("online portal") ||
    sum.includes("email us")
  ) {
    return "needs_form";
  }

  if (
    ot.includes("declined") ||
    ot.includes("refused") ||
    sum.includes("declined") ||
    sum.includes("refused") ||
    sum.includes("not interested") ||
    sum.includes("no thank")
  ) {
    return "declined";
  }

  if (
    sum.includes("call back") ||
    sum.includes("follow up") ||
    sum.includes("send an email") ||
    sum.includes("check with") ||
    sum.includes("pass it on")
  ) {
    return "will_follow_up";
  }

  if (s === "completed") {
    return "will_follow_up";
  }

  return "pending";
}

export function absolutizeRecording(url: string | null): string | null {
  if (url === null) return null;
  if (url.startsWith("http")) return url;
  return `https://api.voygr.tech${url}`;
}

export function toPendingAction(
  target: OutreachTarget,
  brief: string,
): BacklinkCallAction {
  return {
    type: "backlink_call",
    target,
    brief,
    call_id: null,
    status: "pending_approval",
    outcome_type: null,
    outcome: null,
    outcome_summary: null,
    transcript: null,
    recording_url: null,
    backlink_url: null,
  };
}

export async function runCalls(
  actions: BacklinkCallAction[],
  opts: {
    live?: boolean;
    maxCalls?: number;
    concurrency?: number;
    timeoutMs?: number;
  } = {},
): Promise<BacklinkCallAction[]> {
  const maxCalls = opts.maxCalls ?? 3;
  const concurrency = opts.concurrency ?? 2;
  const timeoutMs = opts.timeoutMs ?? 300000;

  if (opts.live !== true) {
    for (const a of actions) {
      if (a.status !== "pending_approval") continue;
      if (!a.target.phone) continue;
      console.error(
        `[DRY RUN] would dial ${a.target.phone} (${a.target.name}): ${a.brief.slice(0, 80)}...`,
      );
    }
    return actions.map((a) => ({ ...a }));
  }

  const results = actions.map((a) => ({ ...a }));

  const queue = results.filter(
    (a) => a.status === "pending_approval" && typeof a.target.phone === "string" && a.target.phone.length > 0,
  );

  if (queue.length === 0) return results;

  let callLimit = Math.min(queue.length, maxCalls);

  try {
    const usage = await voygr.getUsage();
    if (usage.remaining < callLimit) {
      console.error(
        `[quota] only ${usage.remaining} calls remaining, truncating from ${callLimit} to ${usage.remaining}`,
      );
      callLimit = Math.min(callLimit, usage.remaining);
    }
    if (callLimit <= 0) {
      console.error("[quota] no calls remaining, aborting live run");
      return results;
    }
  } catch (err) {
    console.error("[quota] getUsage failed, aborting live run:", String(err));
    return results;
  }

  const toCall = queue.slice(0, callLimit);

  async function executeOne(action: BacklinkCallAction): Promise<void> {
    const phone = action.target.phone!;
    try {
      console.error(`[dial] placing call to ${phone} (${action.target.name})`);
      const placed = await voygr.placeCall(phone, action.brief);
      action.call_id = placed.call_id;
      action.status = "in_progress";

      console.error(`[await] waiting for call ${placed.call_id}...`);
      const result = await voygr.awaitCall(placed.call_id, { timeoutMs, pollMs: 6000 });

      action.status = "completed";
      action.outcome_type = result.outcome_type;
      action.outcome = mapOutcome(result);
      action.outcome_summary = result.outcome_summary;
      action.transcript = result.transcript_full;
      action.recording_url = absolutizeRecording(result.recording_url);

      console.error(
        `[done] call ${placed.call_id} → ${action.outcome} (${action.outcome_type ?? "?"}): ${(action.outcome_summary ?? "").slice(0, 80)}`,
      );
    } catch (err) {
      console.error(`[fail] call to ${phone} failed:`, String(err));
      action.status = "failed";
      action.outcome = "pending";
    }
  }

  const workerQueue = [...toCall];
  async function worker(): Promise<void> {
    let next: BacklinkCallAction | undefined;
    while ((next = workerQueue.shift())) {
      await executeOne(next);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, toCall.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
