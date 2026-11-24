# Fact Hunt

Find and fix inaccuracies on Wikipedia: places where an article disagrees with its own cited source. Design: [`docs/design-plans/2026-11-23-fact-hunt-app.md`](../docs/design-plans/2026-11-23-fact-hunt-app.md).

Two parts:

| Part | Where | Does |
|---|---|---|
| **Card builder** | `service/run-build-cards.js`, `service/cards/` | Daily. Turns stored findings into cards. It runs the "could both be true?" model call, re-reads each article (protection, pending changes, living people, is the sentence still there), and adds topics and monthly readers. Writes `cards.json` |
| **The app** | this folder | Serves the cards: a Node server with no runtime dependencies, one static page, share pages with link previews. Records answers and fixes in an append-only event log. Calls no model |

## Run it locally

```bash
cd fact-hunt
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
| `BASE_URL` | Public origin, e.g. `https://fact-hunt.toolforge.org`. Link previews need absolute URLs |
| `PROJECT_PAGE` | On-wiki page linked from every edit summary, e.g. `User:Alaexis/Fact Hunt` |
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

## Deploying on Toolforge

Two tools take part. The **batch tool** you already run builds the cards, because it holds `citation_findings`, the repo and its dependencies. A new **`fact-hunt` tool** serves the app. The cards file passes between them through the batch tool's home directory.

The code is on branch `ccr-9be554df-3rlar1` until it is merged; check out `main` below once it is.

**1. In the batch tool: build cards daily.**

```bash
become <batch-tool>
cd ~/citation-checker-script && git pull     # the checkout the sweeps run from
mkdir -p ~/fact-hunt && chmod o+rx ~ ~/fact-hunt
toolforge jobs run build-cards-once --image node20 --wait \
  --command "cd ~/citation-checker-script && node service/run-build-cards.js --from-toolsdb --wiki enwiki --out ~/fact-hunt/cards.json"
cat ~/build-cards-once.err                   # the counts, and why each finding was dropped
chmod o+r ~/fact-hunt/cards.json
toolforge jobs run build-cards --image node20 --schedule "23 4 * * *" \
  --command "cd ~/citation-checker-script && node service/run-build-cards.js --from-toolsdb --wiki enwiki --out ~/fact-hunt/cards.json && chmod o+r ~/fact-hunt/cards.json"
```

**2. Create the `fact-hunt` tool** at toolsadmin.wikimedia.org (it takes a few minutes to appear), then:

```bash
become fact-hunt
git clone https://github.com/alex-o-748/citation-checker-script.git ~/src
ln -s ~/src/fact-hunt ~/www/js            # the Node webservice runs `npm start` here
head -c 300 /data/project/<batch-tool>/fact-hunt/cards.json   # this tool can read the cards
toolforge envvars create CARDS_FILE /data/project/<batch-tool>/fact-hunt/cards.json
toolforge envvars create EVENTS_FILE /data/project/fact-hunt/events.jsonl
toolforge envvars create BASE_URL https://fact-hunt.toolforge.org
toolforge envvars create PROJECT_PAGE User:Alaexis/Fact Hunt
toolforge webservice node20 shell            # then, inside: cd ~/www/js && npm install && exit
toolforge webservice node20 start
```

`npm install` runs inside the webservice shell so the preview renderer (`@resvg/resvg-js`) gets the binary for the image it will run on. For serif and sans text in the previews, put `.ttf` files (Source Serif 4 and Inter, both OFL) in `~/fonts` and add `FONT_DIR=/data/project/fact-hunt/fonts`.

**3. Check it**: open https://fact-hunt.toolforge.org, then `toolforge webservice logs`. A new value of an envvar reaches the app only after `toolforge webservice restart`.

**4. Before telling anyone**: play 30 cards yourself, create `PROJECT_PAGE` on the wiki, and post the heads-up (the design doc's guardrails).

**Updating**: `git pull` in `~/src` as the `fact-hunt` tool, then `toolforge webservice restart`. The cards file needs no restart: the app reloads it when it changes.

If the `head` in step 2 is refused, the cards file isn't readable across tools: check the `chmod`s in step 1.
