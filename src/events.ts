// Extracting dated events from letters, with a per-letter cache so only new
// or edited letters are sent to the model.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Letter } from "./letters.ts";
import { callLLM } from "./llm.ts";

export type EventKind = "event" | "deadline" | "reminder";

export interface SchoolEvent {
  title: string;        // short, calendar-friendly: "Year 3 excursion: Melbourne Museum"
  kind: EventKind;      // event = something happening; deadline = form/payment due
  date: string;         // YYYY-MM-DD
  endDate?: string;     // YYYY-MM-DD, for multi-day events (inclusive)
  startTime?: string;   // HH:MM, 24h, only if the letter states a time
  endTime?: string;
  location?: string;
  actions?: string[];   // what the parent must do or send: "Return permission slip", "Pack hat"
  notes?: string;
  letterId: string;     // filled in by us, not the model
  id: string;           // stable id, filled in by us
  cancelledBy?: string; // letter that moved or cancelled this entry
}

export function eventId(e: Pick<SchoolEvent, "letterId" | "kind" | "title" | "date">): string {
  return createHash("sha1").update(`${e.letterId}|${e.kind}|${e.title.toLowerCase()}|${e.date}`).digest("hex").slice(0, 12);
}

const TOOL = {
  name: "record_events",
  description: "Record every dated event, deadline or reminder in the school letter.",
  input_schema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short calendar title, under 60 characters." },
            kind: { type: "string", enum: ["event", "deadline", "reminder"] },
            date: { type: "string", description: "YYYY-MM-DD" },
            endDate: { type: "string", description: "YYYY-MM-DD, last day of a multi-day event" },
            startTime: { type: "string", description: "HH:MM 24-hour, only if stated" },
            endTime: { type: "string", description: "HH:MM 24-hour, only if stated" },
            location: { type: "string" },
            actions: { type: "array", items: { type: "string" }, description: "Things the parent must do, bring or pay." },
            notes: { type: "string", description: "Other useful detail, e.g. cost, who it applies to." },
          },
          required: ["title", "kind", "date"],
        },
      },
      replaces: {
        type: "array",
        items: { type: "string" },
        description: "ids of earlier entries that this letter moves, reschedules or cancels.",
      },
    },
    required: ["events"],
  },
};

const SYSTEM = `You extract calendar entries from letters a school sends to parents.
Rules:
- Only include items with a specific date. Skip vague ones ("later this term").
- Resolve relative dates ("this Friday", "next week") using the letter's sent date.
  When a weekday and date disagree, trust the explicit date.
- A permission slip or payment due date is its own "deadline" entry, separate from the event it is for.
- Put things the parent must do, bring or pay into "actions".
- Do not invent times, costs or locations that are not in the letter.
- You may be given entries from earlier letters. If this letter moves, reschedules
  or cancels any of them, list their ids in "replaces" and record the new dates as
  fresh entries. Only do this when the letter clearly refers to the same thing.`;

export async function extractEvents(
  letter: Letter,
  earlier: SchoolEvent[] = [],
): Promise<{ events: SchoolEvent[]; replaces: string[] }> {
  const prior = earlier.length
    ? `Entries from earlier letters:\n${earlier.map((e) => `- id ${e.id}: ${e.date} [${e.kind}] ${e.title}`).join("\n")}\n\n`
    : "";
  const { toolInput } = await callLLM({
    system: SYSTEM,
    user: `${prior}Letter sent on ${letter.sentDate} (${weekday(letter.sentDate)}).\n\n<letter>\n${letter.text}\n</letter>`,
    tool: TOOL,
    maxTokens: 2000,
  });
  const events: SchoolEvent[] = (toolInput?.events ?? []).filter(isValid).map((e: any) => {
    const ev = { ...e, letterId: letter.id };
    return { ...ev, id: eventId(ev) };
  });
  const known = new Set(earlier.map((e) => e.id));
  const replaces = (toolInput?.replaces ?? []).filter((id: string) => known.has(id));
  return { events, replaces };
}

function isValid(e: any): boolean {
  return typeof e?.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e?.date ?? "") && !Number.isNaN(Date.parse(e.date));
}

function weekday(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-AU", { weekday: "long", timeZone: "UTC" });
}

// Cache: { [letterId]: { hash, events, replaces } }. A letter is re-extracted
// only when its text changes, so API calls stay proportional to new mail.
// Letters are processed oldest first, so each one sees what came before it.
export type Cache = Record<string, { hash: string; events: SchoolEvent[]; replaces: string[] }>;

export async function syncEvents(letters: Letter[], cachePath: string, log = console.log): Promise<SchoolEvent[]> {
  const cache: Cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const next: Cache = {};
  const ordered = [...letters].sort((a, b) => a.sentDate.localeCompare(b.sentDate) || a.id.localeCompare(b.id));
  let earlierChanged = false;
  for (const letter of ordered) {
    const hit = cache[letter.id];
    if (hit && hit.hash === letter.hash && !earlierChanged) {
      next[letter.id] = hit;
      continue;
    }
    // Once a letter is (re)extracted, later letters are redone too, because
    // their "replaces" links may point at entries that changed.
    earlierChanged = true;
    log(`  extracting dates from ${letter.id} ...`);
    const earlier = applyReplacements(next).filter((e) => !e.cancelledBy);
    next[letter.id] = { hash: letter.hash, ...(await extractEvents(letter, earlier)) };
  }
  writeFileSync(cachePath, JSON.stringify(next, null, 2));
  return applyReplacements(next);
}

export function applyReplacements(cache: Cache): SchoolEvent[] {
  const cancelled = new Map<string, string>();
  for (const [letterId, c] of Object.entries(cache)) for (const id of c.replaces ?? []) cancelled.set(id, letterId);
  return Object.values(cache)
    .flatMap((c) => c.events)
    .map((e) => (cancelled.has(e.id) ? { ...e, cancelledBy: cancelled.get(e.id) } : e))
    .sort((a, b) => a.date.localeCompare(b.date));
}
