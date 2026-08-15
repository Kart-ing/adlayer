"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { previewBlock } from "../../lib/render-preview";

export default function SponsorForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [categories, setCategories] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim() && body.trim() && url.trim();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      setError("Title, body, and target URL are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          target_url: url,
          categories: categories.split(",").map((c) => c.trim()).filter(Boolean),
        }),
      });
      const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (data.ok && data.id) {
        router.push(`/checkout?cid=${encodeURIComponent(data.id)}`);
      } else {
        setError(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
      }
    } catch {
      setError("Could not submit. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="grid2">
      <form onSubmit={onSubmit} noValidate className="panel">
        <label htmlFor="title">Title (anchor text)</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Acme Board" required />

        <label htmlFor="body">One-line pitch</label>
        <textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={200} placeholder="Kanban that stays out of your way for tiny remote teams." required />

        <label htmlFor="url">Target URL</label>
        <input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acme.example" required />

        <label htmlFor="cats">Categories</label>
        <input id="cats" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="project management, kanban" />
        <div className="field-hint">Comma-separated. Drives which publishers your placement matches.</div>

        <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit} style={{ marginTop: 22, width: "100%" }}>
          {submitting ? "Submitting…" : "Continue to review & payment →"}
        </button>

        {error ? (
          <div className="notice warn" role="alert" style={{ marginTop: 14 }}>
            {error}
          </div>
        ) : null}

        <div className="notice info" style={{ marginTop: 14 }}>
          On submit, a <strong>compliance agent</strong> reviews your creative (GLiGuard + a hard
          disclosure check) and a <strong>pricing agent</strong> sets the rate before you pay.
        </div>
      </form>

      <div>
        <div className="preview-label">
          Live preview <span className="tag-pill">exact bytes served</span>
        </div>
        <div className="mono-block" aria-live="polite">
          {previewBlock(title, body, url)}
        </div>
        <p className="field-hint" style={{ marginTop: 10 }}>
          Every served block carries <code>[SPONSORED]</code> and the disclosure notice. There is no
          option to remove it — undisclosed placement is prompt injection, not advertising.
        </p>
      </div>
    </div>
  );
}
