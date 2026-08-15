"use client";

import { useState } from "react";
import type { Question, Variant } from "../lib/spec";

export default function VoteForm({
  questions,
  submissionId,
  taskId,
  variant,
}: {
  questions: Question[];
  submissionId: string | null;
  taskId: string | null;
  variant: Variant;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [verbatim, setVerbatim] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAnswered = questions.every((q) => answers[q.id]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!allAnswered) {
      setError("Please answer both questions.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          taskId,
          variant,
          trust: answers["trust"],
          ad_recognition: answers["ad_recognition"],
          verbatim: verbatim.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) setDone(true);
      else setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Could not submit. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="thanks" role="status">
        <div className="check">✓</div>
        <p>Thanks — your response was recorded.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {questions.map((q) => (
        <fieldset key={q.id}>
          <legend>{q.prompt}</legend>
          <div className="options">
            {q.options.map((opt) => (
              <label className="opt" key={opt}>
                <input
                  type="radio"
                  name={q.id}
                  value={opt}
                  checked={answers[q.id] === opt}
                  onChange={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                />
                {opt}
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <label className="field" htmlFor="verbatim">
        Anything you would add? (optional)
      </label>
      <textarea
        id="verbatim"
        value={verbatim}
        onChange={(e) => setVerbatim(e.target.value)}
        maxLength={400}
      />

      <div>
        <button type="submit" disabled={submitting || !allAnswered}>
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
