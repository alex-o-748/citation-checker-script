# ROC curves for benchmark providers

`npm run roc` (from `benchmark/`) computes an ROC curve and AUC per provider from
`results.json`, plus the single operating point each provider actually sits at
today. `npm run roc:strict` does the same over the strict scoring set — the rows
whose stored source is the whole document, which is the set worth quoting. It exists to answer a question the accuracy metrics in `analysis.json`
don't: not just "how often is this provider right," but "if we're willing to
trade false positives for false negatives, how much better could it get" —
and whether the model's own confidence score is worth thresholding on at all.

## Why a verdict + confidence needs a score in the first place

A benchmark row isn't a single probability. It's a categorical
`predicted_verdict` (SUPPORTED / PARTIALLY SUPPORTED / NOT SUPPORTED / SOURCE
UNAVAILABLE) plus a `support_score` (0-100) that's scoped to whichever verdict
the model chose — a NOT SUPPORTED row can carry support_score 95, and that's
confidence in "not supported," not in "supported." An ROC curve needs one
directional score per row, so `supportedScore` (`benchmark/roc.js`) folds
verdict polarity and that score into a single 0-100 "how strongly does this
read as SUPPORTED" scale:

| Verdict | Score |
|---|---|
| SUPPORTED | `50 + support_score / 2` (pushes above the midpoint) |
| NOT SUPPORTED / SOURCE UNAVAILABLE | `50 - support_score / 2` (pushes below the midpoint) |
| PARTIALLY SUPPORTED | `50` (the score there doesn't carry a supported/not-supported direction to lean on) |

The field was spelled `confidence` before commit e0706fb. Read it through
`rowSupportScore` (`benchmark/io.js`), which accepts either spelling — never
`row.support_score` or `row.confidence` directly. Reaching for one name
directly is not a cosmetic slip: because a missing field reads as `0`, and `0`
collapses all three rows of the table above onto the 50 midpoint, `roc.js`
reading the stale name produced a single threshold and an AUC of exactly
0.500 for every current-schema run — chance, with no error raised.
`tests/io.test.js` now fails on any such direct read.

Positive class is ground truth `SUPPORTED` — "is this citation actually
fine," the operational question the sidebar's verdict exists to answer for an
editor deciding whether to flag it.

## Quick start

```sh
cd benchmark
npm run roc            # every scoreable row      -> roc.json
npm run roc:strict     # whole sources only       -> roc_strict.json
npm run roc:truncated  # capped sources only      -> roc_truncated.json
```

Prints AUC and the raw-verdict operating point per provider to the console,
and writes the curve points to JSON:

```
Loaded 1472 results from results.json
Excluded 8 results on unscoreable rows; --include-excluded to keep them
Filtered to "full" sources: dropped 384 results
Scoring 1080 results (whole sources only — the strict set)

=== ROC AUC (SUPPORTED vs. rest) ===

gemini-3.7-flash: AUC 0.873  (55 positive / 72 negative)  |  raw verdict: FPR 0.028, TPR 0.691
apertus-70b: AUC 0.629  (57 positive / 58 negative)  |  raw verdict: FPR 0.362, TPR 0.614
```

Pass `--results <path>` / `--dataset <path>` / `--output <path>` to point at
alternate files (same convention as `analyze_results.js` and
`run_benchmark.js`).

The output file is `{ metadata, curves }`, where `curves` is keyed by provider.
The metadata block records which row set was scored — `roc.json` and
`roc_strict.json` are the same shape over different rows, and a file that
didn't say which one it covered would invite reading a strict AUC as an
all-rows one.

## Which rows the curve covers

The row-set flags mean exactly what they mean in `analyze_results.js`, and
they reuse its helpers (`excludedRowIds`, `partitionByTruncation`) rather than
re-deriving the rules — a curve drawn over a different set of rows than the
accuracy table beside it is a mismatch nobody notices until the two disagree.

| Flag | Rows |
|---|---|
| *(default)* | Every scoreable row. Rows the dataset marks `excluded_reason` are dropped, and the count is printed |
| `--truncation full` | The **strict set**: only rows whose stored source is the whole document |
| `--truncation truncated` | Only the rows whose source stopped at a fetch cap |
| `--include-excluded` | Keeps the unscoreable rows in |

The strict set is the one to quote. A row whose `source_text` stops at the
proxy's 12,000-character cap was labelled by a human who read the whole page,
so a wrong verdict there may be the tool failing to *see* the evidence rather
than the model failing to judge it — which is a fetch problem, not a
discrimination problem, and ROC is measuring discrimination. See
[`benchmark-revision-2026-09-07.md`](benchmark-revision-2026-09-07.md).

`--truncation` **refuses** to run against a dataset carrying no
`source_truncated` flag anywhere (the frozen v1/v3 snapshots) rather than
reading absent as `false`, which would report every row as whole and draw a
confidently wrong "strict" curve.

## The current numbers (2026-09-12, 8 providers)

Both columns are the same 1,472-row run; they differ only in which rows are
scored. Ordered by strict AUC.

| Provider | AUC (all rows) | AUC (strict) | Raw verdict, strict | AUC (truncated) |
|---|---|---|---|---|
| gemini-3.7-flash | 0.866 | **0.873** | FPR 0.028 / TPR 0.691 | 0.868 |
| gemini-2.5-flash | 0.817 | 0.842 | FPR 0.114 / TPR 0.672 | 0.755 |
| claude-sonnet-4-5 | 0.789 | 0.804 | FPR 0.278 / TPR 0.828 | 0.736 |
| claude-sonnet-5 | 0.808 | 0.802 | FPR 0.066 / TPR 0.702 | 0.832 |
| qwen-sealion | 0.755 | 0.797 | FPR 0.517 / TPR 0.912 | 0.643 |
| liftwing-qwen3.6-27b | 0.789 | 0.791 | FPR 0.184 / TPR 0.772 | 0.783 |
| hf-gpt-oss-20b | 0.777 | 0.767 | FPR 0.053 / TPR 0.632 | 0.825 |
| apertus-70b | 0.638 | 0.629 | FPR 0.362 / TPR 0.614 | 0.637 |

**The strict set is not simply kinder.** Five providers gain (`qwen-sealion`
+0.042, `gemini-2.5-flash` +0.025), three lose (`hf-gpt-oss-20b` −0.010,
`apertus-70b` −0.009, `claude-sonnet-5` −0.006), and the order changes:
`claude-sonnet-5` drops from third to fourth. The last column says why — the
providers that lose on whole sources are the ones that scored *higher* on the
capped rows, so pooling was flattering them with rows where nobody could have
seen the evidence. Note it is only ~45 rows per provider, so treat the
truncated column as a direction, not a measurement.

This is a different question from the accuracy table in
[`benchmark-revision-2026-09-07.md`](benchmark-revision-2026-09-07.md), which
scores the verdict a provider actually emitted. AUC scores how well its
score *ranks* supported citations above unsupported ones, so the two can and
do disagree: `claude-sonnet-5` is fifth on strict exact accuracy (60.2%) and
fourth on strict AUC.

Row counts per provider differ (115 to 137 scored rows in the strict set):
`apertus-70b` and `qwen-sealion` ran on a subset of the dataset, and error or
unparseable rows never enter a curve. Compare AUCs across providers with that
in mind; the counts are in each curve's `positives` / `negatives`.

## Reading the curve

- **X-axis (false positive rate)** — of citations that are actually NOT
  supported, how many did the model call SUPPORTED anyway.
- **Y-axis (true positive rate)** — of citations that ARE actually supported,
  how many did the model correctly call SUPPORTED.
- **The diagonal** is a model with zero discriminating power (a coin flip).
  Anything above it beats chance.
- **AUC** collapses the curve into one number: the probability that, given
  one random SUPPORTED row and one random NOT-SUPPORTED row, the model's
  `supportedScore` ranks the SUPPORTED one higher. 1.0 = perfect, 0.5 =
  random.
- Each point on the curve is a `supportedScore` threshold — `points[].threshold`
  in `roc.json`. Sweeping that threshold from 100 down to 0 traces the curve
  from `(0,0)` (trust nothing) to `(1,1)` (trust everything); moving along the
  curve from bottom-left to top-right means accepting a lower and lower score
  as still counting as "Supported."

## The raw-verdict operating point

`computeVerdictOperatingPoint` (also in `roc.js`) gives the single `(fpr,
tpr)` point a provider actually operates at *today*: just
`predicted_verdict === SUPPORTED` vs. everything else, no confidence
threshold applied at all. That's what an editor using the sidebar as-is
actually gets.

**It is not "free TPR the curve reveals is available at the same FPR."**
The raw verdict is, in score terms, approximately "`supportedScore >= 50`" —
and that threshold is one of the points the curve's own sweep already passes
through. So the operating point sits *on* its own curve, not below it.
Re-checked across all 8 providers on the strict set: the gap between the
operating point's TPR and the curve's TPR at that same FPR never exceeds
0.02 in either direction (it lands slightly *above* the interpolated curve
for `gemini-2.5-flash` and `claude-sonnet-5`, which is interpolation between
sweep points, not signal). There's no meaningful accuracy being left on the
table by using the bare verdict instead of a confidence gate at a fixed FPR.

What the diamond *does* tell you: **where along its own curve the provider's
default behavior currently sits**, which is exactly the information you need
to decide whether sliding the threshold would trade toward a more useful
FPR/TPR balance elsewhere on the same curve. On the strict set:

- **gemini-3.7-flash** sits at the extreme conservative end of its curve
  (FPR 0.028, TPR 0.691) — loosening the threshold to 50 would move it to
  FPR 0.472 / TPR 0.945, a real option, but at ~17x the false-positive rate.
- **qwen-sealion** sits much further out (FPR 0.517, TPR 0.912) — tightening
  the threshold to 95 would pull it back to FPR 0.207 / TPR 0.754, trading
  away 16 points of recall to cut false positives by 60%.

These numbers move as `results.json` grows — re-run `npm run roc:strict`
rather than trusting this snapshot.

## When to use this

- **Comparing providers on a threshold-independent basis.** Exact/lenient
  accuracy in `analysis.json` is measured at whatever threshold each provider
  happens to use internally; AUC compares discriminating power without
  depending on that.
- **Deciding whether a stricter or looser confidence threshold would rebalance
  a provider more usefully.** Read the diamond's position on its own curve
  (see above) — it shows which direction is available and what it costs, not
  whether thresholding helps at all (it doesn't, at a fixed FPR).
- **Spotting a provider whose confidence is poorly calibrated relative to its
  verdict.** If a future provider's diamond does land meaningfully below its
  own curve at the same FPR (unlike anything in the current 8), that's a
  provider whose verdict category is throwing away signal its own confidence
  score has — worth a confidence-gate experiment specifically for that one.

## Source layout

- `benchmark/roc.js` — pure computation (`supportedScore`,
  `isPositiveGroundTruth`, `computeRocCurve`, `computeVerdictOperatingPoint`,
  `computeRocCurvesByProvider`). No I/O; reuses `core/verdicts.js`'s canonical
  verdict parsing rather than reimplementing it.
- `benchmark/roc_curve.js` — CLI wrapper: loads `results.json`
  (`benchmark/io.js`'s `loadRows`, handling both the legacy bare-array and
  current `{metadata, rows}` shapes), narrows the rows (`selectScoredRows`,
  exported and pure, delegating to `analyze_results.js`'s `excludedRowIds` /
  `partitionByTruncation`), prints the console summary, writes `roc.json`.
- `tests/roc.test.js` — unit coverage for the scoring function, curve
  construction (perfect separation, coin-flip, single-class), the
  raw-verdict operating point, per-provider splitting, and the row-set
  selection (including its refusal to guess on a dataset with no
  `source_truncated` flag).

Like `compare_results.js` / `render_compare.js`, the pure logic in `roc.js`
does no file I/O — it's callable from a script, a test, or a future report
renderer without dragging filesystem assumptions along.
