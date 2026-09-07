# Benchmark revision — 2026-09-07

Two changes to the citation benchmark, from a review of all 189 rows against the
eight-provider results: a **strict scoring set** that leaves out rows whose stored
source is incomplete, and **six ground-truth corrections**.

Model predictions are unchanged. Only the scoring set and six right-answer labels moved.

**The short version:** the corpus is **68.3% support-testable and 31.7% everything
else** — but by *error* the ratio is 91% / 9%. Both numbers, and why they differ, are
under [Support vs everything else](#support-vs-everything-else--683--317).

---

## 1. The strict set — 129 of 189 rows

The CORS proxy caps extracted source text at **12,000 characters** (the direct-fetch
fallback at 50,000). **48 rows** hit a cap, so what is stored is a *prefix* of the
document — while the label was made by a human reading the whole page. A further
**12 rows** store something that is not the cited source at all: a dead fetch, a
bot-block page, an Internet Archive banner with no article behind it, or — in one
case — a page on an entirely unrelated subject.

Scoring those rows measures whether the tool could *see* the evidence, not whether
the model judged it correctly. Pooled across all eight providers:

| Source | Result rows | Accuracy |
|---|---|---|
| Stored whole | 978 | **64.0%** |
| Truncated at a cap | 365 | **51.0%** |
| | | **13.0-point gap** |

The unrelated-subject case is `row_108`: a claim about *The Phoenix* magazine's
Goldhawk phone line, cited to a Central Bank of Ireland explainer on financial
regulation. Its label (*Not supported*) is arguably right by accident, but the row
tests nothing — no verifier could do better or worse on it. The claim and the URL
are simply not a pair.

The gap holds within every label class, and the label mix is near-identical across
the two groups, so it is not a composition artifact.

**The rows are flagged, not deleted.** The userscript hits the same 12,000-character
cap, so truncated rows reproduce a real production failure — deleting them would
raise the headline while the tool got no better, and would remove the only evidence
that the failure exists. Two fields carry this:

- `source_truncated` — recorded at fetch time by `extract_dataset.js`
- `excluded_reason` — set from the `Exclude reason` column in `Benchmarking_data_Citations.csv`

```bash
npm run analyze                    # all rows, prints the whole/truncated split
npm run analyze:full-sources       # the strict 129-row set
npm run analyze:truncated-sources  # the 48 rows the cap cut short
```

Excluding by a CSV column rather than by deleting rows is deliberate: row ids are
`row_<csv_line>`, so deleting lines shifts every id after them and silently
misaligns the seven files that store `entry_id`. A test pins each id to its CSV line.

---

## 2. Six ground-truth corrections

Each was found by reading the stored claim and source directly; model disagreement
only decided reading order.

| Row | Article | Was | Now | Evidence |
|---|---|---|---|---|
| `row_18` | Immigration to the United States | Partially supported | **Supported** | The source states it almost verbatim: *"Historians estimate that well under a million immigrants—perhaps as few as 400,000—crossed the Atlantic during those two centuries."* |
| `row_24` | Fall of Aden (2026) | Supported | **Partially supported** | The claim adds the STC's "reported dissolution" and the "collapse" of its forces. Neither word appears in the source, which is same-day reporting in which *"Some officials from the STC, however, said the group is still in control of Aden."* |
| `row_71` | Liberation Tigers of Tamil Eelam | Partially supported | **Not supported** | Claim: the ENLF formed in **April 1984**, a union of five groups **including PLOTE**. Source: *"In March 1985, the LTTE, EPRLF, TELO, and EROS formed a united front organization, the Eelam National Liberation Front (ENLF). PLOTE … remained outside the coalition."* Wrong on both date and membership. |
| `row_81` | Gary Graffman | Not supported | **Partially supported** | Too harsh. The source carries the claim's core: *"Wittgenstein commissioned the concerto in 1923 … at its UK premiere in 1985 was called a keyboard Salome by the soloist Gary Graffman."* Only "played it many times" and "slipped from the repertoire" are absent. |
| `row_102` | Ohio University | Partially supported | **Not supported** | Claim: *"R1: Doctoral Universities – Very high research activity."* Source: *"Doctoral Universities: High Research Activity"* — one tier down. "Very high" does not appear. |
| `row_159` | UC Colorado Springs | Partially supported | **Not supported** | Neither "Military Friendly" nor "veteran" appears anywhere in the stored source. |

Three of the six (`row_24`, `row_71`, `row_102`) sit inside the strict set and move
its numbers. The other three are truncated rows, so they affect only the all-rows
figure.

**One caveat on `row_159`:** its source is truncated, so the correction rests on the
*absence* of a phrase in a partial document — the one inference the strict set exists
to distrust. It is outside the strict set for exactly that reason. If the row is ever
re-fetched whole, re-check it first.

---

## Effect on the numbers

Exact accuracy, unscoreable rows excluded throughout:

| Provider | All rows | Strict set (129) |
|---|---|---|
| gemini-3.7-flash | 70.8% | **77.2%** |
| gemini-2.5-flash | 68.8% | 73.4% |
| hf-gpt-oss-20b | 66.7% | 69.8% |
| qwen-sealion | 62.3% | 67.9% |
| claude-sonnet-5 | 58.8% | 62.0% |
| apertus-70b | 54.1% | 53.8% |
| claude-sonnet-4-5 | 51.1% | 53.9% |
| liftwing-qwen3.6-27b | 50.8% | 53.5% |

Ordering is essentially unchanged — the corrections are spread thinly enough not to
favour one model. What moves is the level.

Strict-set label mix: 56 Supported / 37 Partially supported / 36 Not supported.

---

## Support vs everything else — 68.3% / 31.7%

How much of this benchmark actually measures the model's judgement, and how much
measures whether we could fetch and read the page? Two ways to count it, and they
disagree usefully.

**By row — what the corpus is made of:**

| | Rows | Share |
|---|---|---|
| Support-testable (whole source) | 129 | 68.3% |
| Truncation-degraded | 48 | 25.4% |
| Unscoreable (dead fetch, wrong page) | 12 | 6.3% |
| **Everything but support** | **60** | **31.7%** |

**By error — where the wrongness comes from.** Of 531 wrong verdicts across 1,343
scoreable calls, roughly **483 (91%)** are judgment errors that whole sources would
not fix. Truncation accounts for about **48 (9%)** — worth **3.5 accuracy points**
pooled.

So a third of the corpus is compromised but only a tenth of the error is. Truncation
is a real cost, not the dominant one.

### About half the truncation penalty isn't the model being wrong

**No scoreable row in the dataset is labelled `Source unavailable`.** The only one
(`row_111`) is excluded. But the verdict is emitted on **105 calls (7.8%)**, and under
4-class exact accuracy every one of them is scored wrong — the answer is unwinnable by
construction.

That lands disproportionately on truncated rows, where models detect an unusable
source twice as often:

| | Whole sources | Truncated |
|---|---|---|
| Predicts `Source unavailable` | 6.1% (60 calls) | **12.3% (45 calls)** |
| …as a share of that group's errors | 17.0% | **25.1%** |

Decomposing the 48-error truncation cost: **23 (47%) is excess `Source unavailable`**
that could never have scored right, and **25 is genuine misjudgement**. So the
fetch-fixable part is closer to **1.8 accuracy points**, not 3.5.

The same effect shows up in the metric that *does* credit the verdict.
`equalSupportedVsRest` was fixed on `main` (commit `3697f99`) to fold
`SOURCE UNAVAILABLE` into "rest" — it previously required an exact match, so the
metric had quietly become "did the model avoid saying it". Under the corrected
version the truncation gap **halves**:

| Metric | Whole | Truncated | Gap |
|---|---|---|---|
| Exact accuracy (4-class) | 64.0% | 51.0% | 13.0 pts |
| Supported-vs-rest (fixed) | 78.5% | 72.1% | **6.5 pts** |

Both numbers are honest; they answer different questions. But quoting the 13-point gap
as "what truncation costs" overstates it, because roughly half of it is the model
correctly reporting that it cannot read the source and the benchmark having no way to
say "correct".

**The part that argues for splitting the benchmark:** that share is not constant
across models.

| Provider | Whole-source accuracy | Truncation's share of its errors | Points on the table |
|---|---|---|---|
| gemini-3.7-flash | 77.2% | 22.0% | 6.4 |
| gemini-2.5-flash | 73.4% | 15.0% | 4.7 |
| hf-gpt-oss-20b | 69.8% | 9.3% | 3.1 |
| qwen-sealion | 67.9% | 14.9% | 5.6 |
| claude-sonnet-5 | 62.0% | 7.9% | 3.3 |
| claude-sonnet-4-5 | 53.9% | 5.7% | 2.8 |
| apertus-70b | 53.8% | −0.7% | −0.3 |
| liftwing-qwen3.6-27b | 53.5% | 5.4% | 2.6 |

The pattern is rough rather than a clean law — `qwen-sealion` is out of line — but it
is directional: **the better the model, the more of its remaining error is
infrastructure rather than judgment.** `gemini-3.7-flash` leaves 6.4 points on the
table; `apertus-70b` leaves nothing measurable (its −0.7% is noise — it does
fractionally *better* on truncated rows, which is what guessing looks like).

Which means conflating the two halves gets *worse* over time, not better. As models
improve, the fetch-and-extract half grows as a share of the headline number, and
comparisons across runs increasingly measure the web rather than the verifier.

---

## What did not change

- **No model predictions.** `results.json` keeps every verdict; only `ground_truth`
  and the derived `correct` flag moved on the six rows.
- **The frozen `v1` / `v3` snapshots**, which exist to reproduce published analyses.
- **`row_161`** (North Carolina Republican Party) — examined and left at *Partially
  supported*. The source does not mention North Carolina, but it does support two of
  the claim's propositions (Carter as a Georgia Democrat elected in 1976; Johnson
  signing the Civil Rights Act), which is what "partially" means under our rubric.
  Its real defect is claim scope: it is a two-sentence span whose halves are likely
  carried by different citations.
