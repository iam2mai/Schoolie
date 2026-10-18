"use client";

import { useEffect, useRef, useState } from "react";
import { api, prettyDate, today } from "../lib/client.ts";

interface LetterSummary {
  id: string;
  sentDate: string;
  title: string;
  preview: string;
}

export default function LettersPage() {
  const [letters, setLetters] = useState<LetterSummary[] | null>(null);
  const [listError, setListError] = useState("");
  const [text, setText] = useState("");
  const [sentDate, setSentDate] = useState(today());
  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const { letters } = await api<{ letters: LetterSummary[] }>("/api/letters");
      setLetters(letters);
      setListError("");
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    let content = await file.text();
    // A "Date: YYYY-MM-DD" first line sets the sent date, if present.
    const m = content.match(/^\s*date:\s*(\d{4}-\d{2}-\d{2})\s*\r?\n/i);
    if (m) {
      setSentDate(m[1]);
      content = content.slice(m[0].length);
    }
    setText(content.trim());
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setStatus({ msg: "Saving and reading dates…", error: false });
    try {
      const res = await api<{ id: string; warning?: string }>("/api/letters", {
        method: "POST",
        body: { text, sentDate },
      });
      setStatus({ msg: res.warning ?? `Saved as ${res.id}. Its dates are now on the Dates tab.`, error: false });
      setText("");
      setSentDate(today());
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setStatus({ msg: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setSaving(false);
    }
  }

  async function remove(l: LetterSummary) {
    if (!confirm(`Delete "${l.title}"? Its dates will be removed too.`)) return;
    try {
      await api(`/api/letters/${encodeURIComponent(l.id)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <form id="letter-form" className="card" onSubmit={save}>
        <h2>Add a letter</h2>
        <div className="row wrap">
          <label>
            Sent on
            <input type="date" required value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
          </label>
          <label className="file">
            Or open a file
            <input ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={onFile} />
          </label>
        </div>
        <textarea
          rows={8}
          required
          placeholder="Paste the letter here, starting with its subject line."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={saving || !text.trim()}>
          {saving ? "Saving…" : "Save letter"}
        </button>
        {status && (
          <p className={status.error ? "error" : "muted"} role="status">
            {status.msg}
          </p>
        )}
      </form>

      <h2>Letters</h2>
      {listError ? (
        <p className="error">{listError}</p>
      ) : letters === null ? (
        <p className="muted">Loading…</p>
      ) : letters.length === 0 ? (
        <p className="muted">No letters yet. Add one above.</p>
      ) : (
        <ul className="list">
          {letters.map((l) => (
            <li key={l.id} className="letter">
              <div>
                <strong>{l.title}</strong>
                <div className="small muted">
                  Sent {prettyDate(l.sentDate)} · {l.id}
                </div>
                {l.preview && <p className="small">{l.preview}</p>}
              </div>
              <button className="danger" onClick={() => remove(l)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
