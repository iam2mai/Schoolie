"use client";

import { useState } from "react";
import { api } from "../lib/client.ts";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { method: "POST", body: { password } });
      setPassword("");
      // Full navigation so the middleware re-runs with the new cookie.
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="login">
      <form className="card narrow" onSubmit={submit}>
        <h2>Log in</h2>
        <p className="muted">Ask anything about the letters from school.</p>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
