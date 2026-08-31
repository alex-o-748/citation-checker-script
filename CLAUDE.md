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
  wice.js                        # Pure WiCE -> dataset-row transform (external benchmark; see below)
  convert_wice.js                # Fetch + convert WiCE into dataset_wice.json (gitignored, regenerate with npm run wice:convert)
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
service/                         # Toolforge batch pipeline: select -> extract -> fetch -> verify -> store (see Batch Pipeline below)
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

# WiCE — external benchmark (see docs/wice-benchmark.md)
npm run wice:convert          # Fetch + convert WiCE dev+test -> dataset_wice.json
npm run wice:benchmark        # Run providers against dataset_wice.json
npm run wice:analyze          # Metrics for the WiCE run
npm run wice:analyze:unanimous  # Score only rows whose label isn't a projection artifact
```

`run_benchmark.js` and `analyze_results.js` both take `--dataset` / `--results` (and the analyzer `--analysis`), which is what lets an alternate corpus run without touching `dataset.json` / `results.json`.

### WiCE (external benchmark)

`benchmark/dataset_wice.json` is [WiCE](https://github.com/ryokamoi/wice) (Kamoi et al., EMNLP 2023) converted to our row schema — 707 human-labeled Wikipedia claim/source pairs nobody on this project selected or annotated. It is deliberately a **separate file**, never merged into `dataset.json`: merging would disturb the frozen v1/v3 snapshots, and WiCE's label mix is unrepresentative by design, so pooling would silently change what headline accuracy means.

It is **gitignored and regenerated** (`npm run wice:convert`), not committed — 7 MB, and deterministically rebuildable byte-for-byte, with a sha256 in its metadata to prove it. `dataset.json` is committed for the opposite reason: live Wikipedia and live source fetches make it unreproducible.

**Read `docs/wice-benchmark.md` before quoting a WiCE number.** The one thing to know going in: WiCE's annotators labeled *subclaims*, and claim-level labels are projected from them (all-supported → supported, all-not-supported → not-supported, anything mixed → partially-supported). That rule is not our rubric, and it is why ~57% of rows are `Partially supported`. The converter therefore records `wice_label_projection` per row — `unanimous` (subclaims agreed; the label means what ours means) or `mixed` (the label is an artifact of the rule) — and `analyze_results.js --projection unanimous|mixed` scores either subset. A verifier that does well on `unanimous` and badly on `mixed` is likely applying our rubric correctly and being marked wrong by WiCE's projection.

WiCE also has no `Source unavailable` rows and ships frozen 2023 Common Crawl evidence rather than live URLs, so a WiCE run exercises the prompt and model but **not** the CORS-proxy fetch path.

### Module system and shared logic

`benchmark/` is ESM (`"type": "module"` in `benchmark/package.json`) and imports `extractClaimText` from `../core/claim.js`. Editing claim-extraction logic in `core/` automatically affects both the userscript (`main.js`, via the sync script) and the benchmark — no second copy to keep in sync.

`benchmark/compare_results.js` and `benchmark/render_compare.js` are self-contained — they take already-loaded `results.json` / `dataset.json` shapes and don't import from `core/`. The `ccs compare` CLI in `cli/compare.js` is the file-IO layer that wires them up.

**Required environment variables:**
- `ANTHROPIC_API_KEY` - Claude
- `OPENAI_API_KEY` - OpenAI
- `GEMINI_API_KEY` - Gemini
- `PUBLICAI_API_KEY` - PublicAI models

## Batch Pipeline (`service/`)

A separate, Toolforge-hosted pipeline that runs citation verification unattended, at scale, over a queue of articles rather than one citation a user clicked — the WMF "Edit Suggestions" integration described in `docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md`. It imports `core/` directly (like `benchmark/` and `cli/` do) and shares no code with `main.js` beyond that.

**Now a single runnable pipeline** (`service/run-sweep.js`, landed 2026-08-24): select → extract → fetch → verify → assemble → CSV, in one command. Every stage is built; source fetching (stage 3) is still stubbed by default, so a default run's findings are all `SOURCE UNAVAILABLE` until `--live-source-fetch` is passed. That flag needs no permission for a small, attended run from anywhere with open internet — only unattended, production-volume fetching *from Toolforge itself* waits on WMCS (see `docs/design-plans/2026-08-24-csv-deliverable-and-component-names.md`'s G3). See that doc for what else is still open (the publication filter; the read API stage 6 was originally specified as).

One noun per component; anything runnable is prefixed `run-`:

| Stage | Component | File | Does |
|---|---|---|---|
| 1 Select | **Article Picker** | `service/article-picker.js` + `service/replicas.js` | Builds and runs the Wiki Replicas query that picks candidate articles (e.g. pages carrying `{{Failed verification}}`) |
| 2 Extract | **Claim Extractor** | `service/claim-extractor.js` | Fetches an article's rendered HTML at a pinned revision and pulls out each citation's claim text, `<ref name="...">` when present, and adjacent-citation group metadata (`core/citations.js`) |
| 3 Fetch | **Source Fetcher** | `tf-source-fetcher` (separate Toolforge tool), reached via `core/worker.js` | Retrieves the cited source's content. **Stubbed by default** — unattended fetching of third-party URLs from Toolforge isn't yet cleared with WMCS; opt in per-run with `--live-source-fetch` |
| 4 Verify | **Verifier** | `service/verifier.js` | One model call per claim → verdict (`verifyCitation`), plus one collective call per adjacent-citation group (`verifyGroup`, using `core/groups.js`'s dedup/skip rules — shared with the userscript's own group verification) — via `core/prompts.js` / `core/providers.js` / `core/parsing.js`. Calls the **LLM Router** (`tf-llm-router`, a separate Toolforge tool) for the model call itself. Halts the whole run (doesn't just log) on a 401/402/403 from the model, so a spent API budget can't silently turn into a queue of wrong "source unavailable" rows |
| 5 Store | **Finding Builder** + **Findings Store** | `service/finding-builder.js` + `service/findings-store.js` + `service/toolsdb.js` | Turns a verdict (solo or collective — `assembleFinding` / `assembleGroupFinding`) into a row (claim hash, TTL, `published:false` pending a precision threshold — see the design doc) and upserts it into ToolsDB's `citation_findings` table |
| 6 Report | **Findings Report** | `service/csv-report.js` | Turns computed findings into a shareable CSV — the default sink for `service/run-sweep.js`. A read API (the parent design's original stage 6 spec) is still gated on the Suggestions team answering how claim text maps to a wikitext location |

Runnable entry points, each a thin wiring layer over the components above:

| Runner | Does | Outbound network |
|---|---|---|
| `service/run-pick.js` | Stage 1 only, prints selected articles as JSON | Wiki Replicas |
| `service/run-extract.js` | Stages 1-3, prints a citations/URLs/fetched/failed funnel | Wiki Replicas, Wikipedia REST, source fetcher (opt-in) |
| `service/run-replay.js` | Stages 4-5 over `benchmark/dataset.json`'s stored claim/source pairs instead of live fetching — the integration test for verify+store with zero third-party requests | Model API only (+ Wikipedia REST to resolve page IDs) |
| `service/run-sweep.js` | **All six stages**, writing a CSV by default and (with `--store`) also upserting into ToolsDB | Wiki Replicas, Wikipedia REST, model API, source fetcher (opt-in) |

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
- `extractClaimText(refElement, { scope })` (`core/claim.js`) supports two claim scopes. `scope: 'paragraph'` (the default, used by `main.js` and the CLI/benchmark) is the full "between citations" span, which can include multiple sentences when the previous citation is more than one sentence back. `scope: 'sentence'` narrows that span to only its final sentence (via `lastSentence()`) — `core/citations.js`'s `collectCitations(root, { claimScope })` threads this through, and `service/claim-extractor.js`'s `processArticle()` defaults `claimScope` to `'sentence'` for the batch pipeline. This matters because in an unattended batch run, a multi-sentence claim where only the first sentence lacks support reads as a false NOT SUPPORTED on the whole span — there's no editor present to notice that only part of the claim is a "citation needed" case, not an "unsupported" one. The interactive userscript defaults to paragraph scope, where a human reads the full claim and isn't misled by that ambiguity — but it also exposes a "Claim scope" setting (Settings panel, persisted to `localStorage` as `verifier_claim_scope`) letting an editor switch to sentence scope for both single-citation checks and "Verify All Citations", for the same false-positive reason batch mode defaults to it.

### Claim extraction must not use DOM Range (read before touching `core/claim.js`)

`core/claim.js` walks the DOM directly (`textBetween`) to get the text between
two citation markers. The obvious implementation — a `Range` with
`setStartAfter` / `setEndBefore` / `toString()` — is what it used to do, and it
is a trap: **under JSDOM, every Range boundary comparison is O(document).**
jsdom's `isFollowing(a, b)` walks forward from `b` through the rest of the
document looking for `a`, so when `a` precedes `b` it scans to the end of the
page and returns false. `Range.toString()` runs that twice per text node, and
`setStart`/`setEnd` run it too.

Claim extraction calls this once per citation plus once per adjacent pair, so
the cost was **quadratic in article length**. Measured on Parsoid-shaped HTML:

| Citations | HTML | Range-based | Walk-based |
|---|---|---|---|
| 240 | 110 KB | 1.3 s | 18 ms |
| 480 | 220 KB | 6.0 s | 35 ms |
| 960 | 440 KB | 40.2 s | 67 ms |

A browser hides this completely — `Range` is native there, and the userscript
only ever handles one article — which is why the cost only appeared once the
same code was reused by the benchmark and the Toolforge batch runner.

Two tests in `tests/claim.test.js` pin it: one stubs `document.createRange()` to
throw (structural, deterministic), and one asserts per-citation cost stays flat
as the article grows 8× (catches any other O(document) step). Both fail against
the old implementation.

The remaining per-article cost is JSDOM parsing plus URL resolution, both
linear. If extraction needs to get faster again, that is where to look — not
here.

### Batch pipeline parses with `JSDOM.fragment()`, not `new JSDOM(html).window` (read before touching `parseHtml` or `core/citations.js`'s root handling)

`service/run-extract.js`, `service/ia-load-test.js`, and `service/run-sweep.js`
all parse article HTML with `JSDOM.fragment(html)` rather than
`new JSDOM(html).window.document`. This is deliberate, and going back to
`new JSDOM()` in a loop will OOM a batch run:

Constructing a full `Window`/browsing context (CSSOM, timers, navigator, the
works) retains several MB per article that `global.gc()` never reclaims —
measured at **~5.6 MB/article, growing perfectly linearly with no plateau**,
confirmed identical whether or not `.window.close()` is called, and confirmed
to reproduce with zero application code involved (bare `new JSDOM(html)` in a
loop, discarding the result, still leaks at the same rate). `JSDOM.fragment()`
skips building a `Window` entirely and measured flat (~0.07 MB/article,
noise) on the same workload — that's the actual fix, not anything in
`core/claim.js` or `core/citations.js`. At a few hundred articles in one
process, `new JSDOM()` is a multi-GB leak; Toolforge job pods don't have
that.

This is *why* `collectCitations(root)` (`core/citations.js`) resolves its
`doc` with `typeof root.getElementById === 'function' ? root : root.ownerDocument`
rather than the simpler `root.ownerDocument || root` it used to have. A
`DocumentFragment`'s `.ownerDocument` is a separate, empty shell document —
the fragment's own content was never attached to it — so
`fragment.ownerDocument.getElementById(id)` silently returns `null` for an id
that's right there in the fragment, which breaks URL and page-number
resolution (both look up the footnote by id from the inline citation marker).
Calling `getElementById` on the fragment itself works correctly; a
`DocumentFragment` supports it directly, same as `Document` does — only a
plain `Element` root (the userscript's `#mw-content-text` case) lacks it and
needs `.ownerDocument`. The `typeof` check dispatches correctly for all three
root shapes `collectCitations` is ever called with.

