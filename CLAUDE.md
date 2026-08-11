# CLAUDE.md

Last verified: 2026-05-06

## Project Overview

Wikipedia citation verification user script. An AI-powered sidebar tool that lets Wikipedia editors verify whether citations actually support the claims they're attached to. Users click citation numbers, the tool fetches source content via a CORS proxy, sends claim+source to an LLM, and displays a verdict (Supported / Partially Supported / Not Supported / Source Unavailable).

**Repository:** `alex-o-748/citation-checker-script`

## Project Structure

```
main.js                          # Main Wikipedia user script (~2,700 lines, single class)
package.json                     # Top-level deps + `npm test` / `npm run build` scripts
core/                            # Shared pure logic, imported by both benchmark/ and main.js (via sync)
  claim.js, feedback.js, parsing.js, prompts.js, providers.js, quote.js, submission.js, urls.js, worker.js
cli/verify.js                    # Node CLI front-end (verify a single citation from the command line)
bin/ccs                          # Executable shim for the CLI
scripts/sync-main.js             # Inlines core/ modules into main.js for the userscript build
tests/                           # `node --test` suite (run via `npm test`)
benchmark/
  package.json                   # Benchmark-only deps
  extract_dataset.js             # Extract claim/source pairs from Wikipedia
  run_benchmark.js               # Run LLM verification on dataset (parallelized; see Benchmark Suite)
  analyze_results.js             # Calculate metrics and confusion matrices
  generate_comparison.js         # Generate comparison CSV
  compare_results.js             # Pure-ESM comparison engine for two results.json runs (control vs treatment)
  render_compare.js              # JSON / Markdown / self-contained HTML renderers for ComparisonResult
  dataset.json                   # Current dataset (189 entries: v1: 76 + v2: 34 + v3: 79; counts drift as rows are added)
  dataset_v1.json                # Frozen v1 snapshot for reproducing original analysis
  dataset_v3.json                # Frozen v3 snapshot (post strict-rubric audit, 2026-04-30)
  results.json                   # Raw benchmark results
  results_v1.json                # Frozen v1 results snapshot
  results_v3.json                # Frozen v3 results snapshot
  analysis.json                  # Calculated metrics
  analysis_v1.json               # Frozen v1 analysis snapshot
  analysis_v3.json               # Frozen v3 analysis snapshot
Benchmarking_data_Citations.csv  # Source ground truth data (Dataset version + WMF override columns)
.github/workflows/               # Scheduled talk-page scraper (not test/build CI)
docs/                            # Reference docs + design plans (see docs/README.md)
```

## Architecture

- **Single class pattern:** `WikipediaSourceVerifier` in an IIFE wraps all functionality
- **No build system:** Pure ES6+ JavaScript loaded directly as a Wikipedia user script
- **Event-driven:** DOM event listeners and OOUI button callbacks
- **Provider abstraction:** Multiple AI providers (Claude, Gemini, OpenAI, PublicAI/Qwen/OLMo/Apertus) with unified interface
- **CORS proxy:** Source content fetched via `publicai-proxy.alaexis.workers.dev`
- **State:** Class instance variables; user preferences in `localStorage`

## Code Conventions

- `'use strict'` mode
- Class-based OOP with camelCase methods/properties
- Async/await for all API calls and async operations
- CSS-in-JS via `createStyles()` method (no external stylesheets)
- OOUI (OOjs UI) for buttons and dialogs, lazy-loaded via MediaWiki
- Error handling with try-catch; rate limiting with exponential backoff for 429s
- Inline comments for non-obvious logic

## Key Methods in main.js

