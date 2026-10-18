"use client";

import { useState } from "react";

interface Source {
  letterId: string;
  sentDate: string;
  text: string;
}

interface AskResult {
  answer?: string;
  sources: Source[];
  error?: string;
}

function prettyDate(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Turns "[2026-10-12-update.txt]" citations into small inline labels.
function renderAnswer(text: string) {
  return text.split(/(\[[^\]\n]+\.(?:txt|md)\])/i).map((part, i) =>
    /^\[.+\]$/.test(part) ? (
      <span key={i} className="cite">
        {part.slice(1, -1)}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = (await res.json().catch(() => ({}))) as AskResult;
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const letterCount = result ? new Set(result.sources.map((s) => s.letterId)).size : 0;

  return (
    <section className="ask">
      <form onSubmit={submit} className="ask-form">
        <label htmlFor="question">Ask about the letters</label>
        <textarea
          id="question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e as unknown as React.FormEvent);
            }
          }}
          placeholder="e.g. When is the Year 3 field trip?"
          rows={3}
        />
        <button type="submit" disabled={loading || !question.trim()}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      {error && <p className="answer error">{error}</p>}

      {result && (
        <article className="card qa">
          {result.answer ? (
            <p className="answer">{renderAnswer(result.answer)}</p>
          ) : (
            <p className="answer">
              {result.sources.length
                ? "Here are the parts of letters that look relevant:"
                : "Nothing in the letters matches that question."}
            </p>
          )}
          {result.sources.length > 0 && (
            <details open={!result.answer}>
              <summary>From {letterCount} letter(s)</summary>
              {result.sources.map((s, i) => (
                <blockquote key={i}>
                  <div className="small muted">
                    {s.letterId} · sent {prettyDate(s.sentDate)}
                  </div>
                  {s.text}
                </blockquote>
              ))}
            </details>
          )}
        </article>
      )}
    </section>
  );
}
