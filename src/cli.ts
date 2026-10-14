// school-letters-rag CLI
//
//   node src/cli.ts ask "When is the Year 3 excursion and what do I need to send?"
//   node src/cli.ts sync          extract dates from new letters -> out/school-letters.ics
//   node src/cli.ts upcoming      list the next few weeks of dates
//   node src/cli.ts search "hat"  retrieval only (no API key needed)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLetters, chunkLetter } from "./letters.ts";
import { BM25Retriever } from "./retrieve.ts";
import { callClaude, hasApiKey } from "./llm.ts";
import { syncEvents, applyReplacements, type SchoolEvent } from "./events.ts";
import { toICS } from "./ics.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LETTERS = process.env.LETTERS_DIR ?? join(ROOT, "letters");
const OUT = join(ROOT, "out");
const CACHE = join(OUT, "events-cache.json");
const ICS = join(OUT, "school-letters.ics");

try { process.loadEnvFile(join(ROOT, ".env")); } catch { /* .env is optional */ }
mkdirSync(OUT, { recursive: true });

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

function cachedEvents(): SchoolEvent[] {
  if (!existsSync(CACHE)) return [];
  return applyReplacements(JSON.parse(readFileSync(CACHE, "utf8")));
}

function formatEvent(e: SchoolEvent): string {
  const when = e.date + (e.endDate ? ` to ${e.endDate}` : "") + (e.startTime ? ` ${e.startTime}` : "");
  const todo = e.actions?.length ? ` | to do: ${e.actions.join("; ")}` : "";
  return `${when}  [${e.kind}] ${e.title}${todo}  (${e.letterId})`;
}

async function ask(question: string) {
  const letters = loadLetters(LETTERS);
  const retriever = new BM25Retriever(letters.flatMap((l) => chunkLetter(l)));
  const hits = retriever.search(question, 6);

  const context = hits
    .map((h) => `<excerpt letter="${h.chunk.letterId}" sent="${h.chunk.sentDate}">\n${h.chunk.text}\n</excerpt>`)
    .join("\n\n");

  // Structured dates from `sync`, if available, help with "what's on next week?"
  const upcoming = cachedEvents().filter((e) => !e.cancelledBy && (e.endDate ?? e.date) >= today());
  const calendar = upcoming.length
    ? `\n\n<known_dates>\n${upcoming.sort((a, b) => a.date.localeCompare(b.date)).map(formatEvent).join("\n")}\n</known_dates>`
    : "";

  if (!hasApiKey()) {
    console.log("No ANTHROPIC_API_KEY set, so here are the retrieved excerpts only:\n");
    console.log(context || "(nothing matched)");
    return;
  }

  const { text } = await callClaude({
    system: `You help a parent keep track of letters from their child's school.
Today is ${today()}. Answer only from the excerpts and known dates provided.
If letters conflict, prefer the most recently sent one and say a date changed.
If the answer isn't there, say so plainly rather than guessing.
Be brief and practical: lead with the date and what the parent needs to do.
Cite the letter file name in brackets after each fact, e.g. [2026-10-12-excursion.txt].`,
    user: `${context}${calendar}\n\nQuestion: ${question}`,
    maxTokens: 800,
  });
  console.log(text.trim());
}

async function sync() {
  if (!hasApiKey()) throw new Error("sync needs ANTHROPIC_API_KEY (see README).");
  const letters = loadLetters(LETTERS);
  console.log(`Reading ${letters.length} letter(s) from ${LETTERS}`);
  const events = await syncEvents(letters, CACHE);
  writeFileSync(ICS, toICS(events, { name: process.env.CALENDAR_NAME ?? "School letters" }));
  console.log(`\n${events.length} date(s) written to ${ICS}\n`);
  upcoming(events);
}

function upcoming(events = cachedEvents(), days = 42) {
  const t = today();
  const until = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA");
  const list = events.filter((e) => !e.cancelledBy && (e.endDate ?? e.date) >= t && e.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  console.log(list.length ? `Next ${days} days:\n` + list.map((e) => "  " + formatEvent(e)).join("\n") : "Nothing in the next few weeks.");
}

function search(query: string) {
  const letters = loadLetters(LETTERS);
  const hits = new BM25Retriever(letters.flatMap((l) => chunkLetter(l))).search(query, 5);
  for (const h of hits) console.log(`--- ${h.chunk.id}  score ${h.score.toFixed(2)}\n${h.chunk.text}\n`);
  if (!hits.length) console.log("(nothing matched)");
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(" ");
try {
  if (cmd === "ask" && arg) await ask(arg);
  else if (cmd === "sync") await sync();
  else if (cmd === "upcoming") upcoming();
  else if (cmd === "search" && arg) search(arg);
  else console.log(`Usage:
  npm run ask -- "your question"
  npm run sync
  npm run upcoming
  npm run search -- "keywords"`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
