# Comparing benchmark runs

The `ccs compare` subcommand turns two `results.json` files (a *control* and a *treatment*) into a structured per-provider accuracy + flip report. It exists so contributors can validate prompt changes, worker-side changes, dataset augmentations, or panel-member swaps against a baseline without writing a one-off comparison script every time.

The tool operates on the *intersection* of cells present in both runs — `(entry_id, provider)` pairs that successfully predicted in both control and treatment. Cells where either side errored or didn't run are excluded from the comparison so accuracy isn't skewed by missing data.

## Quick start

From inside `benchmark/`:

```sh
# Render a Markdown report
npm run compare -- control.json treatment.json --dataset dataset.json --report out.md

# Render a self-contained HTML report
npm run compare -- control.json treatment.json --dataset dataset.json --report out.html

# Print JSON to stdout for piping into another tool
npm run compare -- control.json treatment.json --dataset dataset.json
```

Or invoke the underlying CLI directly:

```sh
npx ccs compare control.json treatment.json --dataset dataset.json --report out.html
```

The format of the report is chosen by the file extension on `--report`: `.html`, `.md` (or `.markdown`), or `.json`. With no `--report`, JSON is written to stdout.

## What the report shows

Two tables, in both Markdown and HTML output:

1. **Headline accuracy.** For each provider, the count of correct cells out of total compared cells, in both control and treatment, with a Δ in percentage points. Three metrics:
    - *exact match* — the predicted verdict equals ground truth literally (after case/whitespace normalization).
    - *lenient* — exact, plus `Supported ↔ Partially supported` counted as a near-miss. Useful when the GT distinction between those two is itself fuzzy and a Supported→Partially shift shouldn't count as an error.
    - *binary* — Supported and Partially supported are pooled into one class; Not supported and Source unavailable into the other.

    Rows whose `|Δ|` falls below the noise floor (default ±5pp, configurable via `--noise-floor`) on *all three* metrics are flagged so a reader treats them as noise rather than signal.
2. **Flip table.** Every cell that changed verdict, classified as one of:
    - **improvement** — wrong in control, correct in treatment.
    - **regression** — correct in control, wrong in treatment.
    - **lateral** — wrong in both, but the verdict shifted to a different wrong answer.

Cells that were *unchanged-correct* or *unchanged-wrong-same* are aggregated in the per-provider counts but don't appear in the flip table.

## Subset filtering

The `--filter <key>=<value>` flag re-aggregates the comparison over a subset of cells *after the full comparison runs*. This is deliberate: pre-classifying rows before the experiment and filtering before the comparison invites confirmation bias. Always run the full comparison, then slice in the report.

Supported filter keys:

| Key | Example | Effect |
|---|---|---|
| `version` | `--filter version=v2` | Restrict to dataset rows with `dataset_version === 'v2'`. |
| `provider` | `--filter provider=openrouter-vote-3` | Restrict to a single provider/panel. |
| `direction` | `--filter direction=regression` | Restrict to cells with a specific flip direction (valid values: `improvement`, `regression`, `lateral`, `unchanged-correct`, `unchanged-wrong-same`). |

Combine filters by running the comparison multiple times with different `--filter` values; the JSON output is small enough that piping through `jq` is also fine for ad-hoc slicing.

## Recording what changed

Two optional flags add metadata to the report so a reader knows what they're looking at:

- `--change-axis <name>` — repeat for each thing that differs between control and treatment (e.g., `--change-axis prompt --change-axis source_text`). Recorded in the report's metadata block.
- `--gt-version <label>` — the ground-truth version (e.g., `post-audit-2026-04-30`). Useful when re-scoring an old result file against a revised dataset; the report records which GT was applied.

These don't change the comparison logic, only the report's metadata. Use them so readers can audit which axis each comparison isolates.

## When to use this

- **Before/after a prompt change.** Run the benchmark once with the old prompt, once with the new, then compare. `--change-axis prompt`.
- **Before/after a worker / proxy change.** Compare against a baseline run before the change. `--change-axis source_text`.
- **Control vs augmented dataset.** When testing whether a dataset augmentation (e.g., prepending Citoid metadata) helps, run both with and without and compare.
- **Provider-panel A/B.** Compare runs that included a different mix of panel members.
- **Pre-submission check before opening a PR.** Run your branch's benchmark against a frozen canonical baseline; the report's flip table is what to paste into the PR description.

## Exit codes

- `0` — comparison ran successfully. Always returned on a clean run, regardless of whether regressions were found. **Inspect the report; the tool does not gate on regressions.**
- `2` — bad arguments, file not found, JSON parse failure, no overlapping cells, or unrecognized `--filter` key. Genuine errors only.

If you want a CI gate that fails on regression, pipe the JSON output through a separate script that decides the threshold — do not bake gating into this tool.

## Source layout

- `benchmark/compare_results.js` — pure comparison logic (`compareResults`, `filterComparison`, verdict normalizers, classification, aggregation).
- `benchmark/render_compare.js` — Markdown / HTML / JSON renderers (`renderMarkdown`, `renderHtml`, `renderJson`).
- `cli/compare.js` — argument parsing and the `runCompare` orchestration that loads files, calls compare, applies filters, writes reports.
- `tests/compare_results.test.js`, `tests/render_compare.test.js`, `tests/compare_cli.test.js` — unit + integration coverage.

The pure logic in `compare_results.js` and `render_compare.js` does no I/O — they take parsed inputs and return data structures or strings. The CLI is the only layer that touches the filesystem. This is intentional so the comparison logic is callable from a script, a test, or a future GUI without dragging file-system assumptions along.
