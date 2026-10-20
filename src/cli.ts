// school-letters-rag CLI
//
//   node src/cli.ts ask "When is the Year 3 excursion and what do I need to send?"
//   node src/cli.ts sync          extract dates from new letters -> out/school-letters.ics
//   node src/cli.ts upcoming      list the next few weeks of dates
//   node src/cli.ts search "hat"  retrieval only (no API key needed)
//   node src/cli.ts reindex        load every letter into the vector index
//   node src/cli.ts compare "hat"  keyword vs semantic vs hybrid, side by side
//
// The website (the Next.js app in app/) offers the same things in a browser.

import { join } from "node:path";
import { loadLetters, chunkLetter } from "./letters.ts";
import { BM25Retriever } from "./retrieve.ts";
import { hasApiKey, apiKeyName } from "./llm.ts";
import { ROOT, paths, ask, sync, upcoming, cachedEvents, formatEvent, reindex, compareRetrieval } from "./app.ts";
import { indexingEnabled } from "./semantic.ts";
import type { SchoolEvent } from "./events.ts";

try { process.loadEnvFile(join(ROOT, ".env")); } catch { /* .env is optional */ }
const p = paths();

function printUpcoming(events: SchoolEvent[], days = 42) {
  const list = upcoming(events, days);
  console.log(list.length ? `Next ${days} days:\n` + list.map((e) => "  " + formatEvent(e)).join("\n") : "Nothing in the next few weeks.");
}

function search(query: string) {
  const hits = new BM25Retriever(loadLetters(p.letters).flatMap((l) => chunkLetter(l))).search(query, 5);
  for (const h of hits) console.log(`--- ${h.chunk.id}  score ${h.score.toFixed(2)}\n${h.chunk.text}\n`);
  if (!hits.length) console.log("(nothing matched)");
}

async function compare(query: string) {
  console.log(`Comparing search modes for: "${query}"\n`);
  for (const { mode, hits, error } of await compareRetrieval(p, query, 5)) {
    if (error) {
      console.log(`${mode}:  (unavailable: ${error})\n`);
    } else if (!hits?.length) {
      console.log(`${mode}:  (nothing matched)\n`);
    } else {
      console.log(`${mode}:`);
      hits.forEach((h, i) => {
        const snippet = h.chunk.text.replace(/\s+/g, " ").trim().slice(0, 80);
        console.log(`  ${i + 1}. [${h.chunk.id}]  score ${h.score.toFixed(3)}\n     ${snippet}`);
      });
      console.log("");
    }
  }
  if (!indexingEnabled()) console.log("Tip: set SEARCH_MODE=hybrid and the keys (see README), then run reindex, to fill in the semantic and hybrid columns.");
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(" ");
try {
  if (cmd === "ask" && arg) {
    const { answer, sources } = await ask(p, arg);
    if (answer) console.log(answer);
    else {
      console.log(`No ${apiKeyName()} set, so here are the retrieved excerpts only:\n`);
      console.log(sources.map((s) => `<excerpt letter="${s.letterId}" sent="${s.sentDate}">\n${s.text}\n</excerpt>`).join("\n\n") || "(nothing matched)");
    }
  } else if (cmd === "sync") {
    if (!hasApiKey()) throw new Error(`sync needs ${apiKeyName()} (see README).`);
    console.log(`Reading ${loadLetters(p.letters).length} letter(s) from ${p.letters}`);
    const events = await sync(p, console.log);
    console.log(`\n${events.length} date(s) written to ${p.ics}\n`);
    printUpcoming(events);
  } else if (cmd === "upcoming") printUpcoming(cachedEvents(p));
  else if (cmd === "search" && arg) search(arg);
  else if (cmd === "compare" && arg) await compare(arg);
  else if (cmd === "reindex") {
    if (!indexingEnabled()) throw new Error('reindex needs SEARCH_MODE=semantic or hybrid (see README "Semantic search").');
    console.log(`Indexing ${loadLetters(p.letters).length} letter(s) from ${p.letters}...`);
    const n = await reindex(p);
    console.log(`Indexed ${n} chunk(s).`);
  } else console.log(`Usage:
  npm run ask -- "your question"
  npm run sync
  npm run upcoming
  npm run search -- "keywords"
  npm run compare -- "keywords"
  npm run reindex
  npm start                      (website)`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
