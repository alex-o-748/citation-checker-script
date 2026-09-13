# ROC curves for benchmark providers

`npm run roc` (from `benchmark/`) computes an ROC curve and AUC per provider from
`results.json`, plus the single operating point each provider actually sits at
today. `npm run roc:strict` does the same over the strict scoring set — the rows
whose stored source is the whole document, which is the set worth quoting. It exists to answer a question the accuracy metrics in `analysis.json`
don't: not just "how often is this provider right," but "if we're willing to
trade false positives for false negatives, how much better could it get" —
and whether the model's own confidence score is worth thresholding on at all.

## The positive class is the failing citation

**Positive = ground truth is anything but `Supported`** — `Partially supported`,
`Not supported`, or `Source unavailable`. That is the case requiring treatment:
the citation an editor has to do something about. The tool exists to find those,
so that is what these curves score it on detecting.

| | Means | Better |
|---|---|---|
| **TPR** | of citations that genuinely fail, the share the tool flags | higher |
| **FPR** | of citations that are genuinely fine, the share the tool flags anyway | lower |

This is stated here, at the top of `benchmark/roc.js`, in CLAUDE.md, and in the
`positive_class` field of every `roc*.json` — because it has been read backwards
twice. Both times the error was the same: reading `Supported` as the positive
class, which silently inverts every number on the page.

The payoff of getting it right is that **FPR here means what "false positive"
already means everywhere else in this repo** — the tool flagging a citation that
was fine. It is the same direction as the "falsely report that a citation fails"
measure in
[`benchmark-ground-truth-audit-2026-09-06.md`](benchmark-ground-truth-audit-2026-09-06.md)
and the "False Positives (overcautious)" counts in
[`llm-benchmarking-overview.md`](llm-benchmarking-overview.md). One vocabulary,
one direction, across the repo.

Two notes for anyone comparing against older figures:

- **AUC is unaffected.** Flipping both the positive class and the score
  direction leaves the ranking statistic identical — the AUCs below are the same
  numbers the previous framing produced. Only the axes and the operating point
  read differently, and those are what people actually interpret.
- **Operating points are exact complements of the old ones.** A provider
  previously reported at FPR 0.053 / TPR 0.632 now reads TPR 0.947 / FPR 0.368.
  If you are holding an old screenshot, subtract from 1 and swap.

## Why a verdict + confidence needs a score in the first place

A benchmark row isn't a single probability. It's a categorical
`predicted_verdict` (SUPPORTED / PARTIALLY SUPPORTED / NOT SUPPORTED / SOURCE
UNAVAILABLE) plus a `support_score` (0-100) that's scoped to whichever verdict
the model chose — a NOT SUPPORTED row can carry support_score 95, and that's
confidence in "not supported," not in "supported." An ROC curve needs one
directional score per row, so `failureScore` (`benchmark/roc.js`) folds
verdict polarity and that score into a single 0-100 "how strongly does this
read as a citation that FAILS" scale:

