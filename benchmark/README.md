# Citation Verification Benchmark Suite

Tools for comparing LLM performance on Wikipedia citation verification tasks.

## Overview

This benchmark suite allows you to:
1. Extract claim/source pairs from Wikipedia articles based on ground truth data
2. Run multiple LLMs on the same dataset for fair comparison
3. Analyze results with detailed accuracy metrics

## Prerequisites

```bash
cd benchmark
npm install
```

## Workflow

### Step 1: Extract Dataset

Convert the ground truth CSV into a complete dataset with claim text and source content:

```bash
# Dry run first to see what will be fetched
npm run extract:dry

# Extract full dataset
npm run extract

# Verbose mode to see detailed logging
node extract_dataset.js --verbose
```

This creates:
- `dataset.json` - Complete enriched dataset
- `dataset_review.csv` - CSV for manual review

### Step 2: Manual Review (Important!)

Before running benchmarks, review `dataset_review.csv`:

1. Open in a spreadsheet editor
2. Check entries where `needs_manual_review` is `true`
3. Verify claim text is correct (especially for multiple occurrences of same citation)
4. Fill in `manual_claim_override` or `manual_source_override` if needed
5. Save changes

**Why manual review?**
- The same citation [N] can appear multiple times supporting different claims
- Automated extraction may not perfectly identify claim boundaries
- Some sources may be behind paywalls or unavailable

### Step 3: Run Benchmark

Set API keys as environment variables:

```bash
export PUBLICAI_API_KEY="..."   # Required for PublicAI models
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="..."
export OPENROUTER_API_KEY="sk-or-..."  # Required for openrouter-* providers
```

Run benchmark:

```bash
# All available providers
npm run benchmark

# Specific providers only
node run_benchmark.js --providers=claude,openai

# Limited entries for testing
node run_benchmark.js --limit 10

# Resume interrupted benchmark
node run_benchmark.js --resume
```

Available providers:
- `publicai` - Free tier, requires PUBLICAI_API_KEY (Apertus / SEA-LION / OLMo)
- `claude` - Requires ANTHROPIC_API_KEY
- `openai` - Requires OPENAI_API_KEY
- `gemini` - Requires GEMINI_API_KEY
- `openrouter` - Requires OPENROUTER_API_KEY (open-weights models; see "Open-weights voting panel" below for the current set)

### Step 4: Analyze Results

```bash
# Console summary
npm run analyze

# Generate markdown report
npm run report
```

## Output Files

| File | Description |
|------|-------------|
| `dataset.json` | Enriched dataset with claim/source text (uses `{metadata, rows}` shape — see "Reproducibility metadata" below) |
| `dataset_review.csv` | CSV for manual verification |
| `results.json` | Raw benchmark results (uses `{metadata, rows}` shape) |
| `analysis.json` | Calculated metrics |
| `report.md` | Human-readable report |
| `historical-runs/` | Reference data: past userscript prompts re-scored against the current dataset via the `BENCHMARK_PROMPT_OVERRIDE_FILE` mechanism. See `historical-runs/README.md`. |

## Dataset Versions

`Benchmarking_data_Citations.csv` carries a `Dataset version` column so the
ground-truth set can grow without losing the ability to reproduce earlier
analyses.

