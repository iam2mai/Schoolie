"use client";

import { useCallback, useEffect, useState } from "react";
import { api, prettyDate } from "../lib/client.ts";

interface SchoolEvent {
  date: string;
  endDate?: string;
  startTime?: string;
  title: string;
  kind: string;
  location?: string;
  actions?: string[];
  letterId: string;
}

interface Me {
  llmConfigured: boolean;
  calendarPath: string | null;
}

function when(ev: SchoolEvent): string {
  return (
    prettyDate(ev.date) +
    (ev.endDate ? ` – ${prettyDate(ev.endDate)}` : "") +
    (ev.startTime ? `, ${ev.startTime}` : "")
  );
}

export default function DatesPage() {
  const [events, setEvents] = useState<SchoolEvent[] | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { events } = await api<{ events: SchoolEvent[] }>("/api/upcoming?days=42");
      setEvents(events);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
    api<Me>("/api/me").then(setMe).catch(() => {});
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await api<{ warning?: string }>("/api/sync", { method: "POST", body: {} });
      if (res.warning) alert(res.warning);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  const calendarUrl = me?.calendarPath ? (typeof location !== "undefined" ? location.origin : "") + me.calendarPath : "";

  return (
    <section>
      {me && !me.llmConfigured && (
        <p className="notice">
          No AI key is configured on the server, so dates can only be read when one is added.
        </p>
      )}

      <div className="row">
        <h2>Next 6 weeks</h2>
        <button className="secondary" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Reading letters…" : "Refresh dates"}
        </button>
      </div>

      {error ? (
        <p className="error">{error}</p>
      ) : events === null ? (
        <p className="muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted">Nothing in the next 6 weeks.</p>
      ) : (
        <ul className="list">
          {events.map((ev, i) => (
            <li key={i} className={`event ${ev.kind}`}>
              <div className="when">{when(ev)}</div>
              <div>
                <strong>{(ev.kind === "deadline" ? "Due: " : "") + ev.title}</strong>
                {ev.location && <div className="small muted">{ev.location}</div>}
                {ev.actions && ev.actions.length > 0 && (
                  <ul className="actions">
                    {ev.actions.map((a, j) => (
                      <li key={j}>{a}</li>
                    ))}
                  </ul>
                )}
                <div className="small muted">{ev.letterId}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {me?.calendarPath && (
        <div id="calendar" className="card">
          <h3>Add to your calendar</h3>
          <p className="muted">
            Subscribe to this address in Apple Calendar, Google Calendar or Outlook. New letters appear
            automatically. In Apple Calendar, untick <b>Remove: Alerts</b> to keep the reminders.
          </p>
          <div className="row">
            <input id="calendar-url" readOnly aria-label="Calendar address" value={calendarUrl} />
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(calendarUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard may be unavailable */
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="muted small">Anyone with this address can see the dates, so share it only with family.</p>
        </div>
      )}
    </section>
  );
}