| Verdict | Score |
|---|---|
| NOT SUPPORTED / SOURCE UNAVAILABLE | `50 + support_score / 2` (pushes above the midpoint) |
| SUPPORTED | `50 - support_score / 2` (pushes below the midpoint) |
| PARTIALLY SUPPORTED | `50` (the score there doesn't carry a fails/holds direction to lean on) |

At threshold 50 the sweep flags exactly what the bare verdict flags, since every
non-SUPPORTED prediction sits at or above the midpoint. That is why the raw
operating point lands *on* its own curve rather than beside it, and
`tests/roc.test.js` pins it.

The field was spelled `confidence` before commit e0706fb. Read it through
`rowSupportScore` (`benchmark/io.js`), which accepts either spelling — never
`row.support_score` or `row.confidence` directly. Reaching for one name
directly is not a cosmetic slip: because a missing field reads as `0`, and `0`
collapses all three rows of the table above onto the 50 midpoint, `roc.js`
reading the stale name produced a single threshold and an AUC of exactly
0.500 for every current-schema run — chance, with no error raised.
`tests/io.test.js` now fails on any such direct read.


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

=== ROC AUC — detecting the failing citation ===
positive = needs treatment (anything but SUPPORTED)
TPR = failing citations caught · FPR = good citations flagged anyway

gemini-3.7-flash: AUC 0.873  (72 failing / 55 fine)  |  raw verdict: FPR 0.309, TPR 0.972
apertus-70b: AUC 0.629  (58 failing / 57 fine)  |  raw verdict: FPR 0.386, TPR 0.638
```

Pass `--results <path>` / `--dataset <path>` / `--output <path>` to point at
alternate files (same convention as `analyze_results.js` and
`run_benchmark.js`).

The output file is `{ metadata, curves }`, where `curves` is keyed by provider.
The metadata block carries `positive_class`, `tpr_means` and `fpr_means` so the
definition travels with the data, and records which row set was scored — `roc.json` and
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

| Provider | AUC (all) | AUC (strict) | Caught, strict (TPR) | False alarms, strict (FPR) | AUC (truncated) |
|---|---|---|---|---|---|
| gemini-3.7-flash | 0.866 | **0.873** | 0.972 | 0.309 | 0.868 |
| gemini-2.5-flash | 0.817 | 0.842 | 0.886 | 0.328 | 0.755 |
| claude-sonnet-4-5 | 0.789 | 0.804 | 0.722 | 0.172 | 0.736 |
| claude-sonnet-5 | 0.808 | 0.802 | 0.934 | 0.298 | 0.832 |
| qwen-sealion | 0.755 | 0.797 | 0.483 | **0.088** | 0.643 |
| liftwing-qwen3.6-27b | 0.789 | 0.791 | 0.816 | 0.228 | 0.783 |
| hf-gpt-oss-20b | 0.777 | 0.767 | 0.947 | 0.368 | 0.825 |
| apertus-70b | 0.638 | 0.629 | 0.638 | 0.386 | 0.637 |

Read a row as: *of citations that genuinely fail, this share gets flagged; of
citations that are genuinely fine, this share gets flagged anyway.*
`gemini-3.7-flash` catches 97% of real problems and false-alarms on 31% of good
citations; `qwen-sealion` false-alarms on only 9% but catches under half the
problems. Neither is strictly better — they sit at different points on curves of
similar quality, which is what AUC exists to compare.

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

- **X-axis (false positive rate)** — of citations that are genuinely fine, how
  many did the tool flag anyway. Wasted editor time.
- **Y-axis (true positive rate)** — of citations that genuinely fail, how many
  did the tool catch. Recall on the problems it exists to find.
- **The diagonal** is a model with zero discriminating power (a coin flip).
  Anything above it beats chance.
- **AUC** collapses the curve into one number: the probability that, given one
  random failing citation and one random fine one, the model's `failureScore`
  ranks the failing one higher. 1.0 = perfect, 0.5 = random.
- Each point on the curve is a `failureScore` threshold — `points[].threshold`
  in `roc.json`. Sweeping that threshold from 100 down to 0 traces the curve
  from `(0,0)` (flag nothing) to `(1,1)` (flag everything); moving from
  bottom-left to top-right means accepting weaker and weaker evidence as
  grounds to flag a citation.

## The raw-verdict operating point

`computeVerdictOperatingPoint` (also in `roc.js`) gives the single `(fpr,
tpr)` point a provider actually operates at *today*: it flags whenever the raw
`predicted_verdict` is anything but SUPPORTED, no confidence threshold applied
at all. That's what an editor using the sidebar as-is actually gets.

**It is not "free TPR the curve reveals is available at the same FPR."** The
raw verdict is exactly "`failureScore >= 50`", since every non-SUPPORTED
prediction sits at or above the midpoint — so the operating point *is* one of
the points the sweep already traces, not a point below the curve. That is now a
property rather than an observation: `tests/roc.test.js` asserts the swept
threshold-50 point equals the operating point, and it holds exactly for all 8
providers. There is no accuracy being left on the table by using the bare
verdict instead of a confidence gate at a fixed FPR.

What the diamond *does* tell you: **where along its own curve the provider's
default behavior currently sits**, which is exactly the information you need
to decide whether sliding the threshold would trade toward a more useful
FPR/TPR balance elsewhere on the same curve. On the strict set:

- **gemini-3.7-flash** flags aggressively (TPR 0.972, FPR 0.309) — it catches
  almost every failing citation, at the cost of flagging nearly a third of the
  good ones. Tightening to threshold 55 would pull it to TPR 0.528 / FPR 0.055:
  a sixth of the false alarms, but it would miss nearly half the problems.
- **qwen-sealion** is the opposite temperament (TPR 0.483, FPR 0.088) — it
  rarely bothers an editor without cause, and misses over half the problems.
  Loosening to threshold 7.5 would take it to TPR 0.793 / FPR 0.246.

Those two sit on curves of similar quality (AUC 0.873 vs 0.797); the difference
an editor feels is *where on the curve* each one sits, which is a choice, not a
capability.

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

- `benchmark/roc.js` — pure computation (`failureScore`, `needsTreatment`,
  `computeRocCurve`, `computeVerdictOperatingPoint`,
  `computeRocCurvesByProvider`). No I/O; reuses `core/verdicts.js`'s canonical
  verdict parsing rather than reimplementing it. Its header also records a
  measured caveat about `failureScore` worth reading before trusting an AUC to
  three decimals.
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