`tests/citations.test.js` pins a `JSDOM.fragment()` root resolving URL and
page number correctly — it fails against the old `root.ownerDocument || root`
logic (returns 0 citations found, silently, not an error) and passes against
the current one.

The userscript (`main.js`) is unaffected: it only ever processes the one
article it's running inside, in a real browser where the `new JSDOM()` leak
doesn't apply and `#mw-content-text` is always an `Element` root, not a
`Document` or `DocumentFragment`.

### Benchmark row_id fragility (read before reordering the CSV)

`extract_dataset.js` derives each row's stable id as `row_<csv_line>`, where `csv_line` is the line number in `Benchmarking_data_Citations.csv` (`_rowIndex = index + 2`, accounting for the header). Two consequences a future regenerate must handle:

1. **Any CSV reorder shifts every id at or after the insertion point.** Inserting a row at line 50 shifts every row 50+ by +1 in `dataset.json`. Removing a blank/empty line does the same in reverse.
2. **`results.json` (and any other artifact storing `entry_id`) is NOT automatically remapped** when `dataset.json` is regenerated. The entries keep their old ids and silently misalign with the new dataset.

When you regenerate `dataset.json` after a CSV reorder, you must also walk `results.json` and update each entry's `entry_id` to the new value. The 2026-05-01 `a4973d7` regenerate caught the v3 +33 shift but missed a parallel −1 shift on the v1 rows around the v2 insertion boundary — the resulting misalignment was found two weeks later (rows 75/76/77 in `results.json` had content from what is now rows 74/75/76 in `dataset.json`). A content-based audit (match the entry's `comments` against current `claim_text` candidates) is reliable for catching this.