- `v1` — the original 76 rows used for the published benchmark.
- `v2` — 34 negative-class additions (mostly "Not supported" / "Partially
  supported") that broaden topic coverage.
- `v3` — 79 rows imported from the WMF source-verification annotation
  dataset (per-row provenance: `human-annotation:source-verification-2026-04-25`).
  These rows were re-audited under the strict-rubric WP:V/WP:CITE methodology
  on 2026-04-30; the post-audit verdict distribution is in `analysis_v3.json`.

The `dataset_version` field is propagated into each `dataset.json` entry and
each script accepts a `--version v1|v2|v3|all` filter (default: `all`).

### Override columns for externally-imported rows

`Benchmarking_data_Citations.csv` carries three additional columns used only
when a row's claim/source data was imported from outside the Wikipedia
extraction pipeline (currently: v3 / WMF rows):

| Column | Purpose |
|--------|---------|
| `WMF claim text` | Replaces `extractClaimText()` output for this row |
| `WMF source URL` | Replaces the URL discovered in the article's cite_note |
| `WMF provenance` | Populates the `provenance` field on the dataset entry |

When a row has both `WMF claim text` and `WMF source URL` filled,
`extract_dataset.js` skips the article fetch for that row entirely — the row's
claim and source identity comes from the CSV, and only the source content is
fetched fresh. v1 and v2 rows leave these columns blank and behave exactly
as before.

### Reproducing the original v1 analysis

Frozen snapshots of the published v1 pipeline are committed alongside the
mutable working files:

| Snapshot | Description |
|----------|-------------|
| `dataset_v1.json` | v1 enriched dataset at extraction time |
| `results_v1.json` | v1 raw LLM results |
| `analysis_v1.json` | v1 calculated metrics |
| `results_comparison_v1.csv` | v1 per-row comparison |
| `dataset_v3.json` | v3 dataset slice at strict-rubric audit completion (2026-04-30) |
| `results_v3.json` | v3 LLM results against the post-audit ground truth |
| `analysis_v3.json` | v3 calculated metrics |

Re-derive the v1 or v3 metrics from the snapshots without touching the current
files:

```bash
npm run analyze:v1-snapshot   # writes analysis_v1_recomputed.json
npm run analyze:v3-snapshot   # writes analysis_v3_recomputed.json
```

Re-run the full v1 pipeline (network + API keys required; LLM calls are
non-deterministic so numbers may drift slightly):

```bash
npm run extract:v1     # writes dataset.json filtered to v1 rows
npm run benchmark:v1   # writes results.json for v1 entries only
npm run analyze:v1     # writes analysis.json over v1 results
```

The same flags apply for v3 (`extract:v3`, `benchmark:v3`, `analyze:v3`).

Working with the expanded v1 + v2 + v3 set is the default — just run `npm run
extract`, `npm run benchmark`, and `npm run analyze` with no flags.

## Reproducibility metadata

`dataset.json` and `results.json` (plus any new frozen `*_vN.json` snapshots
written from now on) carry a `metadata` block alongside their row data so each
artifact attributes itself to a date. The shape is:

```jsonc
{
  "metadata": {
    // results.json fields
    "run_at": "2026-05-02T15:30:00Z",       // ISO timestamp of run start
    "prompt_date": "2026-05-02",            // YYYY-MM-DD; the date the prompt
                                            //   was effective (assumes
                                            //   core/prompts.js was at HEAD)
    "prompt_source": "core/prompts.js",     // path to the prompt used; equals
                                            //   the value of
                                            //   BENCHMARK_PROMPT_OVERRIDE_FILE
                                            //   when overriding for replay
    "dataset_extracted_at": "2026-04-30",   // copied from dataset.json's own
                                            //   metadata at run time
    "dataset_version_filter": "v1",         // value of --version flag

    // dataset.json fields
    "extracted_at": "2026-04-30",           // YYYY-MM-DD of extraction
    "version_filter": "all"                 // value of --version flag
  },
  "rows": [ /* same row shape as before */ ]
}
```

This is a **deliberate MVP** — date-based, not git-SHA-based. Reproducibility
is best-effort: to know what the prompt was on `2026-05-02`, run `git log --
core/prompts.js`. If you ran with uncommitted local edits, `prompt_date`
records when the run happened, not what was in the prompt at that moment;
that's on you to remember.

**Not captured** (deliberately, for now): the proxy version that produced
`source_text`, individual git SHAs of touched files, model API
sub-versions, OS environment. Add these only when a real reproducibility
question makes them load-bearing.

### Backward compatibility

Frozen historical snapshots (`dataset_v1.json`, `results_v1.json`,
`analysis_v1.json`) are kept in their legacy bare-array shape. All readers
(`run_benchmark.js`, `analyze_results.js`, `generate_comparison.js`) accept
both shapes via `benchmark/io.js`'s `loadRows()` helper, so older snapshots
keep working without migration.

### Historical-prompt replay

The benchmark can score a past version of the userscript prompt against
the current dataset, to answer questions like *"how would today's models
have done with the prompt we shipped on date X?"* — useful for measuring
the impact of past prompt changes, or for sanity-checking whether a
proposed prompt edit actually moves verdict accuracy.

Recover the historical prompt from git and run the benchmark with two
env vars:

```bash
# 1. Recover the prompt at a historical SHA
git show 16f365a:main.js | \
  awk '/generateSystemPrompt/,/^[[:space:]]*}[[:space:]]*$/' | \
  awk '/return `/,/`;/' | sed '1s/^[^`]*`//; $s/`;.*$//' \
  > /tmp/january-prompt.txt

# 2. Run the benchmark with the override + historical date for metadata
BENCHMARK_PROMPT_OVERRIDE_FILE=/tmp/january-prompt.txt \
BENCHMARK_PROMPT_DATE=2026-01-20 \
  node run_benchmark.js --providers=claude-sonnet-4-5,gemini-2.5-flash --version all
