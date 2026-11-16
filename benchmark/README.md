# Citation Verification Benchmark Suite

Tools for measuring how well LLMs verify Wikipedia citations: given a claim and
the text of the source cited for it, does the model return the same verdict
(`Supported` / `Partially supported` / `Not supported` / `Source unavailable`)
as a human labeller?

The suite:
1. Extracts claim/source pairs from Wikipedia using the ground-truth labels in
   `../Benchmarking_data_Citations.csv`.
2. Runs any number of providers over the same rows, using the same prompts the
   userscript uses (`core/prompts.js`).
3. Scores the results: accuracy under four metrics, confusion matrices, quote
   fidelity, cost, ROC curves, and run-to-run comparisons.

**Read [Scoring: which rows count](#scoring-which-rows-count) before quoting a
headline accuracy.** Which rows a number covers changes it by more than ten
points.

## Quick start

```bash
cd benchmark
npm install

npm run extract      # build dataset.json from the CSV (network needed)
npm run benchmark    # run every provider you have credentials for
npm run analyze      # score results.json → console summary + analysis.json
```

`dataset.json` and `results.json` are committed, so `npm run analyze` works
straight after a clone with no keys and no network.

## Workflow

### Step 1: Extract the dataset

```bash
npm run extract:dry            # dry run: show what would be fetched
npm run extract                # all rows (v1 + v2 + v3)
npm run extract:v1             # only v1 rows
npm run extract:v3             # only v3 (WMF) rows
node extract_dataset.js --verbose
```

For every row in the CSV, `extract_dataset.js` fetches the article, finds the
citation, extracts its claim with `core/claim.js`'s `extractClaimText()` (the
same code the userscript runs), and fetches the cited source through the CORS
proxy. It writes:

- `dataset.json`: the enriched dataset (`{ metadata, rows }`)
- `dataset_review.csv`: one line per row, for checking the extraction by eye

