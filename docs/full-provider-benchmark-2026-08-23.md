# Full 8-provider benchmark — Gemini leads (run 2026-08-23, rescored 2026-09-08)

## Overview

`benchmark/results.json` holds every provider ever benchmarked against
`dataset.json` — now **eight** of them: **apertus-70b**, **qwen-sealion**,
**claude-sonnet-4-5**, **gemini-2.5-flash**, **claude-sonnet-5**,
**gemini-3.7-flash**, **hf-gpt-oss-20b**, and **liftwing-qwen3.6-27b**.

**This document has been rescored** against the revised dataset described in
[`docs/benchmark-revision-2026-09-07.md`](benchmark-revision-2026-09-07.md) and
[`docs/benchmark-ground-truth-audit-2026-09-06.md`](benchmark-ground-truth-audit-2026-09-06.md).
No model was re-run — every prediction here is the same one the original
2026-04/05 and 2026-08 runs produced. What moved is **what they are scored
against**:

1. **Long sources are separated out, not pooled.** 48 of 189 rows store a
   source truncated at the CORS proxy's 12,000-character cap, so the model saw
   a prefix while the human labeller read the whole page. The headline table
   below is now the **strict set** — the 140 rows where the model and the
   labeller saw the same document.
2. **Six ground-truth labels were corrected** (`row_18`, `row_24`, `row_71`,
   `row_81`, `row_102`, `row_159`), each hand-checked against the stored claim
   and source.
3. **One row is excluded outright** (`row_108`): its claim and its cited URL
   are unrelated, so no verifier can do better or worse on it.