A stable-id refactor (content hash, or a CSV-supplied id column independent of line number) would eliminate the class of bug entirely.

### Source quotes are verified before they are shown (read before touching quote display)

The model returns a `source_quote` field alongside its verdict — the passage
from the source that supports or contradicts the claim. **It is not trusted.**
`core/quote.js` looks the quote up in the source text the model was shown.
**Renderers display `verifiedText`, never `quote`** — the former is only the
part actually located, so every character on screen came from the source.

| Status | Meaning | Shown? |
| --- | --- | --- |
| `exact` / `normalized` | Found in the source (the second after folding case, quote style, dashes, hyphenation, whitespace) | Yes, whole |
| `partial` | Some ellipsis-joined fragments found, others not | Yes — the found fragments, ellipsis-joined |
| `not-found` | Not in the source: paraphrased or invented | Nothing rendered |
| `too-short` | Below the evidence threshold (12 normalized chars) | Nothing rendered |
| `empty` | No quote offered — correct for omission and SOURCE UNAVAILABLE | Nothing rendered |
| `no-source` | No source text available to check against | Nothing rendered |

**The panel never warns about a quote it could not locate — it just says
nothing.** A warning there would imply the verdict is less trustworthy, and
that is a claim no one has measured: a model that paraphrases instead of
copying may be judging perfectly well, and steering an editor away from a
correct verdict is a real cost paid for a speculative benefit. A partial match
is presented identically to a full one, because the block makes exactly one
promise — *this text is in the source* — and it holds either way.

