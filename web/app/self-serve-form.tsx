"use client";

import { useState } from "react";
import { previewBlock } from "../lib/render-preview";

type Result = { ok: true; id: string; status: string } | { ok: false; error: string };

export default function SelfServeForm() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [categories, setCategories] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/creative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          target_url: url,
          categories: categories
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
        }),
      });
      setResult((await res.json()) as Result);
    } catch (err) {
      setResult({ ok: false, error: String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid cols-3" style={{ gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="title">Title (anchor text)</label>
        <input
          id="title"
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={80}
        />

        <label htmlFor="body">One-line body</label>
        <textarea
          id="body"
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          maxLength={200}
        />

        <label htmlFor="target_url">Target URL</label>
        <input
          id="target_url"
          name="target_url"
          type="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />

        <label htmlFor="categories">Categories (comma-separated)</label>
        <input
          id="categories"
          name="categories"
          value={categories}
          onChange={(e) => setCategories(e.target.value)}
          placeholder="project management, kanban"
        />

        <button type="submit" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit for review"}
        </button>

        {result ? (
          result.ok ? (
            <div className="notice" role="status" style={{ marginTop: 14 }}>
              Submitted as <code>{result.id}</code> — status <strong>{result.status}</strong>. The
              Compliance agent reviews it before it can serve.
            </div>
          ) : (
            <div className="notice warn" role="alert" style={{ marginTop: 14 }}>
              {result.error}
            </div>
          )
        ) : null}
      </form>

      <div>
        <label>Live preview — the block that would be served</label>
        <pre className="mono-block" aria-live="polite">
          {previewBlock(title, body, url)}
        </pre>
        <p className="muted">
          Every served block carries <code>[SPONSORED]</code> and the disclosure notice. There is no
          option to remove it.
        </p>
      </div>
    </div>
  );
}