Each row records whether its stored source was cut off by a fetch cap
(`source_truncated`) and whether it is excluded from scoring
(`excluded_reason`). See [Scoring](#scoring-which-rows-count).

**Reviewing the extraction.** Check the rows where `needs_manual_review` is
`true` in `dataset_review.csv` (no claim or no source text was found). The same
citation `[N]` can support several claims (each occurrence is a separate row
with its own `occurrence` number), and claim boundaries are heuristic. The
review CSV has empty `manual_claim_override` / `manual_source_override` columns,
but **nothing reads them back**. To correct a row, edit `dataset.json`
directly, or fix the CSV that feeds it: the `WMF claim text` / `WMF source URL`
override columns (see [Override columns](#override-columns-for-externally-imported-rows))
and the `Exclude reason` column are read at extraction time.

### Step 2: Run the benchmark

Set credentials for the providers you want. Providers with no key requirement
(Hugging Face, Lift Wing) run without any:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."    # claude-*
export GEMINI_API_KEY="..."              # gemini-*
export PUBLICAI_API_KEY="..."            # apertus-70b, qwen-sealion, olmo-32b
export OPENROUTER_API_KEY="sk-or-..."    # openrouter-*
export HF_TOKEN="hf_..."                 # optional: hf-* on your own quota (see below)
```

```bash
npm run benchmark                                  # every provider in PROVIDERS
node run_benchmark.js --providers=claude-sonnet-5,gemini-3.7-flash
node run_benchmark.js --providers=hf:meta-llama/Llama-3.3-70B-Instruct
node run_benchmark.js --limit 10                   # first 10 rows only
node run_benchmark.js --version v3                 # one dataset version
node run_benchmark.js --concurrency=4              # calls in flight per upstream host (default 5)
node run_benchmark.js --resume                     # skip rows this provider already has
node run_benchmark.js --dataset dataset_wice.json --results results_wice.json
```

`--providers=` takes the **provider keys** below, comma-separated, with `=` and
no spaces. An unknown key is reported (`Unknown provider: …`) and skipped, so a
typo runs nothing rather than failing.

A run never discards other providers' rows: results for any provider not in the
current run are kept whether or not `--resume` is passed. `--resume` only
controls whether the providers being run skip rows they already have.

#### Providers

The table is `PROVIDERS` in `run_benchmark.js`.

| Provider key | Model | Needs |
|---|---|---|
| `claude-sonnet-5` | `claude-sonnet-5` (effort: medium) | `ANTHROPIC_API_KEY` |
| `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` | `ANTHROPIC_API_KEY` |
| `gemini-3.7-flash` | `gemini-3.7-flash` | `GEMINI_API_KEY` |
| `gemini-2.5-flash` | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| `apertus-70b` | `swiss-ai/apertus-70b-instruct` (PublicAI) | `PUBLICAI_API_KEY` |
| `qwen-sealion` | `aisingapore/Qwen-SEA-LION-v4-32B-IT` (PublicAI) | `PUBLICAI_API_KEY` |
| `olmo-32b` | `allenai/Olmo-3.1-32B-Instruct` (PublicAI) | `PUBLICAI_API_KEY` |
| `liftwing-qwen3.8-27b` | `llm-qwen38-27b` (Wikimedia Lift Wing) | nothing |
| `liftwing-gpt-oss-safeguard-20b` | `llm-gpt-oss-safeguard-20b` (Lift Wing) | nothing |
| `hf-qwen3-32b` | `Qwen/Qwen3-32B` | nothing (`HF_TOKEN` optional) |
| `hf-gpt-oss-20b` | `openai/gpt-oss-20b` | nothing (`HF_TOKEN` optional) |
| `hf-deepseek-v3` | `deepseek-ai/DeepSeek-V3` | nothing (`HF_TOKEN` optional) |
| `hf-glm-5.2` | `zai-org/GLM-5.2:novita` (pinned to the Novita backend) | nothing (`HF_TOKEN` optional) |
| `hf:<model-id>` | any model on HF Inference Providers | nothing (`HF_TOKEN` optional) |
| `openrouter-*` | the open-weights panel ([below](#openrouter-voting-panel)) | `OPENROUTER_API_KEY` |

There is no OpenAI-API provider. OpenAI's open-weights `gpt-oss` models are
benchmarked through Hugging Face (`hf-gpt-oss-20b`) and Lift Wing.

Per-provider shortcuts:

```bash
npm run benchmark:publicai             # apertus-70b + qwen-sealion + olmo-32b
npm run benchmark:gemini-3.7-flash     # with --concurrency=2
npm run benchmark:liftwing             # liftwing-qwen3.8-27b
npm run benchmark:liftwing-safeguard   # liftwing-gpt-oss-safeguard-20b
npm run benchmark:new-models           # currently the same as benchmark:liftwing
npm run benchmark:hf-panel             # hf-qwen3-32b + hf-gpt-oss-20b + hf-deepseek-v3
npm run benchmark:hf-gpt-oss-20b
npm run benchmark:glm-5.2              # hf-glm-5.2
npm run benchmark:openrouter-panel     # the 5-model OpenRouter panel
npm run benchmark:openrouter-fast      # its 3-model fast subset
npm run benchmark:v1                   # all providers, v1 rows only
npm run benchmark:v3                   # all providers, v3 rows only
```

### Step 3: Analyze

```bash
npm run analyze                    # all scoreable rows; prints the whole/truncated split
npm run analyze:full-sources       # the strict set: rows whose source was stored whole
npm run analyze:truncated-sources  # only rows whose source hit a fetch cap
npm run analyze:v1                 # filter to one dataset version (also :v3)
npm run report                     # markdown report → report.md
```

`analyze_results.js` flags:

| Flag | Effect |
|---|---|
| `--version v1\|v2\|v3\|all` | Score one dataset version |
| `--truncation all\|full\|truncated` | Score all rows, only whole sources (the strict set), or only truncated ones |
| `--include-excluded` | Put the unscoreable rows back in (dropped by default; the count is always printed) |
| `--projection unanimous\|mixed\|all` | WiCE only, see [WiCE](#wice-external-benchmark) |
| `--dataset` / `--results` / `--analysis` / `--output` | Input and output paths |

`--truncation` refuses to run against a dataset with no `source_truncated`
field anywhere (the frozen v1/v3 snapshots). It does not read an absent field
as "whole".

For each provider the analyzer reports the four accuracy metrics (below), a
confusion matrix, latency, quote offer rate and fidelity (the share of offered
`source_quote`s actually found in the source), accuracy split by whether the
quote verified, and, where the provider reports it, cost.

## Scoring: which rows count

The 2026-09-07 revision
([`docs/benchmark-revision-2026-09-07.md`](../docs/benchmark-revision-2026-09-07.md))
changed which rows are scored and corrected six labels. Model predictions were
not touched. Everything in this section comes from that revision and the audit
behind it
([`docs/benchmark-ground-truth-audit-2026-09-06.md`](../docs/benchmark-ground-truth-audit-2026-09-06.md)).

### The strict set: 140 of 189 rows

| Rows | Count | Field | Scored by default? |
|---|---|---|---|
| Source stored whole | 140 | | yes |
| Source truncated at a fetch cap | 48 | `source_truncated: true` | yes (drop with `--truncation full`) |
| Unscoreable | 1 (`row_108`) | `excluded_reason` | no (keep with `--include-excluded`) |

**Truncated rows.** When the current dataset was extracted, the CORS proxy cut
extracted source text off at **12,000 characters** (the direct-fetch fallback at
50,000). For 48 rows the stored `source_text` is therefore a *prefix* of the
document, but the label was made by a human reading the whole page. A wrong
verdict on such a row may be the tool failing to see the evidence, not the model
misjudging it. In the 2026-09-07 run:

| Source | Result rows | Exact accuracy |
|---|---|---|
| Stored whole | 1,030 | **62.3%** |
| Truncated at a cap | 365 | **51.0%** |
| | | **11.4-point gap** |

`extract_dataset.js` sets `source_truncated` at fetch time with
`core/worker.js`'s `isContentTruncated()`, the same rule the userscript and the
batch pipeline use. The Worker's cap has since risen to 100,000 characters, so a
re-extraction would truncate far fewer rows.

**The excluded row.** `row_108`'s claim and its cited URL are unrelated, so no
verifier can do better or worse on it. Its `excluded_reason` comes from the
`Exclude reason` column in the CSV.

**Failed fetches stay in.** A row whose source simply failed to fetch is not
excluded. A human editor can still open that URL, so a failed fetch is a failure
of ours worth measuring, not a row to hide.

**Rows are flagged, never deleted**, for two reasons:
- The userscript hit the same 12,000-character cap, so truncated rows reproduce
  a real production failure. Deleting them would raise the headline while the
  tool got no better, and would remove the only evidence the failure exists.
- Row ids are `row_<csv_line>`, so deleting a CSV line would renumber every row
  after it (see "Benchmark row_id fragility" in `../CLAUDE.md`). That is why
  exclusion is a column, not a deletion. A test pins each id to its CSV line.

**Which number to quote:** use "all rows" (188 scoreable) for the tool as
deployed, and "strict" (140) for the model's judgement when it saw what the
labeller saw. Say which one you mean.

### Six ground-truth corrections

Each correction was found by reading the stored claim and source directly. Model
disagreement only decided the reading order, and **every correction was checked
by hand, row by row, before being applied**. None was auto-applied from a
model's disagreement.

| Row | Article | Was | Now | Evidence |
|---|---|---|---|---|
| `row_18` | Immigration to the United States | Partially supported | **Supported** | Source states it almost verbatim: *"Historians estimate that well under a million immigrants—perhaps as few as 400,000—crossed the Atlantic during those two centuries."* |
| `row_24` | Fall of Aden (2026) | Supported | **Partially supported** | The claim adds the STC's "reported dissolution" and the "collapse" of its forces. Neither appears in the source, same-day reporting in which *"Some officials from the STC, however, said the group is still in control of Aden."* |
| `row_71` | Liberation Tigers of Tamil Eelam | Partially supported | **Not supported** | Claim: the ENLF formed in April 1984, including PLOTE. Source: *"In March 1985, the LTTE, EPRLF, TELO, and EROS formed … the Eelam National Liberation Front (ENLF). PLOTE … remained outside the coalition."* Wrong on date and membership. |
| `row_81` | Gary Graffman | Not supported | **Partially supported** | Too harsh before: the source carries the core (*"Wittgenstein commissioned the concerto in 1923 … called a keyboard Salome by the soloist Gary Graffman"*). Only "played it many times" and "slipped from the repertoire" are absent. |
| `row_102` | Ohio University | Partially supported | **Not supported** | Claim: "R1: Doctoral Universities – Very high research activity." Source: "Doctoral Universities: High Research Activity", one tier down. |
| `row_159` | UC Colorado Springs | Partially supported | **Not supported** | Neither "Military Friendly" nor "veteran" appears anywhere in the stored source. |

Three of the six (`row_24`, `row_71`, `row_102`) are in the strict set and move
its numbers. The other three are truncated rows and affect only the all-rows
figure.

Some rows that looked wrong were examined and **left alone**, which is the
evidence that the review was real. `row_186` (source says CZW was founded in
1998, the claim says 1999) and `row_161` (source never mentions North Carolina)
each follow a documented labelling convention. `row_47` was flagged as an error
and turned out not to be one.

### Results at the revision (2026-09-07)

These are the eight providers then in `results.json`, ordered by exact accuracy
on the strict set:

| Provider | Exact (all rows) | Exact (strict) | Supported-vs-rest (strict) |
|---|---|---|---|
| gemini-3.7-flash | 69.2% | **74.8%** | **85.0%** |
| gemini-2.5-flash | 67.6% | 71.5% | 79.6% |
| hf-gpt-oss-20b | 65.2% | 67.7% | 81.2% |
| qwen-sealion | 60.6% | 65.2% | 69.6% |
| claude-sonnet-5 | 57.5% | 60.2% | 83.5% |
| apertus-70b | 54.8% | 54.8% | 62.6% |
| claude-sonnet-4-5 | 50.3% | 52.6% | 76.6% |
| liftwing-qwen3.6-27b | 49.7% | 51.9% | 79.7% |

The two metrics rank providers differently. `liftwing-qwen3.6-27b` goes from
last to fourth and `claude-sonnet-5` from fifth to second, because exact
accuracy counts every `Source unavailable` call as wrong, while
supported-vs-rest treats it as one of the ways a citation fails. The audit doc
has the breakdown. `analysis_full_sources.json` and
`analysis_truncated_sources.json` are the committed strict and truncated
analyses from this run.

### Open question: the `Partially supported` class

`Partially supported` is the weakest class everywhere: **45.9%** even on whole
sources, against 72.8% for `Supported` and 64.8% for `Not supported`. Part of
that is a rubric ambiguity. When a source contradicts one specific figure or
date but supports everything else, `core/prompts.js` steers the model to NOT
SUPPORTED (its own few-shot: the claim says 45 nations, the source says "over
30" → NOT SUPPORTED). The v2/v3 labelling convention maps the same shape to
*Partially supported*. `row_102` and `row_186` have that shape and opposite
labels. This needs a rubric decision rather than row-by-row fixes.

## Metrics explained

Every metric is the **share of a provider's calls that returned a parseable
verdict** where that verdict counts as right. API errors and unparseable
responses are dropped from the denominator, not counted wrong. The metrics
differ only in what "right" means:

| Metric | Counts as right |
|---|---|
| **Exact** | The verdict matches the label across all four classes. Nothing is forgiven: calling a partially-supported claim unsupported is as wrong as calling it supported. |
| **Supported-vs-rest** | `Supported` must match exactly, but the three ways a citation can fail (`Partially supported`, `Not supported`, `Source unavailable`) count as equivalent. It answers the editor's question, *does this citation carry the claim, yes or no?*, without grading how it fails. This is also WiCE's claim-level binary grouping. |
| **Lenient** | Exact, plus `Supported` ↔ `Partially supported` mix-ups |
| **Binary** | {`Supported`, `Partially supported`} vs. {`Not supported`, `Source unavailable`} |

`equalSupportedVsRest()` in `core/verdicts.js` explains why supported-vs-rest
and lenient coexist rather than one being "the" lenient metric.

**For TPR/FPR and ROC curves, the positive class is the failing citation**: any
label other than `Supported`. TPR is the share of genuinely failing citations
the tool flags, and FPR is the share of genuinely fine citations it flags anyway
(crying wolf). This has been read the other way round twice. See
[`docs/roc-curves.md`](../docs/roc-curves.md).

## Other analysis tools

```bash
npm run roc              # ROC curve + AUC per provider, all scoreable rows → roc.json
npm run roc:strict       # the strict set → roc_strict.json
npm run roc:truncated    # truncated rows only → roc_truncated.json
npm run compare -- control.json treatment.json --dataset dataset.json
npm run inspect -- --provider=hf-qwen3-32b --status=wrong --limit=20 --full
node print_confusion_matrix.js
node generate_comparison.js     # per-row provider comparison → results_comparison.csv
```

- **`compare`** (`ccs compare`, `compare_results.js` + `render_compare.js`) diffs
  two `results.json` runs: per-provider accuracy deltas, verdict flips, subset
  filters, `--noise-floor`, as JSON, Markdown or HTML. See
  [`docs/comparing-benchmark-runs.md`](../docs/comparing-benchmark-runs.md).
- **`inspect`** prints individual rows (claim, label, verdict, comment, quote),
  filtered by `--provider=`, `--status=wrong|partial|exact|error|all` and
  `--limit=`.
- **`roc`** takes the same `--truncation` and `--include-excluded` flags as the
  analyzer.

## WiCE (external benchmark)

[WiCE](https://github.com/ryokamoi/wice) (Kamoi et al., EMNLP 2023) is 707
human-labelled Wikipedia claim/source pairs that nobody on this project selected
or annotated, converted to our row schema.

```bash
npm run wice:convert            # fetch + convert dev+test → dataset_wice.json
npm run wice:convert:all        # dev+test+train
npm run wice:benchmark          # run providers → results_wice.json
npm run wice:analyze            # all rows
npm run wice:analyze:unanimous  # rows whose label means what ours means
npm run wice:analyze:mixed      # rows whose label is a projection artifact
```

- `dataset_wice.json` is **gitignored and regenerated**, never merged into
  `dataset.json`. It is deterministic (a sha256 in its metadata proves it), and
  WiCE's label mix would silently change what headline accuracy means.
- WiCE labels *subclaims*, and claim labels are projected from them (anything
  mixed becomes `Partially supported`, about 57% of rows). Each row records
  `wice_label_projection: unanimous | mixed`, and `--projection` scores either
  subset.
- WiCE ships frozen evidence and no `Source unavailable` rows, so it tests the
  prompt and model, **not** the fetch path.

Read [`docs/wice-benchmark.md`](../docs/wice-benchmark.md) before quoting a WiCE
number.

## Hugging Face Inference providers

The `hf-*` providers and any `hf:<model-id>` call Hugging Face Inference
Providers (`router.huggingface.co`) with an OpenAI-compatible request. All go
through `core/providers.js`'s `callHuggingFaceAPI()`.

- **`HF_TOKEN` is optional.** Without it, calls go through the publicai-proxy
  worker's keyless `/hf` path, which injects an upstream token for you (no
  account needed, shared quota). With it (a token with serverless-inference
  permission, and backends enabled at
  https://huggingface.co/settings/inference-providers), calls go straight to
  `router.huggingface.co` on your own quota.
- **`HF_WORKER_BASE`** sends the keyless calls to a different proxy's `/hf`
  path, e.g. the Toolforge LLM router:
  ```bash
  HF_WORKER_BASE=https://llm-router.toolforge.org node run_benchmark.js --providers=hf-gpt-oss-20b
  ```
- **Any HF-hosted model** can be benchmarked without a `PROVIDERS` entry by
  passing it inline, mixed freely with ordinary keys:
  ```bash
  node run_benchmark.js --providers=hf:meta-llama/Llama-3.3-70B-Instruct --limit 10
  node run_benchmark.js --providers=claude-sonnet-4-5,hf:mistralai/Mistral-Small-24B-Instruct-2501
  ```
  Append `:<backend>` to pin a backend, as `hf-glm-5.2` does with `:novita`.

### HF voting panel (`PANEL_HF`)

| Provider key | Model | License |
|---|---|---|
| `hf-qwen3-32b` | `Qwen/Qwen3-32B` | Apache 2.0 |
| `hf-gpt-oss-20b` | `openai/gpt-oss-20b` | Apache 2.0 |
| `hf-deepseek-v3` | `deepseek-ai/DeepSeek-V3` | MIT |

```bash
npm run benchmark:hf-panel    # 3-model sweep, ~2-4 s per call
npm run ensemble:write        # appends hf-vote-3 + hf-vote-3-binary rows
npm run analyze
```

The panel is diverse on purpose (a dense Alibaba model, an OpenAI MoE, a
DeepSeek MLA-attention MoE), so the vote gets disagreement across training
stacks rather than redundant signal. `hf-glm-5.2` is benchmarked on its own and
is not a panel member.

DeepSeek-V3 (the December 2024 release) is chosen over V3.1 and V3.2-Exp because
those emit extended chain-of-thought before the JSON and, under the
1,000-token completion budget the benchmark used at the time, produced
unparseable output on about half the rows. V3 produces clean structured output.
See `comparisons/2026-05-08-deepseek-v3-2-to-v3.md`. The budget is now 16,384
([below](#re-baselining-max_tokens-1000--16384-2026-08-16)), so the newer
variants may deserve a re-test.

**Cost.** HF returns token counts but no per-call cost, so `cost_usd` is null. A
run in early May 2026 measured **$0.27 for 374 calls, about 0.072¢ per
single-model call**, or roughly 0.14–0.22¢ per citation for a 3-vote panel.

### Frozen snapshots from 2026-08-17

- **`analysis_hf_keyless_2026-08-17.json`**: aggregate metrics only, from a
  full 182-row keyless run of `hf-qwen3-32b` (61.5% exact / 75.3% lenient /
  77.5% binary / 74.2% supported-vs-rest) and `hf-gpt-oss-20b` (60.2% / 69.6% /
  69.6% / 76.8%). The raw rows were lost to a since-fixed `run_benchmark.js` bug
  (a run without `--resume` used to discard other providers' rows), so this file
  has no per-row data and can't be used with `inspect` or `compare`.
  Supported-vs-rest was back-filled exactly from the confusion matrices.
- **`results_claude_sonnet5_2026-08-17.json` / `analysis_claude_sonnet5_2026-08-17.json`**:
  the `claude-sonnet-5` companion run on the same dataset and prompt, with full
  row-level data.

Write-up: [`docs/hf-keyless-and-sonnet-5-benchmark.md`](../docs/hf-keyless-and-sonnet-5-benchmark.md).

## Wikimedia Lift Wing providers

`liftwing-*` providers call Wikimedia-hosted models through the Toolforge LLM
router (`tf-llm-router`, `https://llm-router.toolforge.org/liftwing`). They need
no key.

- **`liftwing-qwen3.8-27b`** replaced `liftwing-qwen3.6-27b`, which Lift Wing is
  retiring and the router no longer allows. The 3.6 provider's past rows stay in
  the results files (it is one of the eight in the 2026-09-07 table above).
  `results_qwen36_vs_qwen38_2026-10-21.json` holds both on the full dataset. See
  [`docs/liftwing-qwen36-vs-qwen38-2026-10-21.md`](../docs/liftwing-qwen36-vs-qwen38-2026-10-21.md).
- **`liftwing-gpt-oss-safeguard-20b`** uses KServe's predict endpoint
  (`kservePredict`). Its 2026-10-21 run is in
  `results_liftwing_safeguard_2026-10-21.json`.

## OpenRouter voting panel

Five OpenRouter providers form a voting panel. OSI-compliant licenses are
preferred. Nemotron is the exception, added when OLMo 3.1 dropped from
OpenRouter's catalog. Members that reason by default are configured not to, so
they return short JSON.

| Provider key | Model | License |
|---|---|---|
| `openrouter-mistral-small-3.2` | `mistralai/mistral-small-3.2-24b-instruct` | Apache 2.0 |
| `openrouter-nemotron-nano-9b-v2` | `nvidia/nemotron-nano-9b-v2` | NVIDIA Open Model License (reasoning disabled) |
| `openrouter-granite-4.1-8b` | `ibm-granite/granite-4.1-8b` | Apache 2.0 |
| `openrouter-gemma-4-26b-a4b` | `google/gemma-4-26b-a4b-it` | Apache 2.0 |
| `openrouter-qwen-3-32b` | `qwen/qwen3-32b` | Apache 2.0 |

`openrouter-deepseek-v3.2` (MIT) is wired up for historical comparison but is
not in the panel.

```bash
npm run benchmark:openrouter-panel   # full sweep across the 5 panel models
npm run ensemble                     # dry run: print what would be added
npm run ensemble:write               # append the vote rows
npm run analyze
```

**Fast set (`PANEL_FAST`).** Mistral + Granite + Gemma, dropping the two
slowest members (Qwen and Nemotron), for about a third of the wall time. Use it
for catching regressions cheaply (`npm run benchmark:openrouter-fast`), not as a
final accuracy measurement: `vote-3` loses the disagreement signal from the two
members it drops.

**Cost.** OpenRouter returns `usage.cost` (USD) on every response. Each row
carries `cost_usd`, `prompt_tokens` and `completion_tokens`, and the summary
reports total spend, mean cost per call, and cost per exact-correct verdict.

### How the ensemble votes

`compute_ensemble.js` builds synthetic vote rows for every panel
(`PANEL_FULL`, `PANEL_FAST`, `PANEL_HF`) that has complete coverage in
`results.json`. That gives `openrouter-vote-5`, `openrouter-vote-3` and
`hf-vote-3`, each with a `-binary` twin:

- **`*-vote-N`**: a 4-class plurality vote. Ties break by skeptical rank:
  Partially supported > Not supported > Source unavailable > Supported.
- **`*-vote-N-binary`**: `Supported` only on a strict majority (> N/2) of
  support votes, otherwise `Not supported`.

Vote rows carry the members' summed cost, latency and tokens. The script is
idempotent: earlier vote rows are stripped before new ones are written. Voting
logic lives in `voting.js` and is tested in `tests/voting.test.js` and
`tests/compute_ensemble.test.js`.

## Dataset versions

`Benchmarking_data_Citations.csv` has a `Dataset version` column so the set can
grow without losing old analyses. The 189 rows:

- **`v1`**: the original 76 rows of the published benchmark.
- **`v2`**: 34 negative-class additions (mostly `Not supported` /
  `Partially supported`) that broaden topic coverage.
- **`v3`**: 79 rows from the WMF source-verification annotation dataset
  (provenance `human-annotation:source-verification-2026-04-25`), re-audited
  under the strict WP:V/WP:CITE rubric on 2026-04-30.

Every script takes `--version v1|v2|v3|all` (default `all`).

### Override columns for externally-imported rows

Used only by rows whose claim/source came from outside the Wikipedia extraction
(currently the v3 / WMF rows):

| Column | Purpose |
|---|---|
| `WMF claim text` | Replaces `extractClaimText()` output |
| `WMF source URL` | Replaces the URL found in the article's cite_note |
| `WMF provenance` | Fills the entry's `provenance` field |

With both claim text and URL filled, the article fetch is skipped and only the
source content is fetched fresh.

### Frozen snapshots

| Snapshot | Description |
|---|---|
| `dataset_v1.json` / `results_v1.json` / `analysis_v1.json` / `results_comparison_v1.csv` | The published v1 pipeline |
| `dataset_v3.json` / `results_v3.json` / `analysis_v3.json` | v3 at strict-rubric audit completion (2026-04-30) |

```bash
npm run analyze:v1-snapshot   # → analysis_v1_recomputed.json
npm run analyze:v3-snapshot   # → analysis_v3_recomputed.json
```

To re-run the v1 pipeline end to end (network and keys needed; LLM output
drifts): `npm run extract:v1`, then `npm run benchmark:v1`, then
`npm run analyze:v1`. The same works for v3. The snapshots predate
`source_truncated`, so `--truncation` refuses to run on them.

## Reproducibility

### Metadata

`dataset.json`, `results.json` and new snapshots carry a `metadata` block next
to their `rows`:

```jsonc
{
  "metadata": {
    // results.json
    "run_at": "2026-09-06T05:32:05Z",     // run start
    "prompt_date": "2026-09-06",          // date the prompt was effective
    "prompt_source": "core/prompts.js",   // or BENCHMARK_PROMPT_OVERRIDE_FILE
    "dataset_extracted_at": "2026-05-15", // copied from dataset.json
    "dataset_version_filter": "all",
    // dataset.json
    "extracted_at": "2026-05-15",
    "version_filter": "all"
  },
  "rows": [ /* ... */ ]
}
```

This is deliberately date-based, not git-SHA-based. To see the prompt on a date,
run `git log -- core/prompts.js`. Uncommitted local edits are not recorded. Not
captured: proxy version, file SHAs, model sub-versions, OS. The frozen v1
snapshots keep the legacy bare-array shape, and every reader accepts both via
`io.js`'s `loadRows()`.

### Where the prompt lives

`core/prompts.js` is the single source of truth for the system and user prompts
used by the userscript, the CLI and the benchmark.
`tests/benchmark_prompt_unification.test.js` guards against divergence. The
benchmark calls `generateUserPrompt(claim, sourceText)` directly, so the model
receives `Claim: "<claim>"\n\nSource text:\n<text>` and never the URL.

### Historical-prompt replay

Score a past prompt against today's dataset:

```bash
git show 16f365a:main.js | \
  awk '/generateSystemPrompt/,/^[[:space:]]*}[[:space:]]*$/' | \
  awk '/return `/,/`;/' | sed '1s/^[^`]*`//; $s/`;.*$//' \
  > /tmp/january-prompt.txt
```

```bash
BENCHMARK_PROMPT_OVERRIDE_FILE=/tmp/january-prompt.txt \
BENCHMARK_PROMPT_DATE=2026-01-20 \
  node run_benchmark.js --providers=claude-sonnet-4-5,gemini-2.5-flash --version all
```

The override path and date are recorded in the metadata. `historical-runs/`
holds a worked example (the 2026-01-20 and 2026-04-19 prompts across 5 models).
See `historical-runs/README.md`.

### Re-baselining: max_tokens 1000 → 16384 (2026-08-16)

`BENCHMARK_MAX_TOKENS` was raised from 1,000 to 16,384 to match
`core/providers.js`, so the benchmark runs under the same output budget as the
userscript and CLI. At 1,000, reasoning models (gpt-oss especially, which spends
roughly 1.5k–4k hidden tokens on this task) ran out mid-reasoning and returned
empty content, which was recorded as an error.

Raising a ceiling can't change a response that already fit under it, so rows
that didn't truncate stay comparable across the boundary. Only previously failed
rows change. The cost is that reasoning models now spend production-level
latency and tokens. Runs before this date carry the old cap, and `run_at` is the
marker.

## Output files

| File | Description |
|---|---|
| `dataset.json` | Enriched dataset (`{metadata, rows}`), with `source_truncated` / `excluded_reason` per row |
| `dataset_review.csv` | Extraction review sheet |
| `results.json` | Raw results, one row per provider × entry (verdict, comment, `source_quote`, `quote_status`, latency, tokens, cost) |
| `analysis.json` | Metrics from the last `npm run analyze` |
| `analysis_full_sources.json` / `analysis_truncated_sources.json` | Strict-set / truncated-only analyses |
| `roc.json` / `roc_strict.json` / `roc_truncated.json` | ROC curves |
| `results_comparison.csv` | Per-row provider comparison |
| `report.md` | Markdown report (`npm run report`) |
| `*_v1.json`, `*_v3.json` | Frozen snapshots |
| `*_2026-08-17.json`, `*_2026-10-21.json` | Dated one-off runs (see the HF and Lift Wing sections) |
| `comparisons/` | Saved run-to-run comparisons |
| `historical-runs/` | Past-prompt replays |
| `dataset_wice.json`, `results_wice.json`, `analysis_wice*.json` | WiCE (gitignored) |

## Adding a provider

For an HF-hosted model, use `--providers=hf:<model-id>`. No code change is
needed.

Otherwise, add an entry to `PROVIDERS` in `run_benchmark.js`:

```javascript
'newprovider-model-x': {
    name: 'Model X (New Provider)',
    model: 'model-x',
    endpoint: 'https://api.example.com/v1/chat',
    requiresKey: true,
    keyEnv: 'NEW_PROVIDER_API_KEY',
    type: 'newprovidertype'   // matched by callProvider()'s switch
}
```

If `type` is new, write a `callNewProvider()` (OpenAI-compatible APIs can follow
`callOpenRouter`) and add a `case` for it in `callProvider()`'s
`switch (config.type)`. Return `cost_usd`, `prompt_tokens` and
`completion_tokens` on the row if the API reports them.

The benchmark's `PROVIDERS` table is separate from `core/models.js`, which is
the provider table for the userscript, CLI and web tool. Adding a benchmark
provider does not make it available there.