`npm run analyze` reports verdict accuracy split by whether the quote verified,
with the gap between them. If that gap turns out to be large, the warning has
earned its place and can come back; until then it stays out.

`QUOTE_STATUSES` / `QUOTE_STATUS_LIST` in `core/quote.js` are the source of
truth for that vocabulary. It is **not** client-only: `quote_status` is written
to Neon, and the Worker (`alex-o-748/public-ai-proxy`, `src/index.js`)
validates it against a hardcoded copy, storing `NULL` for anything unrecognized.
Adding a status is therefore a two-repo change; `tests/quote.test.js` pins the
list so it can't be done by accident.

Normalization also folds PDF ligatures (via NFKC), the modifier-letter
apostrophe, and a trailing `[.,;:]` the model added when closing a quotation —
in the last case `verifiedText` carries the *trimmed* form, so what is shown is
still exactly what the source contains. Three artifacts stay deliberately
unmatched, with tests pinning them: letter-spaced headings, words split by an
inline tag (`Kille<em>brew</em>` → `Kille brew` — fix that in the proxy, not
here), and bracketed insertions like `[sic]`. All three would need
space-insensitive or content-removing matching, under which unrelated passages
start matching.

Matching is normalized but **not** fuzzy: no edit distance, no token overlap.
The design accepts missing some genuine quotes in exchange for never showing a
fabricated one. If you loosen this, you are trading away the property the
feature exists for.

