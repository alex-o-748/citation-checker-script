# Benchmark revision — 2026-09-07

Two changes to the citation benchmark, from a review of all 189 rows against the
eight-provider results: a **strict scoring set** that leaves out rows whose stored
source is incomplete, and **six ground-truth corrections**.

Model predictions are unchanged. Only the scoring set and six right-answer labels moved.

---

## 1. The strict set — 140 of 189 rows

The CORS proxy caps extracted source text at **12,000 characters**. **48 rows** hit a
cap, so what is stored is a *prefix* of the document — while the label was made by a
human reading the whole page. **One further row** (`row_108`) is excluded outright: its
claim and its cited URL are unrelated, so no verifier can do better or worse on it.
That leaves **140 rows** where the model and the labeller saw the same thing.

Rows whose source merely failed to fetch stay in. A human editor can still open those
URLs, so a failed fetch is a failure of ours worth measuring, not a row to hide — the
same reason the truncated rows stay.

| Source | Result rows | Accuracy |
|---|---|---|
| Stored whole | 1,030 | **62.3%** |
| Truncated at a cap | 365 | **51.0%** |
| | | **11.4-point gap** |

**The rows are flagged, not deleted.** The userscript hits the same cap, so truncated
rows reproduce a real production failure — dropping them would raise the headline while
the tool got no better. They carry `source_truncated`; the excluded row carries
`excluded_reason`, from a new `Exclude reason` column in the CSV (a column rather than
deleted lines, because row ids are `row_<csv_line>`).

```bash
npm run analyze                    # all rows, prints the whole/truncated split
npm run analyze:full-sources       # the strict 140-row set
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
unparseable responses are dropped, not counted wrong. "All rows" is the 188 scoreable
rows; "strict" is the 140 with a whole source. Unscoreable rows are excluded from every
column.

Ordered by exact accuracy on the strict set:

| Provider | Exact (all rows) | Exact (strict) | Supported-vs-rest (strict) |
|---|---|---|---|
| gemini-3.7-flash | 69.2% | **74.8%** | **85.0%** |
| gemini-2.5-flash | 67.6% | 71.5% | 79.6% |
| hf-gpt-oss-20b | 65.2% | 67.7% | 81.2% |
| qwen-sealion | 60.6% | 65.2% | 69.6% |
| claude-sonnet-5 | 57.5% | 60.2% | 83.5% |
| apertus-70b | 54.8% | 54.8% | 62.6% |
| claude-sonnet-4-5 | 50.3% | 52.6% | 76.6% |
| liftwing-qwen3.6-27b | 49.7% | 51.9% | 79.7% |

The two metrics rank providers differently — `liftwing-qwen3.6-27b` goes from last to
fourth, `claude-sonnet-5` from fifth to second — because exact accuracy counts every
`Source unavailable` call as wrong. See the audit doc for that breakdown.

---

## Open question this raises

The `Partially supported` class is the weakest everywhere — **45.9%** even on whole
sources, against 72.8% for `Supported` and 64.8% for `Not supported`. Part of that is a genuine rubric ambiguity: when a source contradicts one
specific figure or date but supports everything else, `core/prompts.js` instructs the
model toward NOT SUPPORTED (its own few-shot: claim says 45 nations, source says "over
30" → NOT SUPPORTED), while the v2/v3 labelling convention maps the same shape to
*Partially supported*. `row_102` and `row_186` are the same shape with opposite
labels. Worth settling as a rubric decision rather than row by row.

Full review, including the rows examined and left alone:
[`benchmark-ground-truth-audit-2026-09-06.md`](benchmark-ground-truth-audit-2026-09-06.md).