```

Each result row's `metadata.prompt_date` and `metadata.prompt_source` will
record the historical date and the override path so the run is attributable.

`benchmark/historical-runs/` contains a worked example: the
2026-01-20 and 2026-04-19 userscript prompts run against the v1+v2+v3
dataset (5 models, zero errors), plus a side-by-side comparison report.
See `benchmark/historical-runs/README.md`.

### Where the prompt lives

`core/prompts.js` is the **single source of truth** for both the system
prompt and the user prompt — used by the userscript (`main.js`), the CLI
(`bin/ccs` / `cli/verify.js`), and the benchmark (via direct ESM import).
`tests/benchmark_prompt_unification.test.js` guards against re-divergence.

The benchmark calls `core.generateUserPrompt(claim, sourceText)` directly —
the same function the userscript and CLI use. In those other paths,
callers pass a `sourceInfo` string that sometimes carries
`Source URL: <url>\n\nSource Content:\n<text>` metadata, which the
function strips via its `Source Content:` regex. The benchmark already
has clean `source_text` and just passes that, falling through to core's
pass-through branch with byte-identical output. Either way the model
receives `Claim: "<claim>"\n\nSource text:\n<text>` — never the URL.

## Metrics Explained

- **Exact Accuracy**: Predicted verdict exactly matches ground truth
- **Lenient Accuracy**: Includes cases where "Supported" ↔ "Partially supported"
- **Binary Accuracy**: Correct on support vs. no support (ignoring partial)
- **Confidence Calibration**: Higher confidence on correct predictions = better calibrated

## Handling Multiple Occurrences

When the same citation appears multiple times (e.g., `[5]` used 3 times):

1. Each occurrence is tracked separately with an `occurrence` field
2. The extractor attempts to identify the specific claim for each occurrence
3. Manual review is recommended for accuracy

Example in dataset.json:
```json
{
  "citation_number": 5,
  "occurrence": 1,
  "claim_text": "First claim citing [5]..."
},
{
  "citation_number": 5,
  "occurrence": 2,
  "claim_text": "Second claim citing [5]..."
}
```

## Open-weights voting panel

`run_benchmark.js` ships with five OpenRouter providers chosen as a voting
panel for the citation-verification task. OSI-compliant weights licenses
are preferred; the Nemotron slot is the exception (NVIDIA Open Model
License) and was added when AllenAI's OLMo 3.1 dropped from OpenRouter's
provider catalog. The panel targets short-JSON verdict output: members
that ship with reasoning enabled by default are configured to disable it
so completion stays within the runner's token budget.

| Provider key | Model | License |
|---|---|---|
| `openrouter-mistral-small-3.2` | `mistralai/mistral-small-3.2-24b-instruct` | Apache 2.0 |
| `openrouter-nemotron-nano-9b-v2` | `nvidia/nemotron-nano-9b-v2` | NVIDIA Open Model License (reasoning disabled) |
| `openrouter-granite-4.1-8b` | `ibm-granite/granite-4.1-8b` | Apache 2.0 |
| `openrouter-gemma-4-26b-a4b` | `google/gemma-4-26b-a4b-it` | Apache 2.0 |
| `openrouter-qwen-3-32b` | `qwen/qwen3-32b` | Apache 2.0 |

A sixth provider, `openrouter-deepseek-v3.2` (MIT), is wired up for
historical comparison but is not part of the panel.

### Cost capture

OpenRouter populates `usage.cost` (USD) on every chat-completions response
as of 2026 — no opt-in flag is required. The benchmark threads this value
into each result row as `cost_usd`, alongside `prompt_tokens` and
`completion_tokens`. `printSummary()` reports total spend, mean cost per
call, and cost per correct (exact) verdict for every provider that emits
cost data.

### Running the panel + voting and ensemble synthesis

End-to-end maintainer workflow once `OPENROUTER_API_KEY` is set:

```bash
npm run benchmark:openrouter-panel    # 187-row sweep across the 5 panel models
npm run ensemble:write                # append vote-5 + vote-5-binary rows
npm run analyze                       # score everything, including the panel
```

The ensemble script is idempotent and supports a dry-run preview:

```bash
npm run ensemble                      # print what would be added, no writes
```

`compute_ensemble.js` recognizes two panels and synthesizes whichever
ones have complete coverage in `results.json`:

- **`PANEL_FULL`** (the headline 5-model panel): produces
  `openrouter-vote-5` and `openrouter-vote-5-binary`.
- **`PANEL_FAST`** (3-model fast set: Mistral + Granite + Gemma):
  produces `openrouter-vote-3` and `openrouter-vote-3-binary`. See
  the fast-set section below for when to use it.

For each synthesized provider:

- `openrouter-vote-N` — 4-class plurality vote with skeptical-rank
  tiebreaker on the verdicts tied at the maximum vote count. Skeptical
  rank: Partially supported > Not supported > Source unavailable >
  Supported.
- `openrouter-vote-N-binary` — strict-majority support vote (>N/2);
  sub-majority and ties default to "Not supported", materialized in
  the row as `Supported` or `Not supported` so `analyze_results.js`
  can score it normally.

The synthesized rows carry summed `cost_usd`, `latency_ms`, and token
counts from the panel members so per-entry economics roll up correctly.
The script is idempotent — prior synthesized rows (any
`openrouter-vote-N` or `openrouter-vote-N-binary`) are stripped before
new ones are appended.

### Fast set for smoketesting

`PANEL_FAST` drops the two slowest panel members (Qwen-3-32b and
OLMo-3.1-32b) and runs only Mistral + Granite + Gemma. Per-citation wall
time is roughly one-third of `PANEL_FULL`, which makes it the right
choice for validating prompt or pipeline changes without paying the full
~18s/citation latency:

```bash
npm run benchmark:openrouter-fast    # 3-model sweep: Mistral + Granite + Gemma
npm run ensemble:write               # appends vote-3 + vote-3-binary rows
npm run analyze
```

The fast set is not a replacement for the full panel as a final
accuracy measurement — `vote-3` loses the OLMo + Qwen disagreement
signal that lifts `vote-5-binary` above any individual model — but it
is a cheap, fast surface for catching regressions before paying for a
full-panel run.

The voting helpers themselves (`computeNClassVote`, `computeBinaryVoteN`)
live in `benchmark/voting.js` and are unit-tested in
`tests/voting.test.js` and `tests/compute_ensemble.test.js`.

### Hugging Face Inference voting panel

`PANEL_HF` is a parallel three-vendor panel routed through Hugging Face
Inference Providers (`router.huggingface.co`). Same OpenAI-compatible
request shape as the OpenRouter panel, different vendor mix. Useful when
testing whether HF Inference's auto-routing across backends (Groq,
Together, PublicAI, etc.) holds up against the OpenRouter-only baseline,
or when a WMF-funded inference path becomes available through the proxy.

| Provider key | Model | License |
|---|---|---|
| `hf-qwen3-32b` | `Qwen/Qwen3-32B` | Apache 2.0 |
| `hf-gpt-oss-20b` | `openai/gpt-oss-20b` | Apache 2.0 |
| `hf-deepseek-v3` | `deepseek-ai/DeepSeek-V3` | MIT |

Set `HF_TOKEN` (Hugging Face access token with serverless-inference
permissions, plus the relevant backend providers enabled in your account
settings at https://huggingface.co/settings/inference-providers) and run:

```bash
npm run benchmark:hf-panel    # 3-model sweep, ~2-4s per call
npm run ensemble:write        # appends hf-vote-3 + hf-vote-3-binary rows
npm run analyze
```

`PANEL_HF` is architecturally diverse on purpose — Qwen3-32B is a dense
Alibaba model, gpt-oss-20b is an OpenAI MoE, DeepSeek-V3 is a DeepSeek
MLA-attention MoE. The vote benefits from disagreement across training
stacks rather than redundant signal from same-lineage models.

DeepSeek-V3 (the original December 2024 release) is the panel choice
rather than the newer V3.1 or V3.2-Exp because both newer variants emit
extended chain-of-thought before the JSON envelope and routinely run
past the 1000-token completion budget, producing unparseable output on
roughly half the dataset rows. V3 predates DeepSeek's hybrid
thinking-mode architecture and produces clean structured output
deterministically. The full delta is in
`benchmark/comparisons/2026-05-08-deepseek-v3-2-to-v3.md`.

#### Cost shape

HF Inference Providers does not return per-call cost in the API
response — only `usage.prompt_tokens` and `usage.completion_tokens`.
`callHuggingFace` captures the token counts and leaves `cost_usd` null.
An empirical run on the v1+v2+v3 dataset (187 rows × 2 paid providers)
measured **$0.27 for 374 calls = ~0.072¢ per single-model call** in
early May 2026, which puts a 3-vote panel call at roughly **0.14–0.22¢
per citation** (lower bound assumes one leg rides on a free-to-caller
proxy path; upper bound is all three legs on a personal HF token). This
is the order-of-magnitude useful for "is this affordable to run at
deployment scale" framing.

## Adding New LLM Providers

Edit `run_benchmark.js` and add to the `PROVIDERS` object:

```javascript
newprovider: {
    name: 'New Provider',
    model: 'model-name',
    endpoint: 'https://api.example.com/v1/chat',
    requiresKey: true,
    keyEnv: 'NEW_PROVIDER_API_KEY',
    type: 'newprovidertype'  // matches the dispatcher case below
}
```

Then implement a `callNewProvider()` function (typically modeled on
`callOpenAI` for OpenAI-compatible APIs) and register it in
`callProvider()`'s `switch (config.type)`. If the provider returns
per-call cost or token-usage data on its responses, propagate
`cost_usd`, `prompt_tokens`, and `completion_tokens` to the result row
alongside the verdict — see `callOpenRouter` for an example.
