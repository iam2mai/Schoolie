// The operations behind both the CLI and the website: asking questions,
// syncing dates, listing upcoming events and managing letter files.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLetters, chunkLetter, type Letter } from "./letters.ts";
import { makeRetriever, indexingEnabled, indexLetter, removeLetter, reindexAll } from "./semantic.ts";
import { callLLM, hasApiKey } from "./llm.ts";
import { syncEvents, applyReplacements, type SchoolEvent } from "./events.ts";
import { toICS } from "./ics.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Paths { letters: string; out: string; cache: string; ics: string }

// DATA_DIR holds letters/ and out/ (point it at a persistent disk when
// hosted). LETTERS_DIR still overrides just the letters folder.
export function paths(env = process.env): Paths {
  const data = env.DATA_DIR ?? ROOT;
  const out = join(data, "out");
  const p = {
    letters: env.LETTERS_DIR ?? join(data, "letters"),
    out,
    cache: join(out, "events-cache.json"),
    ics: join(out, "school-letters.ics"),
  };
  mkdirSync(p.letters, { recursive: true });
  mkdirSync(p.out, { recursive: true });
  return p;
}

export const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time (set TZ)

export function cachedEvents(p: Paths): SchoolEvent[] {
  if (!existsSync(p.cache)) return [];
  return applyReplacements(JSON.parse(readFileSync(p.cache, "utf8")));
}

export function formatEvent(e: SchoolEvent): string {
  const when = e.date + (e.endDate ? ` to ${e.endDate}` : "") + (e.startTime ? ` ${e.startTime}` : "");
  const todo = e.actions?.length ? ` | to do: ${e.actions.join("; ")}` : "";
  return `${when}  [${e.kind}] ${e.title}${todo}  (${e.letterId})`;
}

export interface Source { letterId: string; sentDate: string; text: string }
export interface Answer { answer?: string; sources: Source[] }

// Retrieves the best excerpts and, if an API key is set, asks the model to
// answer from them. Without a key, only the sources are returned.
export async function ask(p: Paths, question: string): Promise<Answer> {
  const letters = loadLetters(p.letters);
  const hits = await makeRetriever(letters.flatMap((l) => chunkLetter(l))).retrieve(question, 6);
  const sources = hits.map((h) => ({ letterId: h.chunk.letterId, sentDate: h.chunk.sentDate, text: h.chunk.text }));
  if (!hasApiKey()) return { sources };

  const context = sources
    .map((s) => `<excerpt letter="${s.letterId}" sent="${s.sentDate}">\n${s.text}\n</excerpt>`)
    .join("\n\n");

  // Structured dates from sync, if available, help with "what's on next week?"
  const upcoming = cachedEvents(p).filter((e) => !e.cancelledBy && (e.endDate ?? e.date) >= today());
  const calendar = upcoming.length
    ? `\n\n<known_dates>\n${upcoming.map(formatEvent).join("\n")}\n</known_dates>`
    : "";

  const { text } = await callLLM({
    system: `You help a parent keep track of letters from their child's school.
Today is ${today()}. Answer only from the excerpts and known dates provided.
If letters conflict, prefer the most recently sent one and say a date changed.
If the answer isn't there, say so plainly rather than guessing.
Be brief and practical: lead with the date and what the parent needs to do.
Cite the letter file name in brackets after each fact, e.g. [2026-10-12-excursion.txt].`,
    user: `${context}${calendar}\n\nQuestion: ${question}`,
    maxTokens: 800,
  });
  return { answer: text.trim(), sources };
}

// Syncs run one at a time, so two uploads at once can't corrupt the cache.
let queue: Promise<unknown> = Promise.resolve();

export function sync(p: Paths, log: (msg: string) => void = () => {}): Promise<SchoolEvent[]> {
  const run = queue.then(async () => {
    const events = await syncEvents(loadLetters(p.letters), p.cache, log);
    writeFileSync(p.ics, toICS(events, { name: calendarName() }));
    return events;
  });
  queue = run.catch(() => {});
  return run;
}

export const calendarName = () => process.env.CALENDAR_NAME ?? "School letters";

export function upcoming(events: SchoolEvent[], days = 42): SchoolEvent[] {
  const t = today();
  const until = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA");
  return events
    .filter((e) => !e.cancelledBy && (e.endDate ?? e.date) >= t && e.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface LetterSummary { id: string; sentDate: string; title: string; preview: string }

export function listLetters(p: Paths): LetterSummary[] {
  return loadLetters(p.letters)
    .map((l: Letter) => {
      const [title, ...rest] = l.text.split("\n");
      return { id: l.id, sentDate: l.sentDate, title: title.slice(0, 120), preview: rest.join(" ").replace(/\s+/g, " ").trim().slice(0, 200) };
    })
    .sort((a, b) => b.sentDate.localeCompare(a.sentDate) || a.id.localeCompare(b.id));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Saves pasted or uploaded text as letters/<date>-<slug>.txt with a Date:
// header, never overwriting an existing file. Returns the new file name.
export function saveLetter(p: Paths, input: { text: string; sentDate?: string }): string {
  let text = input.text.replace(/\r\n/g, "\n").trim();
  const header = text.match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*\n/i);
  if (header) text = text.slice(header[0].length).trim();
  if (!text) throw new UserError("The letter is empty.");

  const sentDate = input.sentDate || header?.[1] || today();
  if (!ISO_DATE.test(sentDate) || Number.isNaN(Date.parse(sentDate))) throw new UserError("Sent date must be YYYY-MM-DD.");

  const slug = text.split("\n")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "letter";
  let id = `${sentDate}-${slug}.txt`;
  for (let n = 2; existsSync(join(p.letters, id)); n++) id = `${sentDate}-${slug}-${n}.txt`;
  writeFileSync(join(p.letters, id), `Date: ${sentDate}\n${text}\n`, { flag: "wx" });
  return id;
}

export function deleteLetter(p: Paths, id: string): void {
  // Only plain file names that exist in the letters folder, so a crafted id
  // like "../.env" can never reach outside it.
  if (id !== basename(id) || !loadLetters(p.letters).some((l) => l.id === id)) throw new UserError("No such letter.", 404);
  unlinkSync(join(p.letters, id));
}

// --- keeping the semantic index in step ---------------------------------------
// Each of these no-ops in keyword mode, so callers can invoke them
// unconditionally after saving or deleting a letter.

// Index a just-saved letter's chunks into the vector store.
export async function indexSavedLetter(p: Paths, id: string, env = process.env): Promise<void> {
  if (!indexingEnabled(env)) return;
  const letter = loadLetters(p.letters).find((l) => l.id === id);
  if (letter) await indexLetter(chunkLetter(letter), env);
}

// Drop a just-deleted letter's chunks from the vector store.
export async function unindexLetter(id: string, env = process.env): Promise<void> {
  if (!indexingEnabled(env)) return;
  await removeLetter(id, env);
}

// Index every current letter (a one-off after switching semantic search on).
// Returns the number of chunks indexed, or 0 in keyword mode.
export async function reindex(p: Paths, env = process.env): Promise<number> {
  if (!indexingEnabled(env)) return 0;
  return reindexAll(loadLetters(p.letters).flatMap((l) => chunkLetter(l)), env);
}

// An error whose message is safe to show to the user.
export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
