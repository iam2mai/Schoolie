# school-letters-rag

Ask questions about your child's school letters, and turn every date in them
into calendar events with alerts.

```
npm run ask -- "When is the Year 3 excursion and what does he need to bring?"

# example output

The Year 3 excursion to Melbourne Museum is now Tuesday 27 October (it moved
from 22 October) [2026-10-12-excursion-update.txt]. Bus leaves 9:00am, back
by 2:45pm. Pack a hat, water bottle and packed lunch in a disposable bag, full
uniform [2026-10-05-year3-excursion.txt]. Payment ($28) and the permission
slip are due Wednesday 21 October [2026-10-12-excursion-update.txt].
```

No dependencies: plain TypeScript run directly by Node 22.18+.

## How it works

```
letters/*.txt ──► chunk by paragraph ──► BM25 index ─┐
                                                     ├─► retrieve top 6 ──► Claude ──► answer + [letter] citations
question ────────────────────────────────────────────┘                        ▲
                                                                               │ known upcoming dates
letters/*.txt ──► Claude extracts dates (tool use, JSON) ──► events-cache.json ┴─► out/school-letters.ics
                  (oldest letter first; each sees earlier dates                      with alerts
                   so "moved to Tuesday" cancels the old entry)
```

There are two paths, because they suit different jobs:

- **`ask`** is classic RAG. Letters are split into paragraph chunks, ranked with
  BM25 keyword search (plus a small boost for newer letters), and the top
  excerpts go to Claude with instructions to answer only from them and cite the
  letter.
- **`sync`** is structured extraction. Each letter is read once by Claude
  using a forced tool call, which returns clean JSON (title, date, time,
  things to do). Results are cached by content hash, so only new or edited
  letters cost an API call. Those dates also feed back into `ask`, which makes
  questions like "what's on next week?" work even though no single chunk
  answers them.

**Changed dates.** Schools often send "the excursion has moved" letters. Each
letter is extracted with the earlier dates in view, and the model lists any it
replaces. Replaced entries stay in the `.ics` with `STATUS:CANCELLED` and the
same UID, so your calendar drops or strikes out the old date instead of
showing both.

## Setup

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY or OPENAI_API_KEY
npm test                  # offline tests, API stubbed
npm run search -- "excursion"   # retrieval only, works without a key
npm run sync              # extract dates -> out/school-letters.ics
npm run ask -- "Is there a student free day coming up?"
npm run upcoming          # next 6 weeks
```

The three letters in `letters/` are made-up samples. Delete them once you add
real ones.

## Choosing the model: Claude or OpenAI

Set `LLM_PROVIDER` in `.env` to `claude` (Anthropic) or `openai`. If you leave it
unset, the tool uses whichever API key you have filled in, preferring Claude
when both are set. To switch for a single command:

```bash
LLM_PROVIDER=openai npm run ask -- "What's on next week?"
```

| Provider | Key | Model setting (default) |
| --- | --- | --- |
| `claude` | `ANTHROPIC_API_KEY` (console.anthropic.com) | `CLAUDE_MODEL` (`claude-sonnet-5-5`) |
| `openai` | `OPENAI_API_KEY` (platform.openai.com) | `OPENAI_MODEL` (`gpt-5`) |

`OPENAI_BASE_URL` points the OpenAI provider at any compatible endpoint, such as
Azure OpenAI or a local server like Ollama, as long as it supports tool calling.

The events cache is keyed by letter content, not by provider, so switching
providers doesn't re-extract letters you've already synced. Delete
`out/events-cache.json` to redo them with the new model.

## Adding letters

Save each letter as a `.txt` or `.md` file in `letters/` (or set `LETTERS_DIR`
in `.env`, e.g. an iCloud Drive folder). Start it with the sent date so phrases
like "this Friday" resolve correctly:

```
Date: 2026-10-12
UPDATE: Year 3 Museum Excursion moved
...
```

From the school app on your iPhone: open the notice, use **Share → Save to
Files**, or copy the text into a note in an iCloud Drive folder. An Apple
Shortcut ("Save school letter") that takes shared text, prepends today's date
and saves it to that folder makes this one tap.

## Getting dates into your calendar

- **Import:** double-click `out/school-letters.ics` on your Mac. Re-importing
  after a new sync updates existing events (stable UIDs) rather than
  duplicating them.
- **Subscribe (hands-off):** put the `.ics` somewhere your phone can reach it
  by a hard-to-guess URL and subscribe to it in Calendar. When subscribing in
  Apple Calendar, untick **Remove: Alerts**, otherwise it strips the built-in
  reminders.

Default alerts (change `DEFAULT_ALERTS` in `src/ics.ts`):

| Kind | Example | Alerts |
| --- | --- | --- |
| event | Excursion, parade, free day | 6pm the evening before |
| deadline | Permission slip, payment, booking | 6pm three evenings before, and 8am on the day |

To run the sync automatically, schedule `npm run sync` with `launchd` (or
`cron`) on your Mac.

## Project layout

```
src/letters.ts    load letters, read "Date:" header, paragraph chunking
src/retrieve.ts   BM25 retriever behind a small Retriever interface
src/llm.ts        Claude or OpenAI via fetch, optional forced tool call
src/events.ts     date extraction prompt + schema, cache, replacement logic
src/ics.ts        iCalendar writer with VALARMs, RFC 5545 escaping and folding
src/cli.ts        ask / sync / upcoming / search
test/             end-to-end tests with a stubbed API
```

## Next steps

- **Embeddings.** Implement `Retriever` with an embedding model (for example
  Voyage AI, or a local model via transformers.js) and combine it with BM25
  scores (hybrid search). This helps with questions that use different words
  from the letter, such as "costume" vs "dress up".
- **Evals.** Write 20 or so question/expected-answer pairs from real letters
  and check retrieval hit rate and answer correctness after each change.
- **Storage.** Swap the in-memory index for SQLite (with `sqlite-vec` for
  embeddings) once you have hundreds of letters.
