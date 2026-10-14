// Loading and chunking school letters.
//
// A letter is a .txt or .md file in letters/. An optional first line
// "Date: 2026-10-12" tells the system when the letter was sent, which helps
// the model resolve phrases like "next Friday". Without it, file mtime is used.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

export interface Letter {
  id: string;        // file name, e.g. "2026-10-12-year3-excursion.txt"
  sentDate: string;  // YYYY-MM-DD
  text: string;
  hash: string;      // content hash, used to skip unchanged letters
}

export interface Chunk {
  id: string;        // `${letterId}#${n}`
  letterId: string;
  sentDate: string;
  text: string;
}

export function loadLetters(dir: string): Letter[] {
  return readdirSync(dir)
    .filter((f) => [".txt", ".md"].includes(extname(f).toLowerCase()))
    .sort()
    .map((file) => {
      const path = join(dir, file);
      let text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
      let sentDate = statSync(path).mtime.toISOString().slice(0, 10);
      const m = text.match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*\n/i);
      if (m) {
        sentDate = m[1];
        text = text.slice(m[0].length).trim();
      }
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      return { id: file, sentDate, text, hash };
    });
}

// School letters are short, so paragraph-based chunks of roughly 600 chars
// keep each chunk about one topic. The letter's first line (usually its
// subject) is prefixed to every chunk so retrieval keeps the context.
export function chunkLetter(letter: Letter, maxChars = 600): Chunk[] {
  const paragraphs = letter.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const heading = letter.text.split("\n")[0].slice(0, 120);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) chunks.push(current);
  return chunks.map((text, n) => ({
    id: `${letter.id}#${n}`,
    letterId: letter.id,
    sentDate: letter.sentDate,
    text: n === 0 || text.startsWith(heading) ? text : `${heading}\n\n${text}`,
  }));
}