| Method | Purpose |
|--------|---------|
| `constructor()` | Initialize providers, state, UI |
| `createUI()` / `createStyles()` | Build sidebar HTML and CSS |
| `createOOUIButtons()` | Provider selector, verify/report buttons |
| `attachReferenceClickHandlers()` | Handle citation [N] clicks |
| `extractClaimText()` | Extract claim text between adjacent citations |
| `fetchSourceContent()` | Fetch source via CORS proxy |
| `ensurePdfJs()` / `extractPdfText()` / `handlePdfFileSelected()` | PDF upload for offline sources: lazily load PDF.js (pinned UMD build from cdnjs), pull the text layer, and feed it into the manual-source-text pipeline (empty text ⇒ "looks scanned, paste instead") |
| `generateSystemPrompt()` / `generateUserPrompt()` | Build LLM prompts |
| `buildQuoteView()` / `quoteHtml()` | Verify the model's `source_quote` against the source text and render it as an evidence block (see "Source quotes" below) |
| `verifyClaim()` | Single citation verification flow |
| `callProviderAPI()` / `callProviderAPIGroup()` | Route to provider-specific API (single source / collective multi-source) |
| `verifyAllCitations()` | Batch verify all article citations |
| `verifyGroupCollective()` | Collective verdict for an adjacent-citation group (combines the group's sources into one LLM call; see `docs/design-plans/2026-06-23-collective-group-verification.md`) |
| `getReportUnits()` | Merge per-source results + collective group verdicts into one entry per claim (drives summary pills + exports) |
| `generateWikitextReport()` | Generate wiki markup for failed citations |
| `buildQuoteView()` / `quoteHtml()` | Verify the model's `source_quote` against the source text and render it as an evidence block (see "Source quotes" below) |
| `logVerification()` | Mint a `check_id`, log the verdict + claim + rationale + source quote to the worker, return the id |
| `buildFeedbackControls()` | Yes/No/Comment row under a result; ratings go to Neon, comments to the talk page (see `docs/worker-logging-reference.md`) |

## Benchmark Suite

```bash
cd benchmark
npm install

# Available npm scripts:
npm run extract               # Extract dataset from Wikipedia (all rows)
npm run extract:dry           # Dry-run extraction
npm run extract:v1            # Extract only original v1 rows (reproducing baseline)
npm run extract:v3            # Extract only v3 (WMF) rows
npm run benchmark             # Run benchmarks on all providers (all rows)
npm run benchmark:publicai    # Run specific provider
npm run benchmark:v1          # Run benchmark on v1 entries only
npm run benchmark:v3          # Run benchmark on v3 entries only
npm run analyze               # Analyze results
npm run analyze:v1            # Analyze results filtered to v1 entries
npm run analyze:v1-snapshot   # Re-derive analysis from frozen v1 snapshots
npm run analyze:v3            # Analyze results filtered to v3 entries
npm run analyze:v3-snapshot   # Re-derive analysis from frozen v3 snapshots
npm run report                # Generate markdown report
npm run compare               # Compare two results.json runs (delegates to `ccs compare`; see docs/comparing-benchmark-runs.md)
```

### Module system and shared logic

`benchmark/` is ESM (`"type": "module"` in `benchmark/package.json`) and imports `extractClaimText` from `../core/claim.js`. Editing claim-extraction logic in `core/` automatically affects both the userscript (`main.js`, via the sync script) and the benchmark — no second copy to keep in sync.

`benchmark/compare_results.js` and `benchmark/render_compare.js` are self-contained — they take already-loaded `results.json` / `dataset.json` shapes and don't import from `core/`. The `ccs compare` CLI in `cli/compare.js` is the file-IO layer that wires them up.

**Required environment variables:**
- `ANTHROPIC_API_KEY` - Claude
- `OPENAI_API_KEY` - OpenAI
- `GEMINI_API_KEY` - Gemini
- `PUBLICAI_API_KEY` - PublicAI models

## Development Workflow

- **Tests:** `node --test` via `npm test` from the repo root, runs everything in `tests/**/*.test.js`. New helpers should get a sibling `*.test.js` file. Behavioral validation also goes through the benchmark suite against the human-labeled citation dataset.
- **No test/build CI** is wired up (the only GitHub Actions workflow is a scheduled talk-page scraper).
- **No linter** configured
- **Branching:** Feature branches off `main`, merged via pull requests
- **Deployment:** Deployed as a Wikipedia User Script (`User:Alaexis/AI_Source_Verification`) with USync for auto-updates

## Important Constraints

- `main.js` runs in the Wikipedia browser context — no Node.js APIs, no ES modules, no npm packages
- All external fetches must go through the CORS proxy
- OOUI components must be loaded via `mw.loader.using()` before use
- API keys are stored in `localStorage`, never hardcoded
- The system prompt contains carefully tuned few-shot examples — changes affect benchmark accuracy
- Claim extraction uses "between citations" logic by design (not full sentences) for precision

### Benchmark row_id fragility (read before reordering the CSV)

`extract_dataset.js` derives each row's stable id as `row_<csv_line>`, where `csv_line` is the line number in `Benchmarking_data_Citations.csv` (`_rowIndex = index + 2`, accounting for the header). Two consequences a future regenerate must handle:

1. **Any CSV reorder shifts every id at or after the insertion point.** Inserting a row at line 50 shifts every row 50+ by +1 in `dataset.json`. Removing a blank/empty line does the same in reverse.
2. **`results.json` (and any other artifact storing `entry_id`) is NOT automatically remapped** when `dataset.json` is regenerated. The entries keep their old ids and silently misalign with the new dataset.

When you regenerate `dataset.json` after a CSV reorder, you must also walk `results.json` and update each entry's `entry_id` to the new value. The 2026-05-01 `a4973d7` regenerate caught the v3 +33 shift but missed a parallel −1 shift on the v1 rows around the v2 insertion boundary — the resulting misalignment was found two weeks later (rows 75/76/77 in `results.json` had content from what is now rows 74/75/76 in `dataset.json`). A content-based audit (match the entry's `comments` against current `claim_text` candidates) is reliable for catching this.