Normalization decodes HTML entities before folding characters. The CORS
proxy's `extractText()` decodes only `&nbsp; &amp; &lt; &gt;`, so a WordPress
source reaches the model as `the mall&#8217;s` — and the model, reading that as
an apostrophe, quotes it back decoded. Comparing the raw entity against the
character it denotes is a false mismatch, so both sides are decoded first.
(The proxy is the better place to fix this, since the model shouldn't be
reading entities either; the client-side decode is what makes verification
correct regardless of who extracted the text.)

Normalization also folds a hyphen followed by whitespace (`-\s+` → `-`). PDF and OCR
text layers break words across lines and leave the hyphen behind
(`school-\nlike`), and a model copying such a passage repairs some of them and
not others *within one quote* — which is what made a real NRHP-sourced check
come back `partial` with nothing displayed. The fold is symmetric, so it can
only make a genuine quote match.

Two fields differ in a way that matters: `found` decides the verdict, `located`
records whether a fragment was really seen. They diverge only for fragments too
short to judge, which are forgiven but must never reach `verifiedText`.

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

The sidebar UI is localized (currently French, Spanish, and Russian); the LLM prompts in `core/prompts.js` stay English, because the few-shot examples are tuned against the benchmark. Three pieces in `main.js`, all just above the `WikipediaSourceVerifier` class:

| Piece | Holds |
|-------|-------|
| `FR_MESSAGES` / `ES_MESSAGES` / `RU_MESSAGES` | Translations, keyed by the **English source string** |
| `MESSAGES` | Registry of language code → table |
| `detectUiLang()` | Maps `wgContentLanguage` (then `wgUserLanguage`) to a registry key, else `'en'` |
| `detectArticleLangCode()` | The wiki's raw content-language code, unrestricted to `MESSAGES` keys — feeds `localizeSystemPrompt()` only |

`PROMPT_LANGUAGES` (language code → the language's name as given to the LLM) and `localizeSystemPrompt()` itself live in `core/prompts.js`, not `main.js` — moved there 2026-08-31 so the batch pipeline could share them (below), not just the interactive userscript. `main.js`'s own `localizeSystemPrompt(prompt)` method is a one-line delegation to the injected core function, passing `this.lang` and `this.articleLangCode` — same pattern as `generateSystemPrompt()`.

`this.t('Verify Claim')` looks the string up in the active table and falls back to the English key, so a missing translation degrades to English rather than showing a key. Interpolate with `{name}` placeholders: `this.t('Set {name} API Key', { name })`.

**To add a user-facing string:** wrap it in `this.t()` and add it to *every* table. **To add a language:** write its table, register it in `MESSAGES` (`main.js`) and `PROMPT_LANGUAGES` (`core/prompts.js`); `detectUiLang()` and `localizeSystemPrompt()` pick it up with no further wiring.

**LLM comment language is not gated on a full UI translation.** `localizeSystemPrompt()` names the language explicitly for a curated code (`fr`/`es`/`ru`, via `PROMPT_LANGUAGES`, matching the sidebar), but for any other non-English wiki — one with no `MESSAGES` table at all — it falls back to a generic "write in the same language as the claim and source text" directive driven by `detectArticleLangCode()`. So a claim checked on, say, de.wikipedia gets German comments even though the sidebar itself stays English. Only `source_quote` is exempt in all cases: it must stay verbatim in the source's own language, since it's checked character-for-character against the source text.

**The batch pipeline localizes too, from a single wiki language code.** `service/verifier.js`'s `verifyCitation()` / `verifyGroup()` take an optional `langCode`, passed to `localizeSystemPrompt(prompt, { lang: langCode, articleLangCode: langCode })` — the same function `main.js` calls, just with one code filling both params instead of two (there's no separate "UI language" in a script with no sidebar). `service/run-sweep.js` derives it from `--wiki` via `core/wikipedia.js`'s `langCodeForWikiDb()` (`ruwiki` → `'ru'`) and threads it into every `verifyCitation()`/`verifyGroup()` call. Before this, a batch run's `comments` came back in English regardless of which wiki was being checked — found via a real `--wiki ruwiki` run whose CSV showed English rationale next to Russian claims.

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
