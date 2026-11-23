# Inaccuracies

Find places where a Wikipedia article disagrees with its own cited source, and fix them. Design: [`docs/design-plans/2026-11-23-inaccuracies-app.md`](../docs/design-plans/2026-11-23-inaccuracies-app.md).

Two parts:

| Part | Where | Does |
|---|---|---|
| **Card builder** | `service/run-build-cards.js`, `service/cards/` | Daily. Turns stored findings into cards. It runs the "could both be true?" model call, re-reads each article (protection, pending changes, living people, is the sentence still there), and adds topics and monthly readers. Writes `cards.json` |
| **The app** | this folder | Serves the cards: a Node server with no runtime dependencies, one static page, share pages with link previews. Records answers and fixes in an append-only event log. Calls no model |

## Run it locally

```bash
cd inaccuracies
npm install          # optional: only for the PNG link previews (@resvg/resvg-js)
npm run dev          # http://localhost:8000, on dev/sample-cards.json
```

`npm run dev` sets `WIKI_CHECKS=off`, so "Did it work?" always says yes and nothing calls Wikipedia. `dev/sample-cards.json` is two benchmark rows written by hand. It isn't the builder's output; don't deploy it.

## Build cards

```bash
# From batch CSVs (anywhere):
node service/run-build-cards.js --findings-csv batch1.csv --findings-csv batch2.csv --out cards.json
# From ToolsDB (on Toolforge):
node service/run-build-cards.js --from-toolsdb --wiki enwiki --out cards.json
```

The builder reuses its previous output: model decisions are cached per card and prompt version, topics per page, and readers per month. Each run re-reads every candidate article, which is the freshness check. It replaces the file with a rename, and the app notices the new file on its next request. The end of a run prints why each finding was dropped.

## Configuration

| Variable | |
|---|---|
| `PORT` | Port (Toolforge sets it) |
| `CARDS_FILE` | The builder's output |
| `EVENTS_FILE` | The event log (JSON lines). Without it, events are kept in memory only |
| `BASE_URL` | Public origin, e.g. `https://inaccuracies.toolforge.org`. Link previews need absolute URLs |
| `PROJECT_PAGE` | On-wiki page linked from every edit summary, e.g. `User:Alaexis/Inaccuracies` |
| `FIX_OVERRIDE` | `on` or `off`: the owner's switch over the stop rule (more than 10 reverted in a block of 50 fixes turns Fix off) |
| `WIKI_CHECKS` | `off` for local development only |
| `FONT_DIR` | A folder of `.ttf`/`.otf` files for the preview images, e.g. Inter and Source Serif 4 |

## API

| Route | |
|---|---|
| `GET /api/topics` | Topics with open counts, fixes so far, the latest fix, whether Fix is on |
| `GET /api/next?topic=` | The next card for this session. A new session's first card is a fixed one, as a warm-up; `warmup=no` skips it |
| `GET /api/card/:id` | One card (puzzle links), or its before and after if it's fixed |
| `POST /api/answer` | `{card, kind: tap, token}`, `{kind: confirm, value}`, `{kind: same}` or `{kind: skip}`. Returns the flagged words, and the fix and ask links, only after an answer |
| `POST /api/hold` | `{card, action: fix|ask}`: holds the card for 20 minutes |
| `POST /api/check` | Has the sentence changed? If so, the card is fixed |
| `POST /api/asked`, `POST /api/shared` | Record a talk-page note, a share |
| `/c/:id`, `/f/:id`, `/t/:topic` | Puzzle, fix and topic pages, with Open Graph tags |
| `/og/c/:id.png`, `/og/f/:id.png` | Link preview images |

Every API call carries `X-Session`, a random id the page makes and keeps in `localStorage`. That id is all that's stored about anyone.

## Deploying on Toolforge (not done yet)

1. Create the tool `inaccuracies` and copy this folder to `$HOME/www/js`. Run `npm install`, then `toolforge webservice node18 start`. The code avoids anything newer than Node 18.
2. Set `CARDS_FILE`, `EVENTS_FILE` (somewhere under `$HOME`), `BASE_URL` and `PROJECT_PAGE`, and add fonts to `FONT_DIR`.
3. Schedule the card builder daily (`toolforge jobs run --schedule`).
4. **Open question: how the app tool reads the builder's output.** The builder reads `citation_findings`, which lives in the batch tool's private ToolsDB database. Options: run the builder in the batch tool and copy `cards.json` across; have the builder also write a `_p` table, which every tool can read, and teach the app to read it; or run the builder in this tool from batch CSVs.
5. Before launch: create `PROJECT_PAGE` on the wiki and post the heads-up (see the design doc's guardrails).
