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

The CORS proxy caps extracted source text at **12,000 characters**. **48 rows** hit a
cap, so what is stored is a *prefix* of the document — while the label was made by a
human reading the whole page. A further **12 rows** store something that is not the
cited source at all: a dead fetch, a bot-block page, an archive banner with no article
behind it. That leaves **129 rows** where the model and the labeller saw the same thing.

| Source | Result rows | Accuracy |
|---|---|---|
| Stored whole | 978 | **64.0%** |
| Truncated at a cap | 365 | **51.0%** |
| | | **13.0-point gap** |

**The rows are flagged, not deleted.** The userscript hits the same cap, so truncated
rows reproduce a real production failure — dropping them would raise the headline while
the tool got no better. They carry `source_truncated`; the unscoreable 12 carry
`excluded_reason`, from a new `Exclude reason` column in the CSV (a column rather than
deleted lines, because row ids are `row_<csv_line>`).

```bash
npm run analyze                    # all rows, prints the whole/truncated split
npm run analyze:full-sources       # the strict 129-row set
npm run analyze:truncated-sources  # the 48 rows the cap cut short
```

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

---

## Effect on the numbers

Both columns are the **share of a provider's non-error calls where its verdict counts
as right** — they differ only in what "right" means:

- **Exact** — the verdict matches the label across all four classes: `Supported`,
  `Partially supported`, `Not supported`, `Source unavailable`. Nothing is forgiven, so
  calling a partially-supported claim unsupported is as wrong as calling it supported.
- **Supported-vs-rest** — `Supported` must still match exactly, but the three ways a
  citation can fail (`Partially supported`, `Not supported`, `Source unavailable`) count
  as mutually equivalent. It answers the question an editor actually has: *does this
  citation carry the claim, yes or no?* — without grading how it fails.

Denominator in both cases is calls that returned a parseable verdict; API errors and
unparseable responses are dropped, not counted wrong. "All rows" is the 177 scoreable
rows; "strict" is the 129 with a whole source. Unscoreable rows are excluded from every
column.

Ordered by exact accuracy on the strict set:

| Provider | Exact (all rows) | Exact (strict) | Supported-vs-rest (strict) |
|---|---|---|---|
| gemini-3.7-flash | 70.8% | **77.2%** | **86.2%** |
| gemini-2.5-flash | 68.8% | 73.4% | 80.5% |
| hf-gpt-oss-20b | 66.7% | 69.8% | 82.2% |
| qwen-sealion | 62.3% | 67.9% | 70.8% |
| claude-sonnet-5 | 58.8% | 62.0% | 84.5% |
| claude-sonnet-4-5 | 51.1% | 53.9% | 78.1% |
| apertus-70b | 54.1% | 53.8% | 61.3% |
| liftwing-qwen3.6-27b | 50.8% | 53.5% | 80.6% |

The two metrics rank providers differently — `liftwing-qwen3.6-27b` goes from last to
fourth, `claude-sonnet-5` from fifth to second — because exact accuracy counts every
`Source unavailable` call as wrong. See the audit doc for that breakdown.

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
