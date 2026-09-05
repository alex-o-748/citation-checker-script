# Full 7-provider benchmark — Gemini leads (2026-08-23)

## Overview

`benchmark/analysis.json` (generated 2026-08-23) is the first point where
results for all seven providers ever benchmarked against `dataset.json` sit
in one file: **apertus-70b**, **qwen-sealion**, **claude-sonnet-4-5**,
**gemini-2.5-flash**, **claude-sonnet-5**, **gemini-3.7-flash**, and
**hf-gpt-oss-20b**. Four of those seven were never written up together
before — Gemini in particular has only appeared in passing, in
[`docs/roc-curves.md`](roc-curves.md)'s threshold analysis and in
[`benchmark/historical-runs/comparison-2026-05-02.md`](../benchmark/historical-runs/comparison-2026-05-02.md)'s
historical-prompt replay. This document is the accuracy write-up: **on
today's full panel, `gemini-3.7-flash` has the highest exact accuracy
(67.1%) of any provider ever benchmarked against this dataset**, with
`gemini-2.5-flash` a close second (66.7%). Read the
[Caveats](#caveats-read-before-comparing) section before treating that as a
clean head-to-head win — the seven providers were **not** all run under the
same prompt or the same dataset size.

**Raw data:** [`benchmark/results.json`](../benchmark/results.json) and
[`benchmark/analysis.json`](../benchmark/analysis.json), both committed —
`node analyze_results.js` reproduces the table below exactly.

## Headline comparison (all providers, ranked by exact accuracy)

| Provider | Exact | Lenient | Binary | Supported-vs-rest | Avg latency | Errors |
|---|---:|---:|---:|---:|---:|---:|
| **gemini-3.7-flash** | **67.1%** | 79.8% | 80.9% | **79.8%** | 13,067ms | 9/182 |
| gemini-2.5-flash | 66.7% | 85.5% | 85.5% | 75.8% | 3,742ms | 0/186 |
| hf-gpt-oss-20b | 62.6% | 69.8% | 69.8% | 78.6% | 3,048ms | 0/182 |
| qwen-sealion | 60.0% | 85.8% | 87.1% | 63.9% | 3,425ms | 31/186 |
| claude-sonnet-5 | 54.4% | 64.8% | 73.6% | 70.3% | 3,444ms | 0/182 |
| apertus-70b | 54.2% | 83.9% | 84.5% | 62.6% | 3,443ms | 31/186 |
| claude-sonnet-4-5 | 48.9% | 68.8% | 84.9% | 54.8% | 4,021ms | 0/186 |

Metric definitions: see `benchmark/README.md` § Metrics Explained (the same
four columns used in
[`docs/hf-keyless-and-sonnet-5-benchmark.md`](hf-keyless-and-sonnet-5-benchmark.md)).
Note that no single column is uniformly "best" — qwen-sealion and
apertus-70b lead Binary despite mid-pack Exact, because both lean heavily on
"Partially supported" as a hedge (visible in their confusion matrices below),
which Binary and Lenient forgive and Exact doesn't.

## Winner: gemini-3.7-flash (`gemini-3.7-flash`, direct API)

- 173/182 valid, **9 errors (4.9%)** — the highest error rate of the four
  providers run with zero-to-low failure rates (claude-sonnet-4-5,
  gemini-2.5-flash, claude-sonnet-5, and hf-gpt-oss-20b all ran 0 errors;
  only apertus-70b and qwen-sealion, at 31/186 each, ran worse).
- **Highest exact accuracy of any provider in this file (67.1%)** and ties
  the lead on supported-vs-rest (79.8%, tied with itself as the top scorer —
  hf-gpt-oss-20b is next at 78.6%).
- **By far the slowest provider benchmarked here**: 13.1s average latency,
  ranging up to **66.7 seconds** on its slowest row — roughly 3-4x every
  other provider's average and well outside what the userscript's sidebar
  could return within an editor's patience on a bad day. This is a real
  cost of the accuracy win, not a footnote to skip.
- Quote fidelity: offered a quote on 103/103 eligible rows (100% offer
  rate), 101 of those verified in the source (98.1% fidelity) — the best
  fidelity of any provider with quote tracking (claude-sonnet-5: 92.5%,
  hf-gpt-oss-20b: 82.8%).
- Accuracy when the quote verified: 75.2% vs. 50.0% when it didn't verify —
  a 25.2-point gap, the largest of the three providers with quote data. A
  verified gemini-3.7-flash quote is a much stronger trust signal than an
  unverified one (only 2 rows fell in the unverified bucket, so treat that
  50.0% as a small-sample figure, not a stable rate).
- Confidence calibration: 58.9 average on correct rows vs. 39.5 on wrong
  ones (19.5-point gap) — better than gemini-2.5-flash's or hf-gpt-oss-20b's
  gap (11.5 and 9.4 points respectively), but well short of claude-sonnet-5's
  35.2-point gap in the same panel.

**Confusion matrix** (rows = ground truth, columns = predicted; 173 valid
rows):

| Truth \ Predicted | Supported | Partially supported | Not supported | Source unavailable |
|---|---|---|---|---|
| Supported | 48 | 19 | 6 | 3 |
| Partially supported | 3 | 29 | 18 | 2 |
| Not supported | 0 | 4 | 39 | 2 |
| Source unavailable | 0 | 0 | 0 | 0 |

Notice the same hedging pattern as gpt-oss-20b showed in
`docs/hf-keyless-and-sonnet-5-benchmark.md`: 18 of 52 Partially-supported
ground-truth rows got called Not supported rather than credited partial —
a Partial↔Not confusion that Exact punishes and Supported-vs-rest forgives,
part of why gemini-3.7-flash's supported-vs-rest (79.8%) sits well above its
lenient/binary (79.8%/80.9% — unusually close together here since it barely
ever confuses Supported with Not-supported directly: only 6 of 76 Supported
rows dropped that far).

## Runner-up: gemini-2.5-flash (`gemini-2.5-flash`, direct API)

- 186/186 valid, 0 errors — perfect reliability, unlike gemini-3.7-flash.
- Exact accuracy (66.7%) is within half a point of gemini-3.7-flash's, but
  **wins clearly on Lenient/Binary (85.5% vs. 79.8%/80.9%)** and on
  latency (3.7s vs. 13.1s average) and reliability (0 vs. 9 errors).
- No quote-verification data — this run predates the 2026-08-04 source-quote
  extraction feature (see [Caveats](#caveats-read-before-comparing)).
- Confidence ("support_score" in this run's schema): 60.0 average, 50.9 on
  correct rows vs. 39.4 on wrong ones (11.5-point gap) — a real but modest
  calibration signal, well below gemini-3.7-flash's or claude-sonnet-5's.

**Confusion matrix** (186 valid rows):

| Truth \ Predicted | Supported | Partially supported | Not supported | Source unavailable |
|---|---|---|---|---|
| Supported | 52 | 20 | 6 | 2 |
| Partially supported | 15 | 33 | 10 | 1 |
| Not supported | 1 | 7 | 39 | 0 |
| Source unavailable | 0 | 0 | 0 | 0 |

**Practical read:** if the choice were only between the two Gemini
generations on this data, gemini-2.5-flash is the safer default —
essentially the same exact accuracy, a large lead on every other accuracy
column, zero errors, and roughly a quarter of the latency. gemini-3.7-flash
only pulls ahead on the single headline number (Exact) and on
quote-fidelity, at a real reliability and latency cost.

## The other five providers (previously documented)

Full detail for these is in the docs already linked above; ranked here by
exact accuracy for context:

| Provider | Exact | Lenient | Binary | Supported-vs-rest | Avg latency | Errors |
|---|---:|---:|---:|---:|---:|---:|
| hf-gpt-oss-20b | 62.6% | 69.8% | 69.8% | 78.6% | 3,048ms | 0/182 |
| qwen-sealion | 60.0% | 85.8% | 87.1% | 63.9% | 3,425ms | 31/186 |
| claude-sonnet-5 | 54.4% | 64.8% | 73.6% | 70.3% | 3,444ms | 0/182 |
| apertus-70b | 54.2% | 83.9% | 84.5% | 62.6% | 3,443ms | 31/186 |
| claude-sonnet-4-5 | 48.9% | 68.8% | 84.9% | 54.8% | 4,021ms | 0/186 |

hf-gpt-oss-20b and claude-sonnet-5 are covered in full in
[`docs/hf-keyless-and-sonnet-5-benchmark.md`](hf-keyless-and-sonnet-5-benchmark.md)
(note: the numbers there were computed on a 182-row snapshot and match this
file's 182-row figures for those two providers exactly). apertus-70b and
qwen-sealion are covered in
[`docs/llm-benchmarking-overview.md`](llm-benchmarking-overview.md), though
that document's numbers (76-row dataset, 2026-01-23) do **not** match this
file's (186-row dataset, 2026-04-30/05-02 run) — see
[Caveats](#caveats-read-before-comparing). claude-sonnet-4-5 has not had a
dedicated write-up; its 186-row figures here are the most current available.

## Caveats (read before comparing)

**These seven providers did not all run under the same conditions.** Two
distinct eras sit in this one file:

1. **apertus-70b, qwen-sealion, claude-sonnet-4-5, gemini-2.5-flash** — all
   four ran 2026-04-30/05-02, against a 186-row dataset snapshot, **before**
   the 2026-08-04 source-quote-extraction prompt change. That's why all four
   show zeroed-out `quotes` fields in `analysis.json` — the schema for
   tracking quote offer/fidelity didn't exist yet for this run.
2. **claude-sonnet-5, gemini-3.7-flash, hf-gpt-oss-20b** — ran 2026-08-17,
   2026-08-20, and 2026-08-23 respectively, against a 182-row snapshot,
   **after** the quote-extraction prompt change, which is why only these
   three carry quote data.

**The headline "gemini-3.7-flash wins" comparison spans both eras** —
it beats gemini-2.5-flash's *older-prompt* score, not a same-prompt rerun.
Nobody has re-run gemini-2.5-flash (or apertus-70b, qwen-sealion,
claude-sonnet-4-5) against the current quote-extraction prompt, so it's
unknown whether gemini-2.5-flash's numbers would rise, fall, or hold if it
were. Until that re-run happens, "gemini-3.7-flash is a strict upgrade over
gemini-2.5-flash" is not a claim this data supports — only "gemini-3.7-flash
scored highest of everything run so far" is.

Other reasons to be careful with this table:

3. **Row count differs and neither matches today's dataset.** The dataset
   has grown to 189 rows since either run (186 and 182 respectively) — see
   `benchmark/dataset.json`'s current count. `docs/hf-keyless-and-sonnet-5-benchmark.md`'s
   caveats explain the specific `entry_id` drift risk this creates.
4. **Confidence field naming is inconsistent across the two eras** —
   apertus-70b/qwen-sealion/claude-sonnet-4-5/gemini-2.5-flash's metrics
   object calls the field `support_score`; claude-sonnet-5/gemini-3.7-flash/
   hf-gpt-oss-20b's calls it `confidence`. Both represent the same
   underlying "how confident is the model in its stated verdict" number;
   this document reports both under "confidence" for readability.
5. **Single run, no repeated trials**, same caveat as every other benchmark
   round in this repo — no variance has been measured across repeated
   passes for any of these seven providers.
6. **apertus-70b and qwen-sealion's 31/186 errors are unexplained in this
   file** — `analysis.json` records the count but not the cause; check
   `results.json` row-by-row (`error` field) before citing their accuracy
   figures as if computed over the full 186, since they're actually computed
   over the 155 valid rows each.
7. **gemini-3.7-flash's latency figures include at least one severe outlier**
   (66.7s on its slowest row, against a 13.1s mean) — a single slow response
   pulling the average up substantially versus its median behavior. Treat
   the 13.1s figure as "this provider can take a very long time
   occasionally," not "this provider typically takes 13 seconds."

Given (1) and (2) especially: the fair headline from this data is **"Gemini
(both generations) is the strongest performer on exact accuracy of anything
benchmarked against this dataset so far,"** not **"gemini-3.7-flash beats
gemini-2.5-flash."** A same-prompt, same-dataset rerun of gemini-2.5-flash
(and the other three older-era providers) is the natural next step before
drawing that second, narrower conclusion.