A stable-id refactor (content hash, or a CSV-supplied id column independent of line number) would eliminate the class of bug entirely.

### Source quotes are verified before they are shown (read before touching quote display)

The model returns a `source_quote` field alongside its verdict — the passage
from the source that supports or contradicts the claim. **It is not trusted.**
`core/quote.js` looks the quote up in the source text the model was shown, and
only a quote that is actually found there is displayed as evidence or exported
to a wikitext report.

| Status | Meaning | Shown? |
| --- | --- | --- |
| `exact` / `normalized` | Found in the source (the second after folding case, quote style, dashes, whitespace) | Yes, as a quote |
| `partial` | Some ellipsis-joined segments found, others not | No — caution line |
| `not-found` | Not in the source: paraphrased or invented | No — caution line |
| `too-short` | Below the evidence threshold (12 normalized chars) | No — caution line |
| `empty` | No quote offered — correct for omission and SOURCE UNAVAILABLE | Nothing rendered |
| `no-source` | No source text available to check against | No — caution line |

Matching is normalized but **not** fuzzy: no edit distance, no token overlap.
The design accepts missing some genuine quotes in exchange for never showing a
fabricated one. If you loosen this, you are trading away the property the
feature exists for.

`quoteExpectedFor(verdict, reasonType)` decides whether a missing or
unverifiable quote is worth flagging: omission and SOURCE UNAVAILABLE verdicts
have nothing to quote, so a stray quote there is ignored rather than warned
about.

The **verification log is the exception**: `logVerification()` records
`source_quote` and `quote_status` on every row regardless of outcome. The UI
hides an unverified quote because showing it would mislead an editor; the log
keeps it because a `not-found` row is precisely the one worth inspecting later.
Don't "tidy" this into dropping unverified quotes at the log boundary — that
would delete the signal the column exists to carry.

Quoted source text is arbitrary web prose. It goes through `escapeHtml()` into
the panel and `escapeWikitableCell()` (pipes, braces, newlines) into a
wikitable — never raw.

Rationale and the outstanding benchmark re-run: `docs/design-plans/2026-08-04-source-quote-extraction.md`.

### UI localization — every user-facing string goes through `this.t()`

The sidebar UI is localized (currently French and Spanish); the LLM prompts in `core/prompts.js` stay English, because the few-shot examples are tuned against the benchmark. Three pieces in `main.js`, all just above the `WikipediaSourceVerifier` class:

| Piece | Holds |
|-------|-------|
| `FR_MESSAGES` / `ES_MESSAGES` | Translations, keyed by the **English source string** |
| `MESSAGES` / `PROMPT_LANGUAGES` | Registry of language code → table, and → the language's name as given to the LLM |
| `detectUiLang()` | Maps `wgContentLanguage` (then `wgUserLanguage`) to a registry key, else `'en'` |

`this.t('Verify Claim')` looks the string up in the active table and falls back to the English key, so a missing translation degrades to English rather than showing a key. Interpolate with `{name}` placeholders: `this.t('Set {name} API Key', { name })`.

**To add a user-facing string:** wrap it in `this.t()` and add it to *every* table. **To add a language:** write its table, register it in `MESSAGES` and `PROMPT_LANGUAGES`; `detectUiLang()` and `localizeSystemPrompt()` pick it up with no further wiring.

