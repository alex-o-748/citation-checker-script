# CLAUDE.md

## Project Overview

Wikipedia citation verification user script. An AI-powered sidebar tool that lets Wikipedia editors verify whether citations actually support the claims they're attached to. Users click citation numbers, the tool fetches source content via a CORS proxy, sends claim+source to an LLM, and displays a verdict (Supported / Partially Supported / Not Supported / Source Unavailable).

**Repository:** `alex-o-748/citation-checker-script`

## Project Structure

```
main.js                          # Main Wikipedia user script (~2,700 lines, single class)
benchmark/
  package.json                   # Node.js deps (jsdom)
  extract_dataset.js             # Extract claim/source pairs from Wikipedia
  run_benchmark.js               # Run LLM verification on dataset
  analyze_results.js             # Calculate metrics and confusion matrices
  generate_comparison.js         # Generate comparison CSV
  dataset.json                   # 76 claim-citation pairs (ground truth)
  results.json                   # Raw benchmark results
  analysis.json                  # Calculated metrics
Benchmarking_data_Citations.csv  # Source ground truth data
*.md                             # Documentation and research notes
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
| `generateSystemPrompt()` / `generateUserPrompt()` | Build LLM prompts |
| `verifyClaim()` | Single citation verification flow |
| `callProviderAPI()` | Route to provider-specific API |
| `verifyAllCitations()` | Batch verify all article citations |
| `generateWikitextReport()` | Generate wiki markup for failed citations |

## Benchmark Suite

```bash
cd benchmark
npm install

# Available npm scripts:
npm run extract        # Extract dataset from Wikipedia
npm run extract:dry    # Dry-run extraction
npm run benchmark      # Run benchmarks on all providers
npm run benchmark:publicai  # Run specific provider
npm run analyze        # Analyze results
npm run report         # Generate markdown report
```

**Required environment variables:**
- `ANTHROPIC_API_KEY` - Claude
- `OPENAI_API_KEY` - OpenAI
- `GEMINI_API_KEY` - Gemini
- `PUBLICAI_API_KEY` - PublicAI models

## Development Workflow

- **No CI/CD** configured
- **No test framework** — validation is via the benchmark suite against 76 human-labeled citation pairs
- **No linter** configured
- **Branching:** Feature branches off `main`, merged via pull requests
- **Deployment:** Deployed as a Wikipedia User Script (`User:Alaexis/AI_Source_Verification`) with USync for auto-updates

## Important Constraints

- `main.js` runs in the Wikipedia browser context — no Node.js APIs, no ES modules, no npm packages
- All external fetches must go through the CORS proxy
- OOUI components must be loaded via `mw.loader.using()` before use
- API keys are stored in `localStorage`, never hardcoded
- The system prompt contains 9 carefully tuned few-shot examples — changes affect benchmark accuracy
- Claim extraction uses "between citations" logic by design (not full sentences) for precision

## Common Tasks

**Modifying the user script:** Edit `main.js` directly. Test by loading on Wikipedia via the browser console or user script page.

**Adding a new LLM provider:** Add provider config to `this.providers` in the constructor, implement a `callXxxAPI()` method, and add routing in `callProviderAPI()`.

**Updating the benchmark:** Edit `dataset.json` or re-extract with `npm run extract`, then run `npm run benchmark` and `npm run analyze`.