- **`row_186`** (Combat Zone Wrestling) — the source says CZW was founded in 1998,
  the claim says 1999. Left at *Partially supported*, because that is the documented
  v3 convention: where a central named fact is in the source and the gap is a detail,
  the 2026-04-30 strict-rubric audit mapped WMF's "No" to *Partially supported*.

One repair worth noting: `results.json` was carrying a superseded label for `row_181`
(the pre-audit WMF verdict, never propagated after the 2026-04-30 relabel). It now
matches the dataset. `row_78` still disagrees deliberately — its results belong to a
row that no longer exists, which is why it is excluded.

---

## Open question this raises

The `Partially supported` class is the weakest everywhere (46.3% even on whole
sources). Part of that is a genuine rubric ambiguity: when a source contradicts one
specific figure or date but supports everything else, `core/prompts.js` instructs the
model toward NOT SUPPORTED (its own few-shot: claim says 45 nations, source says "over
30" → NOT SUPPORTED), while the v2/v3 labelling convention maps the same shape to
*Partially supported*. `row_102` and `row_186` are the same shape with opposite
labels. Worth settling as a rubric decision rather than row by row.

Full review, including the rows examined and left alone:
[`benchmark-ground-truth-audit-2026-09-06.md`](benchmark-ground-truth-audit-2026-09-06.md).
