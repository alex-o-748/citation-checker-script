# Benchmark revision — 2026-09-07

Two changes to the citation benchmark, from a review of all 189 rows against the
eight-provider results: a **strict scoring set** that leaves out rows whose stored
source is incomplete, and **six ground-truth corrections**.

Model predictions are unchanged. Only the scoring set and six right-answer labels moved.

---

## 1. The strict set — 130 of 189 rows

The CORS proxy caps extracted source text at **12,000 characters** (the direct-fetch
fallback at 50,000). **48 rows** hit a cap, so what is stored is a *prefix* of the
document — while the label was made by a human reading the whole page. A further
**11 rows** store something that is not the cited source at all: a dead fetch, a
bot-block page, an Internet Archive banner with no article behind it.

Scoring those rows measures whether the tool could *see* the evidence, not whether
the model judged it correctly. Pooled across all eight providers:

| Source | Result rows | Accuracy |
|---|---|---|
| Stored whole | 984 | **63.9%** |
| Truncated at a cap | 365 | **51.0%** |
| | | **12.9-point gap** |

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
npm run analyze:full-sources       # the strict 130-row set
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

| Provider | All rows | Strict set (130) |
|---|---|---|
| gemini-3.7-flash | 71.0% | **77.4%** |
| gemini-2.5-flash | 68.9% | 73.6% |
| hf-gpt-oss-20b | 66.9% | 70.0% |
| qwen-sealion | 62.3% | 67.9% |
| claude-sonnet-5 | 58.4% | 61.5% |
| apertus-70b | 54.1% | 53.8% |
| claude-sonnet-4-5 | 50.8% | 53.5% |
| liftwing-qwen3.6-27b | 50.6% | 53.1% |

Ordering is essentially unchanged — the corrections are spread thinly enough not to
favour one model. What moves is the level.

Strict-set label mix: 56 Supported / 37 Partially supported / 37 Not supported.

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
