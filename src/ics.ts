// Writes events to an iCalendar (.ics) file with alerts built in.
//
// Times are "floating" (no time zone), so they show at the stated local time
// on whatever device opens the file. Fine for a family in one city.

import type { SchoolEvent } from "./events.ts";

export interface AlertRules {
  // Minutes before the event's start. For all-day events, start is 00:00,
  // so 360 = 6pm the evening before and -480 = 8am on the day.
  event: number[];
  deadline: number[];
  reminder: number[];
}

export const DEFAULT_ALERTS: AlertRules = {
  event: [360],              // 6pm the evening before
  deadline: [360 + 2 * 1440, -480], // 6pm three evenings before, and 8am on the day
  reminder: [360],
};

export function toICS(events: SchoolEvent[], opts: { name?: string; alerts?: AlertRules } = {}): string {
  const alerts = opts.alerts ?? DEFAULT_ALERTS;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//school-letters-rag//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(opts.name ?? "School letters")}`,
  ];

  for (const e of events) {
    const allDay = !e.startTime;
    const d = e.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@school-letters-rag`, `DTSTAMP:${stamp}`);

    if (allDay) {
      const last = e.endDate && e.endDate > e.date ? e.endDate : e.date;
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(last, 1).replace(/-/g, "")}`);
    } else {
      const start = `${d}T${e.startTime!.replace(":", "")}00`;
      const endTime = e.endTime ?? addMinutes(e.startTime!, 60);
      const end = `${(e.endDate ?? e.date).replace(/-/g, "")}T${endTime.replace(":", "")}00`;
      lines.push(`DTSTART:${start}`, `DTEND:${end}`);
    }

    // Moved or cancelled entries stay in the file as CANCELLED (same UID), so a
    // subscribed calendar or a re-import removes or strikes out the old date.
    const prefix = (e.cancelledBy ? "Moved/cancelled: " : "") + (e.kind === "deadline" ? "Due: " : "");
    if (e.cancelledBy) lines.push("STATUS:CANCELLED");
    lines.push(`SUMMARY:${escape(prefix + e.title)}`);
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
    lines.push(`DESCRIPTION:${escape(description(e))}`);
    lines.push("TRANSP:TRANSPARENT"); // don't mark the parent as "busy"

    for (const mins of e.cancelledBy ? [] : alerts[e.kind] ?? []) {
      // Rules are "minutes before midnight of the day". For a timed event, add
      // the start time so "6pm the evening before" still means 6pm. Never
      // fire later than 30 minutes before a timed start.
      const offset = allDay ? mins : Math.max(mins + minutesOf(e.startTime!), 30);
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escape(prefix + e.title)}`,
        `TRIGGER:${duration(-offset)}`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function description(e: SchoolEvent): string {
  const parts: string[] = [];
  if (e.actions?.length) parts.push("To do:\n" + e.actions.map((a) => `- ${a}`).join("\n"));
  if (e.notes) parts.push(e.notes);
  if (e.cancelledBy) parts.push(`Superseded by letter: ${e.cancelledBy}`);
  parts.push(`From letter: ${e.letterId}`);
  return parts.join("\n\n");
}

function duration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  let m = Math.abs(minutes);
  const days = Math.floor(m / 1440); m -= days * 1440;
  const hours = Math.floor(m / 60); m -= hours * 60;
  let s = `${sign}P`;
  if (days) s += `${days}D`;
  if (hours || m || !days) s += "T" + (hours ? `${hours}H` : "") + (m ? `${m}M` : "") + (!hours && !m ? "0M" : "");
  return s;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function addMinutes(hhmm: string, n: number): string {
  const t = Math.min(minutesOf(hhmm) + n, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// RFC 5545: lines longer than 75 octets are folded.
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
