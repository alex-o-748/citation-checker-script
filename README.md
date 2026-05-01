# Source Verifier - Citation Checking for Wikipedia

An AI-powered Wikipedia user script that helps editors verify whether citations actually support the claims they're attached to. Clicking a citation number opens a sidebar that fetches the source, sends the claim plus the source text to an LLM, and returns a verdict: **Supported**, **Partially Supported**, **Not Supported**, or **Source Unavailable**.

Inspired by [User:Polygnotus/Scripts/AI_Source_Verification.js](https://en.wikipedia.org/wiki/User:Polygnotus/Scripts/AI_Source_Verification.js) and [User:Phlsph7/SourceVerificationAIAssistant.js](https://en.wikipedia.org/wiki/User:Phlsph7/SourceVerificationAIAssistant.js).

## Features

- Click any `[N]` citation in an article to verify the associated claim
- Batch-verify every citation in an article and generate a wiki-markup report of failed citations
- Multiple LLM providers with a unified interface:
  - **PublicAI** (free, no API key — Qwen-SEA-LION / OLMo / Apertus)
  - **Claude** (Anthropic)
  - **Gemini** (Google)
  - **ChatGPT** (OpenAI)
- Source content fetched through a CORS proxy so the script runs purely in the browser
- Benchmark suite for evaluating provider accuracy against 76 human-labeled citation pairs

## Installation

The script is deployed as a Wikipedia user script at [`User:Alaexis/AI_Source_Verification`](https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification) and auto-updates via [USync](https://en.wikipedia.org/wiki/Wikipedia:USync).

To install, add the following line to your [`common.js`](https://en.wikipedia.org/wiki/Special:MyPage/common.js):

```js
importScript('User:Alaexis/AI_Source_Verification.js');
```

API keys for paid providers are stored in `localStorage` and configured from the sidebar UI. PublicAI works out of the box with no key.

## Usage

1. Open any Wikipedia article
2. Click the "Verify Sources" toggle to open the sidebar
3. Click any citation number `[N]` in the article — the claim and source will be extracted, sent to the selected LLM, and a verdict displayed
4. Or click **Verify all citations** to batch-check the whole article and generate a wiki-markup report

## Command-line interface (`ccs verify`)

The CLI reuses `core/` to verify a single citation from the terminal — the same verification the userscript performs in-page, minus the UI.

### Install (from a clone)

```sh
git clone https://github.com/alex-o-748/citation-checker-script.git
cd citation-checker-script
npm install
```

No global install needed. Use the `npx` form shown below; npm exposes the `ccs` bin directly from `node_modules/.bin`.

### Usage

```sh
npx ccs verify <wikipedia-url> <citation-number> [--provider <name>] [--no-log]
```

Example:

```sh
npx ccs verify https://en.wikipedia.org/wiki/Great_Migration_(African_American) 14
```

Run `npx ccs --help` for the full option and exit-code table.

### Providers and API keys

| Provider | Flag value | Env var required |
| --- | --- | --- |
| PublicAI (default) | `--provider publicai` | none (routed via the worker proxy) |
| Claude | `--provider claude` | `CLAUDE_API_KEY` |
| Gemini | `--provider gemini` | `GEMINI_API_KEY` |
| OpenAI | `--provider openai` | `OPENAI_API_KEY` |

The CLI calls the same `publicai-proxy.alaexis.workers.dev` endpoint as the userscript for source fetching and PublicAI routing; other providers are called directly using your env-var API key.

### Logging

By default the CLI POSTs a log entry to the worker proxy's `/log` endpoint (same schema the userscript uses). Pass `--no-log` to skip.

### URL forms

Supported:
- `https://en.wikipedia.org/wiki/<Title>`
- `https://en.wikipedia.org/wiki/<Title>?oldid=<rev>`

Not supported in Phase 1:
- `https://en.wikipedia.org/w/index.php?title=<Title>` form
- `?curid=<pageid>` form
- non-`en` Wikipedias

## Repository Layout

```
main.js                          Wikipedia user script (single-class IIFE)
core/                            Pure-logic ESM modules spliced into main.js
bin/, cli/                       `npx ccs verify` CLI entry point
benchmark/                       Benchmark suite (Node.js)
  extract_dataset.js               Extract claim/source pairs from Wikipedia
  run_benchmark.js                 Run LLM verification on the dataset
  analyze_results.js               Metrics and confusion matrices
  generate_comparison.js           CSV comparison across providers
  dataset.json                     Ground-truth claim-citation pairs
Benchmarking_data_Citations.csv  Source ground-truth data
docs/                            Reference docs and design plans (see docs/README.md)
```

## Architecture

- **Single class:** `WikipediaSourceVerifier` wrapped in an IIFE — no build step, no modules
- **Pure ES6+ browser JS:** runs directly in the Wikipedia page context (no Node.js APIs)
- **Provider abstraction:** each provider has an entry in `this.providers` and a `callXxxAPI()` method; `callProviderAPI()` routes between them
- **CORS proxy:** sources fetched via `publicai-proxy.alaexis.workers.dev`
- **UI:** OOUI (OOjs UI) buttons and dialogs, lazy-loaded through MediaWiki; CSS injected at runtime via `createStyles()`
- **State:** class instance variables plus user preferences in `localStorage`

See `CLAUDE.md` for a table of key methods and more detail.

## Benchmark Suite

The benchmark suite evaluates provider accuracy against a curated dataset of 76 Wikipedia citations with human-labeled verdicts.

```bash
cd benchmark
npm install

npm run extract           # Extract dataset from Wikipedia
npm run extract:dry       # Dry-run extraction
npm run benchmark         # Run benchmarks on all providers
npm run benchmark:publicai  # Run a specific provider
npm run analyze           # Calculate metrics
npm run report            # Generate a markdown report
```

Required environment variables:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Claude |
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` | Gemini |
| `PUBLICAI_API_KEY` | PublicAI models |

See [`benchmark/README.md`](benchmark/README.md) for the full workflow, including manual-review and resume instructions.

## Development

- No CI/CD and no linter; `core/*.js` has a `node:test` suite (`npm test`), and end-to-end validation is via the benchmark suite
- Edit `main.js` directly; test by loading it on Wikipedia (via the user-script page or a browser-console `importScript` call)
- For testing changes before release, use [`User:Alaexis/AI_Source_Verification_test.js`](https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification_test.js), which tracks the dev branch
- Feature branches off `main`, merged via pull requests
- To add a new provider: add an entry to `this.providers` in the constructor, implement `callXxxAPI()`, and add routing in `callProviderAPI()`

## Constraints to Keep in Mind

- `main.js` runs in the browser — no Node.js APIs, no ES modules, no npm packages
- All external fetches must go through the CORS proxy
- OOUI components must be loaded via `mw.loader.using()` before use
- API keys live in `localStorage`, never in source
- The system prompt contains 9 tuned few-shot examples; edits affect benchmark accuracy
- Claim extraction uses "between adjacent citations" logic by design (not full sentences) for precision

## `core/` and the sync script

Pure-logic functions (prompt building, verdict parsing, URL extraction, claim
extraction, provider dispatch, worker proxy calls) live in `core/*.js` as ESM
modules and are tested with `node:test`:

```sh
npm install
npm test
```

`main.js` is a Wikipedia userscript with no module system, so `core/` is also
spliced into it by `scripts/sync-main.js`:

```sh
npm run build            # regenerate main.js from core/
npm run build -- --check # fail if main.js is stale (for CI)
```

The injected region in `main.js` is framed by `// <core-injected>` and
`// </core-injected>` markers — do not edit between them by hand; edit the
file in `core/` and rerun `npm run build`.

Class methods on `WikipediaSourceVerifier` that correspond to `core/` functions
are thin wrappers; the bodies live in `core/`. The rest of `main.js` — UI,
event handlers, MediaWiki integration — is hand-maintained as before.
