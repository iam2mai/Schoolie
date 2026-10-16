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

No runtime dependencies: plain TypeScript run directly by Node 22.18+. Jest is
used for tests only.

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
  letter. Retrieval is keyword-only by default, but can be switched to
  meaning-based or a blend of the two — see [Semantic search](#semantic-search).
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
npm install               # test tools only (Jest)
npm test                  # offline tests, API stubbed
npm run search -- "excursion"   # retrieval only, works without a key
npm run sync              # extract dates -> out/school-letters.ics
npm run ask -- "Is there a student free day coming up?"
npm run upcoming          # next 6 weeks
```

The three letters in `letters/` are made-up samples. Delete them once you add
real ones.

## Website

`npm start` runs a password-protected website with the same features: ask a
question, add a letter by pasting text or opening a file, see the next six
weeks of dates, and subscribe to them in your phone's calendar.

```bash
# in .env: APP_PASSWORD (10+ characters), SESSION_SECRET, and an LLM key
npm start                 # http://localhost:3000
```

The LLM API key stays on the server; the browser only ever talks to this app.

### Deploying (Fly.io example)

Any host that runs a Dockerfile and offers a persistent disk works (Fly.io,
Render, Railway). Letters and dates are stored in `/data`, so that **must** be
a persistent volume, or they disappear on every deploy. Run a single instance:
syncs are coordinated in memory.

```bash
fly launch --no-deploy                 # picks up the Dockerfile; choose a region near you
fly volumes create data --size 1       # 1 GB is plenty
# add to fly.toml:
#   [mounts]
#     source = "data"
#     destination = "/data"
fly secrets set \
  APP_PASSWORD='a long passphrase' \
  SESSION_SECRET=$(openssl rand -hex 32) \
  CALENDAR_TOKEN=$(openssl rand -hex 24) \
  ANTHROPIC_API_KEY=sk-ant-... \
  TZ=Australia/Melbourne
fly deploy
fly scale count 1
```

Set `TZ` to your time zone: servers default to UTC, which shifts "today" and
"this Friday". The sample letters are not deployed; add yours from the Letters
tab.

### What protects it

- One password (`APP_PASSWORD`). The server refuses to start without one.
  After 10 wrong attempts from an IP, logins are blocked for 15 minutes.
- Sessions are signed, HttpOnly, `SameSite=Strict` cookies that last 30 days.
  Changing `SESSION_SECRET` logs everyone out.
- Cross-site requests are refused (Origin check, JSON-only writes), and a
  strict Content Security Policy blocks injected scripts.
- The calendar URL is protected only by `CALENDAR_TOKEN`, since calendar apps
  can't log in. Share it only with family; change the token to revoke it.
- LLM API errors are logged on the server, not shown in the browser.

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

## Semantic search

By default, `ask` and `search` find letters by **keyword** (BM25): fast, free,
no account needed, but it misses letters that use different words from your
question ("costume" vs "dress up"). You can switch to **semantic** search, which
matches by meaning using embeddings and a cloud vector database, or **hybrid**,
which blends both and is the recommended setting once it's turned on.

`SEARCH_MODE` in `.env` picks the mode:

| Mode | What it does | Needs keys? |
| --- | --- | --- |
| `keyword` | Word matching only (the default) | No |
| `semantic` | Meaning-based only | Yes |
| `hybrid` | Both, blended with Reciprocal Rank Fusion | Yes |

**Turning it on:**

1. Get an [OpenAI](https://platform.openai.com) key (for embeddings) and a
   [Pinecone](https://pinecone.io) key (free Starter tier). In the Pinecone
   console, create a **serverless** index — dimension **1536**, metric
   **cosine** — and note its name.
2. Fill in `.env`:
   ```bash
   SEARCH_MODE=hybrid
   OPENAI_API_KEY=sk-...
   PINECONE_API_KEY=...
   PINECONE_INDEX=school-letters      # match the index you created
   ```
3. Load your existing letters into the index (a one-off; new uploads and
   deletes keep themselves in step after this):
   ```bash
   npm run reindex
   ```

That's it — `ask`, `search` and the website now use semantic/hybrid retrieval.
Switch back any time by setting `SEARCH_MODE=keyword` (or removing it); the
keyword path never touches the network or needs the keys.

**Seeing the difference.** `compare` runs the same question through all three
modes side by side, so you can judge which suits your letters:

```bash
npm run compare -- "what should my child dress up as"
```

The LangChain packages that power this load only when a semantic or hybrid mode
is selected, so the default keyword install stays dependency-light at runtime.
To use [Voyage AI](https://voyageai.com) embeddings instead of OpenAI, set
`EMBEDDINGS_PROVIDER=voyage` and `VOYAGE_API_KEY`, and install the extra package
with `npm i @langchain/community` (see `.env.example`).

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

## Tests

Tests use Jest, running the TypeScript as native ES modules (SWC strips the
types). The LLM APIs are always stubbed, so tests run offline and free.

```bash
npm test                  # all tests
npm run test:watch        # re-run on save
npm run test:coverage     # coverage report in coverage/
npm run typecheck         # also catches TypeScript that Node can't strip
npx jest test/ics.test.ts # one file (prefix with NODE_OPTIONS=--experimental-vm-modules)
```

## Project layout

```
src/letters.ts    load letters, read "Date:" header, paragraph chunking
src/retrieve.ts   BM25 retriever behind a small Retriever interface
src/semantic.ts   embeddings + Pinecone retrievers, hybrid fusion, index upkeep
src/constants.ts  search modes, embedding providers and their defaults
src/llm.ts        Claude or OpenAI via fetch, optional forced tool call
src/events.ts     date extraction prompt + schema, cache, replacement logic
src/ics.ts        iCalendar writer with VALARMs, RFC 5545 escaping and folding
src/app.ts        ask, sync, upcoming, save/list/delete letters (shared by CLI and website)
src/server.ts     website: node:http server, login, JSON API, calendar feed
public/           the web page (plain HTML, CSS and JS, no build step)
src/cli.ts        ask / sync / upcoming / search / compare / reindex
test/             Jest unit tests per module, plus pipeline.test.ts end to end
```

## Next steps

- **Embeddings — done.** Semantic and hybrid retrieval are built in; see
  [Semantic search](#semantic-search). Hybrid blends BM25 and embedding ranks,
  which helps with questions that use different words from the letter, such as
  "costume" vs "dress up".
- **Evals.** Write 20 or so question/expected-answer pairs from real letters
  and check retrieval hit rate and answer correctness after each change. The
  `compare` command is a manual first step toward this.
- **Prune on reindex.** `reindex` adds and overwrites but doesn't remove
  vectors for letters deleted while it wasn't running; a full rebuild (clear
  the index first) would close that gap.