4. **Two stale labels embedded in `results.json` were re-synced** from the
   dataset — see [What changed](#what-changed-since-this-documents-first-version).

The headline: **on the strict set, `gemini-3.7-flash` has the highest exact
accuracy of any provider ever benchmarked against this dataset (74.8%)**, with
`gemini-2.5-flash` second (71.5%). That gap is now ~3 points rather than the
half-point the pooled scoring showed — removing the truncated rows helps
gemini-3.7-flash more than any other provider. Read
[Caveats](#caveats-read-before-comparing) before treating it as a clean
head-to-head win: the eight providers were **not** all run under the same
prompt, and the four older ones were run before the dataset they are scored
against was even extracted.

**Raw data:** [`benchmark/results.json`](../benchmark/results.json),
[`benchmark/analysis.json`](../benchmark/analysis.json) (all rows),
[`benchmark/analysis_full_sources.json`](../benchmark/analysis_full_sources.json)
(strict) and
[`benchmark/analysis_truncated_sources.json`](../benchmark/analysis_truncated_sources.json),
all committed. From `benchmark/`:

```bash
npm run analyze                    # all rows, prints the whole/truncated split
npm run analyze:full-sources       # the strict 140-row set — the table below
npm run analyze:truncated-sources  # the 48 rows the cap cut short
```

## Headline comparison — strict set (whole sources only)

140 rows: 59 `Supported`, 44 `Partially supported`, 36 `Not supported`,
1 `Source unavailable`. Of those, 137 have results from the older-era providers
and 133 from the newer ones (see [Caveats](#caveats-read-before-comparing) (3)).
Ranked by exact accuracy:

| Provider | Exact | Lenient | Binary | Supported-vs-rest | Exact (all rows) |
|---|---:|---:|---:|---:|---:|
| **gemini-3.7-flash** | **74.8%** | 86.6% | 88.2% | **85.0%** | **69.2%** |
| gemini-2.5-flash | 71.5% | **88.3%** | 88.3% | 79.6% | 67.6% |
| hf-gpt-oss-20b | 67.7% | 75.2% | 75.2% | 81.2% | 65.2% |
| qwen-sealion | 65.2% | 87.8% | **89.6%** | 69.6% | 60.6% |
| claude-sonnet-5 | 60.2% | 70.7% | 79.7% | 83.5% | 57.5% |
| apertus-70b | 54.8% | 84.3% | 85.2% | 62.6% | 54.8% |
| claude-sonnet-4-5 | 52.6% | 70.8% | 86.1% | 76.6% | 50.3% |
| liftwing-qwen3.6-27b | 51.9% | 62.4% | 72.9% | 79.7% | 49.7% |

Metric definitions: see `benchmark/README.md` § Metrics Explained. The two
columns worth keeping apart:

- **Exact** — the verdict matches the label across all four classes. Nothing is
  forgiven, so calling a partially-supported claim unsupported is as wrong as
  calling it supported.
- **Supported-vs-rest** — `Supported` must still match exactly, but the three
  ways a citation can fail count as mutually equivalent. It answers the question
  an editor actually has: *does this citation carry the claim, yes or no?*

No column is uniformly "best", and the two rank differently:
`liftwing-qwen3.6-27b` goes from last on Exact to fourth on supported-vs-rest,
`claude-sonnet-5` from fifth to second. qwen-sealion and apertus-70b lead Binary
despite mid-pack Exact because both lean on "Partially supported" as a hedge
(visible in their confusion matrices), which Binary and Lenient forgive and Exact
doesn't.

Reliability and latency are properties of the run, not of the scoring set, so
they are reported over every call (all rows, `row_108` aside):

| Provider | Avg latency | Max | Errors | Cause |
|---|---:|---:|---:|---|
| hf-gpt-oss-20b | 3,060ms | 20,156ms | 0/181 | — |
| qwen-sealion | 3,441ms | 7,381ms | 30/185 | HTTP 402, wallet balance exhausted |
| claude-sonnet-5 | 3,451ms | 10,347ms | 0/181 | — |
| apertus-70b | 3,459ms | 9,519ms | 30/185 | HTTP 402, wallet balance exhausted |
| gemini-2.5-flash | 3,752ms | 16,386ms | 0/185 | — |
| claude-sonnet-4-5 | 4,026ms | 8,974ms | 0/185 | — |
| liftwing-qwen3.6-27b | 6,491ms | 20,622ms | 0/181 | — |
| **gemini-3.7-flash** | **13,130ms** | **66,666ms** | 9/181 | HTTP 503, "high demand" |

apertus-70b's and qwen-sealion's 30 errors each are a **billing failure, not a
model failure** — every one is `HTTP 402: Insufficient wallet balance` from the
PublicAI endpoint, hit partway through the 2026-05-02 run. Their accuracy
figures are therefore computed over 155 valid calls (137 strict), not 185. This
was listed as unexplained in this document's first version.

## Winner: gemini-3.7-flash (direct API)

- **Highest exact accuracy of any provider ever benchmarked here (74.8% strict,
  69.2% all rows)** and the highest supported-vs-rest (85.0%).
- **Benefits most from the strict set**: +21.5 points between truncated
  (53.3%) and whole (74.8%) sources — the largest gap of the eight. On pooled
  scoring it looked half a point ahead of gemini-2.5-flash; on rows where it
  actually saw the document, it is ~3 points ahead.
- 127/133 valid on the strict set, **9 errors over the full run (5.0%)** — all
  HTTP 503 "high demand", and the worst rate of the six providers that weren't
  billing-capped (the other five ran zero errors).
- **By far the slowest provider benchmarked here**: 13.1s average, up to
  **66.7 seconds** on its slowest row — roughly 3-4× every other provider's
  average and well outside what the userscript's sidebar could return within an
  editor's patience on a bad day. This is a real cost of the accuracy win, not a
  footnote to skip.
- Quote fidelity: offered a quote on 81/81 eligible strict rows (100% offer
  rate), 79 of those verified in the source (**97.5% fidelity**) — the best of
  the four providers with quote tracking (claude-sonnet-5 93.0%,
  liftwing-qwen3.6-27b 90.5%, hf-gpt-oss-20b 83.8%).
- Accuracy when the quote verified: 79.7% vs. 50.0% when it didn't — but only 2
  strict rows fall in the unverified bucket, so treat that second figure as
  anecdote, not a rate.
- Confidence calibration: 59.1 average on correct rows vs. 44.2 on wrong ones
  (14.9-point gap) — better than gemini-2.5-flash's (13.2) or hf-gpt-oss-20b's
  (7.5), but far short of liftwing-qwen3.6-27b's 40.2 or claude-sonnet-4-5's
  36.4. A high gemini-3.7-flash confidence score is a weak signal compared to
  those two.

**Confusion matrix, strict set** (rows = ground truth, columns = predicted; 127
valid rows):

| Truth \ Predicted | Supported | Partially supported | Not supported | Source unavailable |
|---|---|---|---|---|
| Supported | 38 | 13 | 3 | 1 |
| Partially supported | 2 | 26 | 7 | 2 |
| Not supported | 0 | 2 | 31 | 2 |
| Source unavailable | 0 | 0 | 0 | 0 |

Its errors are almost entirely one-step: only 3 of 55 Supported rows fall as far
as Not supported, and 0 of 35 Not supported rows are called Supported. That is
why its lenient/binary (86.6%/88.2%) and supported-vs-rest (85.0%) sit close
together — it rarely confuses the two ends, it just disagrees about the middle.

## Runner-up: gemini-2.5-flash (direct API)

- 137/137 valid on the strict set, 0 errors over the whole run — perfect
  reliability, unlike gemini-3.7-flash.
- 71.5% exact, ~3 points behind gemini-3.7-flash, but **wins Lenient (88.3% vs.
  86.6%)**, and wins decisively on latency (3.8s vs. 13.1s average) and
  reliability (0 vs. 9 errors).
- Loses supported-vs-rest by 5.4 points (79.6% vs. 85.0%) — on the yes/no
  question an editor actually asks, gemini-3.7-flash is clearly better.
- No quote-verification data — this run predates the 2026-08-04 source-quote
  extraction feature (see [Caveats](#caveats-read-before-comparing)).
- Confidence: 51.8 on correct rows vs. 38.6 on wrong ones (13.2-point gap) — a
  real but modest calibration signal.

**Confusion matrix, strict set** (137 valid rows):

| Truth \ Predicted | Supported | Partially supported | Not supported | Source unavailable |
|---|---|---|---|---|
| Supported | 39 | 15 | 3 | 1 |
| Partially supported | 8 | 31 | 4 | 1 |
| Not supported | 1 | 6 | 28 | 0 |
| Source unavailable | 0 | 0 | 0 | 0 |

**Practical read:** between the two Gemini generations, the choice is now a real
trade rather than a wash. gemini-3.7-flash is better at the task (+3.3 exact,
+5.4 supported-vs-rest, near-perfect quote fidelity); gemini-2.5-flash is 3.5×
faster and didn't drop a single call. For an interactive sidebar where the user
is waiting, 2.5's latency and reliability may still win; for a batch run where
nobody is watching the clock, 3.7's accuracy is the better buy.

## The other six providers

Ranked by strict exact accuracy, with the truncation gap that the previous
pooled scoring hid:

| Provider | Exact (strict) | Exact (truncated rows) | Gap | Supported-vs-rest (strict) |
|---|---:|---:|---:|---:|
| hf-gpt-oss-20b | 67.7% | 58.3% | 9.3 | 81.2% |
| qwen-sealion | 65.2% | 47.5% | 17.7 | 69.6% |
| claude-sonnet-5 | 60.2% | 50.0% | 10.2 | 83.5% |
| apertus-70b | 54.8% | 55.0% | −0.2 | 62.6% |
| claude-sonnet-4-5 | 52.6% | 43.8% | 8.8 | 76.6% |
| liftwing-qwen3.6-27b | 51.9% | 43.8% | 8.1 | 79.7% |

Two entries stand out. **apertus-70b is the only provider that doesn't improve
on whole sources** — it scores the same either way, which is consistent with a
model hedging toward "Partially supported" largely independent of what the
source says (84.3% lenient against 54.8% exact). And **claude-sonnet-5 ranks
fifth on Exact but second on supported-vs-rest (83.5%)**, because 12 of its 36
Not-supported rows are called `Source unavailable` — a verdict Exact counts
wrong and supported-vs-rest folds into "this citation doesn't carry the claim",
which is the answer an editor wanted anyway.

hf-gpt-oss-20b and claude-sonnet-5 are covered in full in
[`docs/hf-keyless-and-sonnet-5-benchmark.md`](hf-keyless-and-sonnet-5-benchmark.md);
apertus-70b and qwen-sealion in
[`docs/llm-benchmarking-overview.md`](llm-benchmarking-overview.md).
**Neither document has been rescored** — their figures are the pre-revision,
pooled-scoring ones, so they will not match this file. claude-sonnet-4-5 and
liftwing-qwen3.6-27b have no dedicated write-up; their figures here are the most
current available.

## What the truncated rows cost

Pooled across all eight providers:

| Source | Result rows | Exact | Supported-vs-rest |
|---|---:|---:|---:|
| Stored whole | 1,030 | **62.3%** | **77.6%** |
| Truncated at the cap | 365 | 51.0% | 72.1% |
| | | 11.4-point gap | 5.5-point gap |

The gap is much larger on Exact than on supported-vs-rest, and roughly 40% of it
is unrewardable `Source unavailable`: models emit that verdict more often when
the source is a fragment, and effectively no scoreable row carries that label
(`row_111` does, but no provider has ever run it), so it is always scored wrong.
The audit doc carries the decomposition.

**The truncated rows are flagged, not deleted.** The userscript hits the same
12,000-character cap, so these rows reproduce a real production failure —
dropping them from the dataset would raise the headline ~4 points while the tool
got no better, and would delete the only evidence the failure exists. The strict
set answers "how good is the model's judgement"; the all-rows figure answers
"how good is the tool an editor actually installs". Both belong in the table
above, which is why both are there.

## The weakest class is `Partially supported`

Pooled across the eight providers on the strict set:

| Ground truth | Accuracy |
|---|---:|
| Supported | 72.8% (332/456) |
| Not supported | 64.8% (160/247) |
| **Partially supported** | **45.9%** (150/327) |

Part of that is a genuine rubric ambiguity, not model error: when a source
contradicts one specific figure or date but supports everything else,
`core/prompts.js` steers the model toward NOT SUPPORTED (its own few-shot: claim
says 45 nations, source says "over 30" → NOT SUPPORTED), while the v2/v3
labelling convention maps the same shape to *Partially supported*. `row_102` and
`row_186` are the same shape carrying opposite labels. Worth settling as a rubric
decision rather than row by row.

## What changed since this document's first version

The 2026-08-23 version of this file reported pooled scoring against the
uncorrected labels. Exact accuracy, before and after:

| Provider | Published 2026-08-23 | All rows now | Strict now |
|---|---:|---:|---:|
| gemini-3.7-flash | 67.1% | 69.2% | 74.8% |
| gemini-2.5-flash | 66.7% | 67.6% | 71.5% |
| hf-gpt-oss-20b | 62.6% | 65.2% | 67.7% |
| qwen-sealion | 60.0% | 60.6% | 65.2% |
| claude-sonnet-5 | 54.4% | 57.5% | 60.2% |
| apertus-70b | 54.2% | 54.8% | 54.8% |
| claude-sonnet-4-5 | 48.9% | 50.3% | 52.6% |
| liftwing-qwen3.6-27b | not in this file | 49.7% | 51.9% |

Every provider gained. Three causes, all scoring-side:

1. **The six label corrections and the `row_108` exclusion** account for the
   all-rows column. Correcting labels raised every provider because the
   corrections mostly moved a label *toward* what the better models said, which
   is how they were found — see the audit doc's note that model disagreement was
   a search heuristic for what to read, not evidence in itself.
2. **Two stale labels embedded in `results.json`.** The file carries a
   `ground_truth` copy per row, and for `row_78` and `row_181` that copy had
   drifted from `dataset.json`. The stale value happened to match what
   apertus-70b, qwen-sealion and gemini-2.5-flash predicted on both rows, giving
   each of those three **2 spuriously correct rows** in the published figures
   (apertus 54.2%→52.9%, qwen 60.0%→58.7%, gemini-2.5 66.7%→65.6% before the
   label corrections are applied). The other providers were unaffected. The
   copies were re-synced from the dataset in `3697f99`.
3. **Restricting to whole sources** accounts for the strict column, and is the
   largest single effect: +5.6 points for gemini-3.7-flash, +4.6 for
   qwen-sealion, +0.0 for apertus-70b.

Supported-vs-rest also moved, for a fourth and separate reason: `3697f99` fixed
`equalSupportedVsRest`, which had required `Source unavailable` to match
*exactly* and so scored that verdict wrong on every row — turning the metric
into "did the model avoid saying it" and penalizing exactly the models that
correctly detect an unusable source. Folding it into "rest" moves
liftwing-qwen3.6-27b and claude-sonnet-4-5 by 18-20 points and the providers that
rarely emit the verdict by under a point. Exact accuracy and the confusion
matrices deliberately still treat it as a fourth class.

liftwing-qwen3.6-27b is new to this file; its pre-fix figure was 47.3%.

## Caveats (read before comparing)

**These eight providers did not all run under the same conditions.** Two
distinct eras sit in one results file:

1. **apertus-70b, qwen-sealion, claude-sonnet-4-5, gemini-2.5-flash** — all ran
   2026-04-30/05-02, **before** the 2026-08-04 source-quote-extraction prompt
   change. That's why all four show zeroed-out `quotes` fields in the analysis
   files: the schema for tracking quote offer/fidelity didn't exist yet.
2. **claude-sonnet-5, gemini-3.7-flash, hf-gpt-oss-20b, liftwing-qwen3.6-27b** —
   ran 2026-08-17, 2026-08-20, 2026-08-23 and 2026-09-06 respectively, **after**
   that prompt change, which is why only these four carry quote data.

**The headline "gemini-3.7-flash wins" comparison spans both eras** — it beats
gemini-2.5-flash's *older-prompt* score, not a same-prompt rerun. Nobody has
re-run gemini-2.5-flash (or apertus-70b, qwen-sealion, claude-sonnet-4-5)
against the current prompt, so it's unknown whether its numbers would rise,
fall, or hold. Until that re-run happens, "gemini-3.7-flash is a strict upgrade
over gemini-2.5-flash" is not a claim this data supports — only
"gemini-3.7-flash scored highest of everything run so far" is.

Worse for the older four: **they ran on 2026-04-30/05-02, but `dataset.json` was
extracted on 2026-05-15.** They were shown a `source_text` fetched at run time,
and are scored against a source re-fetched two weeks later. Where they disagree
with the four August/September providers, the newer ones are the ones describing
the current data.

Other reasons to be careful with this table:

3. **Row coverage differs and neither era covers today's dataset.** The dataset
   holds 189 rows; 187 have any results at all (`row_77` and `row_111` have
   never been run), and `row_108` is excluded, leaving 186 scoreable entries. The
   older era covers 185 of them and the newer era 181 — and the two sets are not
   nested: `row_98` is in the newer era only, while `row_35`, `row_124`,
   `row_145`, `row_176` and `row_188` are in the older era only.
   `docs/hf-keyless-and-sonnet-5-benchmark.md`'s caveats explain the `entry_id`
   drift risk this creates.
4. **The strict set contains no scoreable `Source unavailable` row.** Its one
   such row (`row_111`) has never been run, so every `Source unavailable`
   prediction is counted wrong under Exact by construction. This penalizes
   claude-sonnet-5 (15 such predictions on the strict set) and
   liftwing-qwen3.6-27b (20) heavily and gemini-2.5-flash or apertus-70b (2 each)
   barely — which is most of why those two providers rank so differently under
   Exact and under supported-vs-rest.
5. **Single run, no repeated trials**, the same caveat as every other benchmark
   round in this repo — no variance has been measured across repeated passes for
   any of these eight providers. Differences of a point or two between adjacent
   providers should not be read as real.
6. **gemini-3.7-flash's latency figures include a severe outlier** (66.7s on its
   slowest row, against a 13.1s mean) — treat 13.1s as "this provider can take a
   very long time occasionally", not "this provider typically takes 13 seconds".
7. **Confidence scores are not comparable across providers.** apertus-70b and
   qwen-sealion average near 80 whether right or wrong; claude-sonnet-5 and
   liftwing-qwen3.6-27b separate correct from wrong by 30-40 points. The absolute
   number means different things per model; only the gap is informative.

Given (1) and (2) especially: the fair headline from this data is **"Gemini
(both generations) is the strongest performer on exact accuracy of anything
benchmarked against this dataset so far,"** with gemini-3.7-flash ahead on
accuracy and behind on latency and reliability. A same-prompt, same-dataset
rerun of the four older-era providers is the natural next step.
