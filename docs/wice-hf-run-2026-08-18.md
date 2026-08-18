# WiCE benchmark run — Qwen3-32B and gpt-oss-20b via keyless HF Inference (2026-08-18)

## Overview

The first full run of the verifier against [WiCE](https://github.com/ryokamoi/wice)
(707 dev+test rows, converted per `benchmark/convert_wice.js`), covering
**Qwen3-32B** and **gpt-oss-20b**, both via Hugging Face Inference's keyless
proxy path. For what WiCE is, how the conversion works, and — most
importantly — how to read these numbers without over- or under-crediting the
model, see [`docs/wice-benchmark.md`](wice-benchmark.md); this document is
the results, that one is the methodology, and the two should be read
together. This is a distinct exercise from the regular `dataset.json`
benchmarks ([`docs/llm-benchmarking-overview.md`](llm-benchmarking-overview.md),
[`docs/hf-keyless-and-sonnet-5-benchmark.md`](hf-keyless-and-sonnet-5-benchmark.md))
— different corpus, different population (WiCE deliberately excludes
trivially-supported claims), not head-to-head comparable with either.

**Raw data:** `benchmark/results_wice.json`, `benchmark/analysis_wice.json`,
`benchmark/analysis_wice_unanimous.json`, `benchmark/analysis_wice_mixed.json`
— generated locally via `npm run wice:benchmark` / `wice:analyze*`, not yet
committed to the repo (see [Caveats](#caveats-read-before-comparing)).

## Headline comparison (all 706 benchmarked rows)

| Model | Exact | Lenient | Binary | Supported-vs-rest | Avg latency | Errors |
|---|---|---|---|---|---|---|
| Qwen3-32B | 62.2% | 81.2% | 81.2% | 78.9% | 10,227ms | 0/706 |
| gpt-oss-20b | 53.1% | 64.6% | 64.6% | 84.4% | 1,682ms | 3/706 |

Metric definitions: see `benchmark/README.md` § Metrics Explained. **Lenient
and Binary are identical for both models here, and always will be on WiCE** —
WiCE has no `Source unavailable` label and no reason for a model to predict
one, so with that class empty, Binary's `{Supported,Partial}` vs.
`{Not,Unavailable}` split and Lenient's `Supported↔Partial` forgiveness
collapse into the same partition. Treat the two as one number on this
dataset, not two independent readings.

**Supported-vs-rest** is the metric worth anchoring on for WiCE specifically:
it's the grouping (`Supported` exact, `Partially supported ↔ Not supported`
forgiven) that matches WiCE's own claim-level binary task, making it the one
column here comparable to the paper's baselines — human 92.0%, best
off-the-shelf system 75.1% (see `docs/wice-benchmark.md` § "Reading a WiCE
score" before drawing conclusions from that comparison).

## Per-model detail

### Qwen3-32B (`Qwen/Qwen3-32B`, via HF Inference)

- 706/706 valid, 0 errors.
- Slowest of the two: 10.2s average latency (vs. gpt-oss-20b's 1.7s) — same
  relative ordering as the regular-dataset HF-keyless run.

**By label projection** (see `docs/wice-benchmark.md` § "Claim-level labels
are derived, not annotated" — `unanimous` rows have a claim label the
annotators actually agreed on; `mixed` rows have a `Partially supported`
label that is an artifact of WiCE's subclaim-projection rule, not a direct
annotation):

| Split (n) | Exact | Lenient/Binary | Supported-vs-rest |
|---|---|---|---|
| Unanimous (328) | 78.4% | 90.5% | 84.1% |
| Mixed (378) | 48.1% | 73.0% | 74.3% |

Real degradation on mixed rows, but softened relative to Exact: Supported-vs-rest
drops 9.8 points (84.1→74.3) where Exact drops 30.3 points (78.4→48.1). A
meaningful share of the apparent mixed-row inaccuracy is the projection
label, not model error — but unlike gpt-oss-20b below, it doesn't fully
account for it.

### gpt-oss-20b (`openai/gpt-oss-20b`, via HF Inference)

- 703/706 valid, 3 errors (initial 429s from HF Inference resolved by
  dropping to `--concurrency=1`; see [Caveats](#caveats-read-before-comparing)).
- Fastest of the two by a wide margin: 1.7s average latency.
- **Leads on Supported-vs-rest (84.4%) despite the lowest Exact accuracy
  (53.1%) of the two** — same shape as this model showed on the regular
  dataset (`docs/hf-keyless-and-sonnet-5-benchmark.md`: 76.8% vs. lowest
  Exact of that run's three too). Consistent behavior across two different
  corpora: it tends to call a claim `Not supported` rather than credit
  partial support, which Supported-vs-rest forgives and Exact doesn't.

**By label projection:**

| Split (n) | Exact | Lenient/Binary | Supported-vs-rest |
|---|---|---|---|
| Unanimous (328) | 74.6% | 85.3% | 80.7% |
| Mixed (378) | 34.3% | 46.5% | **87.5%** |

This is the clean case the projection split exists to catch. On mixed rows,
Exact collapses to 34.3% — but Supported-vs-rest *rises* to 87.5%, higher
than its own unanimous figure. That combination means the mixed-row "errors"
are not random: gpt-oss-20b is making a consistent, defensible whole-claim
call (usually `Not supported`) on exactly the claims where WiCE's projection
rule alone produced a `Partially supported` label because *some* subclause
disagreed — not because a human judged the whole claim partial. Read
literally, Exact accuracy on this model's mixed-row performance is measuring
WiCE's labeling artifact at least as much as it's measuring the model.

### DeepSeek-V3 — excluded, not a real data point

`hf-deepseek-v3` was never run against the full 706-row corpus. Only 20 rows
exist for it (13 unanimous + 7 mixed), left over from an early small-scale
test before the 429 fix — and **all 20 errored**. Its 0.0% across every
metric in the raw `analyze_results.js` output is not a performance figure,
it's "this provider never once returned a usable response" — a distinct,
unrelated failure mode from gpt-oss-20b's now-resolved 429s. Investigate with
`node inspect_results.js --provider=hf-deepseek-v3 --status=error --full`
before re-running it at scale; it doesn't belong in a ranking next to the
other two until that's understood.

## Caveats (read before comparing)

1. **Not comparable to the regular `dataset.json` benchmarks.** WiCE
   deliberately excludes trivially-supported claims (it retains 16.3% of its
   candidate pool — see `docs/wice-benchmark.md`), so lower absolute numbers
   here than on `dataset.json` reflect a harder population, not a worse
   model. The per-model behavioral pattern (gpt-oss-20b's Supported-vs-rest
   lead despite lowest Exact) replicating across both corpora is the
   meaningful cross-benchmark signal, not the absolute numbers.
2. **The initial small-scale test (20 rows, default concurrency) hit HF
   Inference rate limits** — 6/20 errors on both models. Re-run at
   `--concurrency=1` with `--resume` (retrying only the errored rows) is
   what produced the clean 0/706 and 3/706 error counts above.
3. **Single run, no repeated trials**, same as every other benchmark round
   in this repo to date — no variance has been measured across repeated
   passes for either model.
4. **Raw per-row files not yet committed.** `results_wice.json` and the
   three `analysis_wice*.json` files exist locally only at time of writing.
   Row-level inspection (`inspect_results.js --dataset=dataset_wice.json
   --results=results_wice.json`) is possible locally but the underlying data
   isn't yet in the repo for anyone else to reproduce the exact confusion
   matrix without re-running.
5. **`dataset_wice.json` itself is gitignored and regenerated**
   (`npm run wice:convert`), not committed — see `docs/wice-benchmark.md` §
   "`dataset_wice.json` is generated, not committed" for why, including the
   sha256 that confirms two conversions produced the same corpus.