**Register:** Spanish never addresses the reader in the second person — `tú`, `vos` and `usted` are each regionally marked, so es.wikipedia's own interface avoids all three. Which impersonal form to use depends on what the string *is*:

| String is | Register | Example |
|-----------|----------|---------|
| An action label — button, link, menu item, input placeholder | Bare infinitive | `Subir un PDF`, `Pegar aquí el texto de la fuente…` |
| A sentence of running prose | Impersonal `se`, or a framing verb | `Se puede hacer clic en…`, `Conviene leer la fuente…` |

A bare infinitive reads as a clipped fragment once it has to carry a whole sentence, which is why the two cases differ. French uses the `vous` imperative throughout, matching fr.wikipedia.

`tests/i18n.test.js` enforces this: it fails if the tables disagree on their key set, if a translation drops or renames a `{placeholder}`, if a literal `this.t()` key in `main.js` is untranslated, if a Spanish string slips into the second person, or if language detection stops resolving regional variants (`es-419`) while correctly ignoring codes that merely share a prefix (`frr`, `frp`).

### Styling is token-driven — never write a theme-specific rule (read before touching CSS)

Styles live in three methods in `main.js`:

| Method | Holds |
|--------|-------|
| `styleTokens(accent)` | Every literal color, as `--sv-*` custom properties, in a `light` and a `dark` block |
| `darkOnlyStyles(root, accent)` | The few rules a token swap can't express — OOUI widget overrides and icon `filter: invert()` — emitted once per dark signal |
| `createStyles()` | All component rules, referencing colors **only** via `var(--sv-*)` |

Wikipedia exposes two independent dark signals: `html.skin-theme-clientpref-night` (explicit night theme) and `@media (prefers-color-scheme: dark) { html.skin-theme-clientpref-os }` ("follow OS" plus a dark OS). Both are fed from the *same* `tokens.dark` string, so they cannot drift apart.

**To add or restyle a component:** write one rule in `createStyles()` using `var(--sv-*)`. If you need a color that doesn't exist yet, add it to *both* the `light` and `dark` blocks of `styleTokens()`. That is the whole procedure — dark mode follows automatically, including `:hover` backgrounds, which previously had to be mirrored by hand.

Do **not** add `html.skin-theme-clientpref-*` selectors to `createStyles()`. If a rule seems to need one, it almost certainly needs a new token instead; `darkOnlyStyles()` is reserved for properties that aren't colors we control.

Provider-tinted values use the `--sv-accent` token, which tracks `getCurrentColor()`. `createStyles()` re-runs on provider change and replaces its own `<style id="source-verifier-styles">` rather than stacking a new one.

`tests/styles.test.js` enforces this: it generates the stylesheet and fails if a `var(--sv-*)` has no definition, if the two dark blocks diverge, or if `createStyles()` hardcodes a hex color. That test is the guard against the dark-mode drift this section used to describe as a recurring bug.

## Common Tasks

**Modifying the user script:** Edit `main.js` directly. Test by loading on Wikipedia via the browser console or user script page.

**Adding a new LLM provider:** Add provider config to `this.providers` in the constructor, implement a `callXxxAPI()` method, and add routing in `callProviderAPI()`.

**Updating the benchmark:** Edit `dataset.json` or re-extract with `npm run extract`, then run `npm run benchmark` and `npm run analyze`. Results carry `source_quote` / `quote_status` / `quote_verified` per row; `npm run analyze` reports per-provider quote offer rate and fidelity (share of offered quotes actually found in the source).

**Comparing two benchmark runs:** `npx ccs compare <control.json> <treatment.json> --dataset <dataset.json>` (or `npm run compare -- ...` from `benchmark/`). Emits JSON / Markdown / HTML with per-provider accuracy deltas and flip counts; supports subset filters and a `--noise-floor` threshold. See `docs/comparing-benchmark-runs.md`.

**Running tests:** `npm test` from the repo root. Tests use `node:test` + `node:assert/strict` and import the modules they cover directly — a script that runs work on import (e.g. `main()` at module load) needs to gate that behind `if (process.argv[1] === fileURLToPath(import.meta.url))` so importing it for tests doesn't trigger the runner. `extract_dataset.js` and `benchmark/run_benchmark.js` follow this pattern.
