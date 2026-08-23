# ROC curves for benchmark providers

`npm run roc` (from `benchmark/`) computes an ROC curve and AUC per provider from
`results.json`, plus the single operating point each provider actually sits at
today. It exists to answer a question the accuracy metrics in `analysis.json`
don't: not just "how often is this provider right," but "if we're willing to
trade false positives for false negatives, how much better could it get" —
and whether the model's own confidence score is worth thresholding on at all.

## Why a verdict + confidence needs a score in the first place

A benchmark row isn't a single probability. It's a categorical
`predicted_verdict` (SUPPORTED / PARTIALLY SUPPORTED / NOT SUPPORTED / SOURCE
UNAVAILABLE) plus a `confidence` (0-100) that's scoped to whichever verdict
the model chose — a NOT SUPPORTED row can carry confidence 95, and that's
confidence in "not supported," not in "supported." An ROC curve needs one
directional score per row, so `supportedScore` (`benchmark/roc.js`) folds
verdict polarity and confidence into a single 0-100 "how strongly does this
read as SUPPORTED" scale:

| Verdict | Score |
|---|---|
| SUPPORTED | `50 + confidence / 2` (pushes above the midpoint) |
| NOT SUPPORTED / SOURCE UNAVAILABLE | `50 - confidence / 2` (pushes below the midpoint) |
| PARTIALLY SUPPORTED | `50` (confidence there doesn't carry a supported/not-supported direction to lean on) |

Positive class is ground truth `SUPPORTED` — "is this citation actually
fine," the operational question the sidebar's verdict exists to answer for an
editor deciding whether to flag it.

## Quick start

```sh
cd benchmark
npm run roc
```

Prints AUC and the raw-verdict operating point per provider to the console,
and writes `benchmark/roc.json`:

```
apertus-70b: AUC 0.641  (79 positive / 76 negative)  |  raw verdict: FPR 0.368, TPR 0.633
gemini-3.7-flash: AUC 0.866  (76 positive / 97 negative)  |  raw verdict: FPR 0.031, TPR 0.632
```

Pass `--results <path>` / `--output <path>` to point at an alternate results
file (same convention as `analyze_results.js` and `run_benchmark.js`).

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
through. So the operating point sits *on* its own curve (within ~0.01–0.04 of
TPR, which is noise from where the sweep happens to land a threshold), not
below it. Checked across all 7 providers in the 2026-08-20 run — the gap
between the operating point's TPR and the curve's TPR at that same FPR never
exceeds 0.04. There's no meaningful accuracy being left on the table by using
the bare verdict instead of a confidence gate at a fixed FPR.

What the diamond *does* tell you: **where along its own curve the provider's
default behavior currently sits**, which is exactly the information you need
to decide whether sliding the threshold would trade toward a more useful
FPR/TPR balance elsewhere on the same curve:

- **gemini-3.7-flash** sits at the extreme conservative end of its curve
  (FPR 0.03, TPR 0.63) — loosening the threshold to 50 would move it to FPR
  0.41 / TPR 0.92, a real option, but at ~14x the false-positive rate.
- **qwen-sealion** sits much further out (FPR 0.54, TPR 0.85) — tightening
  the threshold to 95 would pull it back to FPR 0.24 / TPR 0.71, trading
  away 14 points of recall to cut false positives by more than half.

These numbers move as `results.json` grows — re-run `npm run roc` rather
than trusting this snapshot.

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
  own curve at the same FPR (unlike anything in the current 7), that's a
  provider whose verdict category is throwing away signal its own confidence
  score has — worth a confidence-gate experiment specifically for that one.

## Source layout

- `benchmark/roc.js` — pure computation (`supportedScore`,
  `isPositiveGroundTruth`, `computeRocCurve`, `computeVerdictOperatingPoint`,
  `computeRocCurvesByProvider`). No I/O; reuses `core/verdicts.js`'s canonical
  verdict parsing rather than reimplementing it.
- `benchmark/roc_curve.js` — CLI wrapper: loads `results.json`
  (`benchmark/io.js`'s `loadRows`, handling both the legacy bare-array and
  current `{metadata, rows}` shapes), prints the console summary, writes
  `roc.json`.
- `tests/roc.test.js` — unit coverage for the scoring function, curve
  construction (perfect separation, coin-flip, single-class), the
  raw-verdict operating point, and per-provider splitting.

Like `compare_results.js` / `render_compare.js`, the pure logic in `roc.js`
does no file I/O — it's callable from a script, a test, or a future report
renderer without dragging filesystem assumptions along.
