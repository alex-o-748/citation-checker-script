# Contributing

This doc is an **index** that points you at the right place to read. Substantive content lives in the linked files.

## I want to… → read this

| What you want to do | Where to start |
|---|---|
| Add a new LLM model or provider | [`benchmark/README.md` § Adding New LLM Providers](benchmark/README.md#adding-new-llm-providers) |
| Tweak the verification prompt | [`benchmark/README.md` § Where the prompt lives](benchmark/README.md#where-the-prompt-lives) — `core/prompts.js` is the single source of truth |
| Fix a bug you see in the Wikipedia sidebar UI | The UI is hand-maintained in `main.js` (outside the `<core-injected>` markers). [`CLAUDE.md` § Key Methods in main.js](CLAUDE.md#key-methods-in-mainjs) is the function-by-function index |
| Improve how the tool extracts claim text from articles | [`README.md` § `core/` and the sync script](README.md#core-and-the-sync-script) — logic lives in `core/claim.js`, tests in `tests/claim.test.js`. The "between adjacent citations" design constraint is in [README's Constraints section](README.md#constraints-to-keep-in-mind) |
| Add test cases or extend the ground-truth dataset | [`benchmark/README.md` § Workflow](benchmark/README.md#workflow) + [§ Dataset Versions](benchmark/README.md#dataset-versions) |
| Run the benchmark to evaluate your change | [`benchmark/README.md` § Workflow](benchmark/README.md#workflow) |
| Spot-check a single citation from the command line | [`README.md` § Command-line interface](README.md#command-line-interface-ccs-verify) — `npx ccs verify <url> <n>` |
| Test your changes on Wikipedia before they ship | [`README.md` § Development](README.md#development) — load via the `User:Alaexis/AI_Source_Verification_test.js` page |

## Before you open a PR

- `npm test` — runs the `core/` unit tests
- `npm run build -- --check` — confirms the live `main.js` (the file Wikipedia loads) is in sync with `core/`. Fails if you edited `core/` but didn't rebuild.
- CI runs both of these on every pull request (`.github/workflows/test.yml`), so the PR shows a red X if either fails. Running them locally first saves a round trip.
- If your change touches the prompt or claim extraction, run the benchmark and check that metrics didn't regress: `cd benchmark && npm run benchmark && npm run analyze` (see [`benchmark/README.md` § Workflow](benchmark/README.md#workflow)). This runs the full 189-row dataset across all configured providers and takes a few minutes; a faster smoke-set workflow is on the roadmap. Running it requires at least one API key — see [`benchmark/README.md` § Run Benchmark](benchmark/README.md#step-3-run-benchmark) for details on each. **If you don't have a key for financial reasons, ping the maintainers — we'll happily set you up with access.**

## Repository layout (one-line orientation)

- `main.js` — the userscript Wikipedia loads (single-class IIFE, no build step on the install path)
- `core/*.js` — pure-logic modules; spliced into `main.js` by `scripts/sync-main.js`
- `bin/`, `cli/` — `npx ccs verify` CLI
- `benchmark/` — eval suite, ground-truth dataset, frozen snapshots
- `tests/` — `node:test` suite covering `core/`
- `docs/` — reference docs and design plans (see [`docs/README.md`](docs/README.md))
- `Benchmarking_data_Citations.csv` — single source of truth for the dataset

## Working with Claude or another LLM

If you're using an AI assistant to contribute: start with [`CLAUDE.md`](CLAUDE.md) for architecture and conventions, then read the relevant `benchmark/README.md` section for the area you're changing. Run `npm test` and `npm run build -- --check` before declaring work complete.

## Questions

Open an issue at <https://github.com/alex-o-748/citation-checker-script/issues>.
