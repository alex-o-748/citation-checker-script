# Keyless HF Inference + Claude Sonnet 5 — benchmark results (2026-08-17)

## Overview

Three models were benchmarked on 2026-08-17 against the current 182-row dataset
and the current system prompt (`core/prompts.js`): **Qwen3-32B** and
**gpt-oss-20b** via Hugging Face Inference's keyless proxy path, and
**Claude Sonnet 5** via the direct Anthropic API. This document covers those
three. For the original four-model benchmark (Claude Sonnet 4.5, Gemini 2.5
Flash, Apertus-70B, Qwen-SEA-LION), see
[`docs/llm-benchmarking-overview.md`](llm-benchmarking-overview.md) — referenced
below for context, not reproduced here.

**Raw data:**
- Qwen3-32B / gpt-oss-20b: [`benchmark/analysis_hf_keyless_2026-08-17.json`](../benchmark/analysis_hf_keyless_2026-08-17.json)
  — aggregate metrics only; the underlying per-row `results.json` was lost to a
  since-fixed bug (see [Caveats](#caveats-read-before-comparing) below).
- Claude Sonnet 5: local `results.json` only at time of writing — not yet
  committed. Only the headline metrics below have been captured; a fuller
  breakdown (confusion matrix, quote fidelity, confidence calibration) can be
  added later from the same file via `node analyze_results.js`.

## Headline comparison

| Model | Exact | Lenient | Binary | Supported-vs-rest | Avg latency | Errors |
|---|---|---|---|---|---|---|
| Qwen3-32B | 61.5% | 75.3% | 77.5% | 74.2% | 10,318ms | 0/182 |
| gpt-oss-20b | 60.2% | 69.6% | 69.6% | 76.8% | 1,785ms | 1/182 |
| Claude Sonnet 5 | 54.4% | 64.8% | 73.6% | 70.3% | 3,444ms | 0/182 |

Metric definitions: see `benchmark/README.md` § Metrics Explained. In short —
**exact** requires an identical verdict; **lenient** additionally forgives
Supported↔Partially-supported; **binary** collapses to
{Supported,Partially-supported} vs {Not-supported,Source-unavailable};
**supported-vs-rest** requires Supported and Source-unavailable to match
exactly but forgives Partially-supported↔Not-supported as mutual near-misses
(this is the grouping `docs/llm-benchmarking-overview.md`'s original "Lenient
Accuracy" section describes).

## Per-model detail

### Qwen3-32B (`Qwen/Qwen3-32B`, via HF Inference)

- 182/182 valid, 0 errors.
- Quote fidelity: offered a quote on 109/109 eligible rows (100% offer rate);
  86 of those 109 were actually located in the source text (78.9% fidelity).
- Accuracy when the quote verified: 74.4%, vs. 56.5% when it didn't — an
  18-point gap. A verified quote is a meaningfully stronger signal that the
  verdict is trustworthy for this model.
- Confidence: averaged 56.3 overall, 61.4 on correct rows vs. 41.8 on wrong
  ones (19.6-point calibration gap) — confidence tracks correctness
  reasonably well, though the average confidence is fairly low across the board.
- By far the slowest of the three: 10.3s average latency, up to 24.4s on the
  slowest row.

**Confusion matrix** (rows = ground truth, columns = predicted):

| Truth \ Predicted | Supported | Partially supported | Not supported | Source unavailable |
|---|---|---|---|---|
| Supported | 53 | 15 | 11 | 1 |
| Partially supported | 10 | 24 | 19 | 3 |
| Not supported | 3 | 4 | 35 | 4 |
| Source unavailable | 0 | 0 | 0 | 0 |

### gpt-oss-20b (`openai/gpt-oss-20b`, via HF Inference)

- 181/182 valid, 1 error.
- Quote fidelity: 87/87 eligible rows offered a quote (100%), 75 of those
  verified in-source (86.2% fidelity) — the best fidelity of the three models
  in this run.
- Accuracy when the quote verified: 78.7% vs. 66.7% unverified (12-point gap)
  — a smaller gap than Qwen3-32B's, meaning its unverified-quote rows are
  still reasonably trustworthy.
- Fastest of the three by a wide margin: 1.8s average latency (vs. Qwen's
  10.3s and Sonnet 5's 3.4s) — despite being architecturally a reasoning
  model, it did not spend heavily on hidden reasoning tokens on this task
  once given headroom (`BENCHMARK_MAX_TOKENS` raised to 16384 this same day;
  under the old 1000-token cap this model could not complete most rows at
  all — see [Caveats](#caveats-read-before-comparing)).
- Notably **leads on supported-vs-rest (76.8%) despite the lowest exact
  accuracy of the three** — 30 of its 45 non-exact-match wrong rows were a
  Partially-supported↔Not-supported confusion, which that metric forgives
  and the others don't (or don't as fully).

**Confusion matrix** (rows = ground truth, columns = predicted):

| Truth \ Predicted | Supported | Partially supported | Not supported | Source unavailable |
|---|---|---|---|---|
| Supported | 47 | 11 | 21 | 1 |
| Partially supported | 6 | 20 | 28 | 2 |
| Not supported | 1 | 2 | 42 | 0 |
| Source unavailable | 0 | 0 | 0 | 0 |

### Claude Sonnet 5 (`claude-sonnet-5`, direct API)

- 182/182 valid, 0 errors.
- Ran with `output_config.effort: "medium"` (see `run_benchmark.js`'s
  `PROVIDERS['claude-sonnet-5']`) rather than the API default of `"high"` —
  a deliberate cost/latency tradeoff for this benchmark, not necessarily
  Sonnet 5's ceiling on this task under maximum reasoning effort.
- Lowest exact (54.4%) and lenient (64.8%) accuracy of the three, but a
  binary accuracy (73.6%) reasonably close to the pack — similar to how
  Claude Sonnet 4.5 behaved in the original four-model benchmark (see
  [Caveats](#caveats-read-before-comparing)): a wider-than-usual gap between
  exact/lenient and binary/supported-vs-rest, suggesting more of its misses
  land as a confident wrong verdict rather than a Partial/Not near-miss.
- Confusion matrix, quote fidelity, confidence calibration, and precision/recall
  not yet captured for this write-up — see the note under Raw data above.

## Precision / recall (Supported vs. requires-action)

A different framing from the four accuracy metrics above: **Supported is the
only positive class**; {Partially supported, Not supported, Source
unavailable} are all "negative" — i.e. "an editor needs to look at this."
This is the same binary split `main.js`'s actual `showActionButton` logic
uses (only a `SUPPORTED` verdict skips the "Edit Section" prompt) — distinct
from both `binaryAccuracy` (which groups Partially-supported with Supported)
and `supported-vs-rest` (which requires Supported and Source-unavailable to
match exactly but forgives Partially↔Not). Neither of those two groupings
matches this one; this section exists because it doesn't correspond to any
field `analyze_results.js` currently computes.

| Model | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| Qwen3-32B | 53 | 13 | 27 | 89 | 80.3% | 66.3% | 72.6% |
| gpt-oss-20b | 47 | 7 | 33 | 94 | 87.0% | 58.8% | 70.1% |

Both models are precision-heavy, recall-light: when either predicts
"Supported," it's right 80–87% of the time, but both miss a substantial share
of genuinely supported claims (34% for Qwen3-32B, 41% for gpt-oss-20b) —
predicting one of the "needs review" verdicts on a citation that was actually
fine. gpt-oss-20b is the more conservative of the two: higher precision,
lower recall. For an editor-facing tool this is arguably the safer direction
to err in — a false "needs review" costs an editor a wasted check, while a
false "Supported" lets a bad citation through — but it does mean a real share
of good citations get flagged unnecessarily.

Not yet available for Claude Sonnet 5 — needs its confusion matrix (see the
note under Raw data above and in the Sonnet 5 section).

## Caveats (read before comparing)

**These three ran under directly comparable conditions with each other** —
same 182-row dataset, same system prompt, same day, same
`BENCHMARK_MAX_TOKENS` (16384). The comparisons above, among these three, are
fair.

**Comparing against the older four-model benchmark is not fair without
adjustment**, for several independent reasons:

1. **Row count differs.** The older run (`claude-sonnet-4-5`,
   `gemini-2.5-flash`, `apertus-70b`, `qwen-sealion`) has 186 rows each in
   `results.json`; these three ran on 182. The dataset has shifted by a few
   rows since then (row corrections / `needs_manual_review` changes).
2. **`BENCHMARK_MAX_TOKENS` was 1000 for the older run, 16384 for this one.**
   This matters most for reasoning-capable models: gpt-oss-20b specifically
   could not complete most rows under the old 1000-token cap (see
   `benchmark/README.md` § "Re-baselining: max_tokens 1000 → 16384") — a
   like-for-like comparison against an older reasoning-model run isn't
   possible because the older cap made that class of model largely unusable.
3. **The system prompt has changed** between the two runs (most recently:
   source-quote extraction, 2026-08-04) — the older run's Claude Sonnet 4.5
   number reflects an earlier prompt version, not today's.
4. **Two of these three models' raw per-row data is gone.** Qwen3-32B's and
   gpt-oss-20b's `results.json` rows were lost to a bug (a plain benchmark run
   with no `--resume` silently discarded every other provider's rows — fixed
   in `loadInitialResults`, see `benchmark/run_benchmark.js`). Only the
   aggregate metrics in `analysis_hf_keyless_2026-08-17.json` survive for
   those two; `inspect_results.js`-style row inspection and `npm run compare`
   diffing are not possible against them. Claude Sonnet 5's raw rows are
   intact (as of writing, only locally).
5. **Single run, no repeated trials.** All numbers above are from one pass at
   temperature 0.1 (except Sonnet 5's `effort: medium`, which doesn't map to
   a temperature). No variance/confidence interval has been measured across
   repeated runs for any of the six models discussed here (these three or the
   original four).

Given (2) and (3) especially, treat any "model X beat model Y" claim spanning
the two benchmark rounds with real skepticism — most of the older-round
providers would need to be re-run under the current prompt and token cap
before that comparison means anything.
