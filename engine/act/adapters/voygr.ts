import type { VoygrAdapter, VoygrCallResult, TranscriptTurn } from "../../contract";

const BASE = "https://api.voygr.tech";

function key(): string {
  const k = process.env.VOYGR_API_KEY;
  if (!k) throw new Error("VOYGR_API_KEY is not set");
  return k;
}

function headers(): Record<string, string> {
  return { "X-API-Key": key(), "Content-Type": "application/json" };
}

function normalizeTranscript(raw: unknown): TranscriptTurn[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t): t is { role: string; text: string } => !!t && typeof t === "object" && "role" in t && "text" in t)
    .map((t) => ({ role: t.role === "operator" ? "operator" : "bot", text: String(t.text) }));
}

export const voygr: VoygrAdapter = {
  async placeCall(target_phone, brief, language = "en") {
    const res = await fetch(`${BASE}/calls`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ target_phone, brief, language }),
    });
    if (!res.ok) throw new Error(`Voygr placeCall ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { call_id: string; status: string };
    return { call_id: j.call_id, status: j.status };
  },

  async getCall(call_id) {
    const res = await fetch(`${BASE}/calls/${call_id}`, { headers: headers() });
    if (!res.ok) throw new Error(`Voygr getCall ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as Record<string, unknown>;
    const result: VoygrCallResult = {
      call_id: String(j.call_id ?? call_id),
      status: String(j.status ?? "unknown"),
      outcome_type: (j.outcome_type as string) ?? null,
      outcome_summary: (j.outcome_summary as string) ?? null,
      transcript_full: normalizeTranscript(j.transcript_full),
      recording_url: (j.recording_url as string) ?? null,
      duration_sec: typeof j.duration_sec === "number" ? j.duration_sec : undefined,
    };
    return result;
  },

  async getUsage() {
    const res = await fetch(`${BASE}/v1/usage`, { headers: headers() });
    if (!res.ok) throw new Error(`Voygr getUsage ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { remaining?: number; quota_limit?: number };
    return { remaining: Number(j.remaining ?? 0), limit: Number(j.quota_limit ?? 0) };
  },

  async awaitCall(call_id, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const pollMs = opts.pollMs ?? 6000;
    const terminal = new Set(["completed", "failed", "no_answer", "voicemail", "declined", "error"]);
    const deadline = Date.now() + timeoutMs;
    let last = await this.getCall(call_id);
    while (!terminal.has(last.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      last = await this.getCall(call_id);
    }
    if (last.status === "completed") {
      await new Promise((r) => setTimeout(r, 30000));
      last = await this.getCall(call_id);
    }
    return last;
  },
};
