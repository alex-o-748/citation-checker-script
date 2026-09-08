# Benchmark ground-truth audit — 2026-09-06

An audit of `benchmark/dataset.json` (189 rows) against `benchmark/results.json`
(1,472 result rows, 8 providers), looking for rows whose `ground_truth` label is
wrong, unverifiable, or attached to something other than what it appears to
label.

**Headline:** 6 rows have a label I'd call wrong on the evidence in the dataset
itself, and one row is unscoreable because its claim and cited URL are unrelated. Underneath both sits a systemic problem: **48 of 189 rows
(25.4%) store a source silently truncated at the proxy's 12,000-character cap**,
so the labeller and the model were not looking at the same document.

Correcting the six labels and scoring only whole sources moves individual providers
by up to **+5.6 points**. The ranking is stable within a metric, but the absolute
numbers are not — and the ranking is *not* stable across metrics (see below).

> **Update, 2026-09-07.** Truncated rows are now flagged rather than removed. Only
> `row_108` is excluded, via a CSV column — see
> [Status](#status-what-has-been-done) at the end. The labels are untouched and
> await review.
>
> Two corrections to this document's first version:
>
> 1. It counted truncated rows with `source_text.length >= 11900`, which swept in
>    two complete documents (`row_71` at 17,985 chars and `row_139` at 11,990 —
>    both under their cap). The real count is **48, not 50**. `row_71` being a
>    *complete* source strengthens the case in section A, since its label is
>    contradicted by a whole document rather than a fragment.
> 2. It reported the truncation gap without noting that **about 40% of it is
>    unrewardable `Source unavailable`** — effectively no scoreable row carries that
>    label (`row_111` does, but no provider has ever run it), so the verdict is
>    always scored wrong, and models emit it more often on truncated sources.
>    Section D carries the decomposition. The gap on the current data is 11.4 points
>    by exact accuracy and 5.5 by supported-vs-rest.
> 3. It excluded 11 rows whose source failed to fetch. That was wrong and is
>    reverted: a human editor can still open those URLs, so a failed fetch is a
>    failure of ours worth measuring. Only `row_108` stays excluded.
>
> This branch is merged with `main` as of `3697f99`, which fixed three metric bugs
> — including `equalSupportedVsRest` excluding `SOURCE UNAVAILABLE` from "rest".
> Exact accuracy and the confusion matrix are unaffected by that fix, so every
> per-provider figure in this document is unchanged by the merge.

---

## Method, and what it can't tell you

Model disagreement is a *search heuristic* here, not evidence. Every row below
was opened and judged against the stored claim and source text; the model votes
only decided reading order.

Two things constrain the evidence:

1. **The four older providers (`apertus-70b`, `qwen-sealion`, `claude-sonnet-4-5`,
   `gemini-2.5-flash`) ran 2026-04-30/05-02 — before the dataset was extracted on
   2026-05-15.** They saw a different `source_text` than the one they are now
   scored against. Where they disagree with the four August/September providers,
   the newer ones are the ones describing the current data.
2. **A "Partially supported" GT that models call "Not supported" is often a real
   rubric call, not an error.** `core/prompts.js` puts a factual contradiction in
   NOT SUPPORTED even when the rest of the claim checks out — its own few-shot
   example is *claim says 45 nations, source says "over 30"* → NOT SUPPORTED.
   Several rows below are flagged precisely because the label went the other way
   on that exact shape.

---

## A. Labels that look wrong

### High confidence

| Row | Article | GT | Should be | Evidence |
|---|---|---|---|---|
| `row_102` | Ohio University | Partially supported | **Not supported** | Claim: `"R1: Doctoral Universities – Very high research activity"`. Source (Carnegie, 2020 capture) reads `Doctoral Universities: High Research Activity` — one tier down. Direct contradiction; 6/6 models agree. |
| `row_71` | Liberation Tigers of Tamil Eelam | Partially supported | **Not supported** | Claim: ENLF formed **April 1984**, a union of five groups **including PLOTE**. Source: *"In March 1985, the LTTE, EPRLF, TELO, and EROS formed … the ENLF. PLOTE … remained outside the coalition."* Wrong on both date and membership. 4/4 fresh models agree. |
| `row_186` | Combat Zone Wrestling | Partially supported | **Not supported** | Claim: founded **1999**. Source: *"CZW was born … way back in 1998, by John Zandig"*. 4/4 fresh models agree. |
| `row_18` | Immigration to the United States | Partially supported | **Supported** | Source states it almost verbatim: *"Historians estimate that well under a million immigrants—perhaps as few as 400,000—crossed the Atlantic during those two centuries."* All 7 non-erroring models say Supported. |
| `row_81` | Gary Graffman | Not supported | **Partially supported** | The label is far too harsh. Source: *"Wittgenstein commissioned the concerto in 1923 … at its UK premiere in 1985 was called a keyboard Salome by the soloist Gary Graffman."* That is the 1985 UK premiere, the work, the soloist and the 1920s commission. Only *"played it many times"* / *"slipped from the repertoire"* are absent. 4/4 fresh models say Partially or Supported. |
| `row_24` | Fall of Aden (2026) | Supported | **Partially supported** | Claim asserts capture of Aden **plus** the STC's "reported dissolution" and "collapse of the group's forces". The source is same-day reporting in which *"Some officials from the STC … said the group is still in control of Aden"*, and it never mentions dissolution or collapse. 8/8 models say Partially or Not. |

### Worth a second look (lower confidence)

| Row | Article | GT | Reading that argues against it |
|---|---|---|---|
| `row_112` | Aida Turturro | Partially supported | Claim "since 2013"; source says since 2011 — a contradiction, which the rubric puts in Not supported. |
| `row_56` | Dancing House | Supported | Source is the hotel's own page. It confirms a *Ginger & Fred* restaurant on the 7th floor but says nothing about the nickname being "now mainly used" for it — the actual assertion. |
| `row_175` | F5ve | Supported | Neither the 4 November announcement date nor the parenthetical subtitle appears in the source; 3/4 fresh models say Partially. |
| `row_159` | UCCS | Partially supported | "Military Friendly® School" appears nowhere in the source, and neither does veteran support. Nothing is left for "partially" to rest on. |
| `row_161` | North Carolina Republican Party | Partially supported | Source is a Cornell blog on *national* partisan sorting; it never addresses North Carolina's presidential results or the claim's second sentence. |
| `row_114` | The Orphan (1920 film) | Supported | **Genuinely ambiguous, not wrong.** Claim says AFI cites **6** contemporary reviews. AFI lists **7 citation rows** from **6 distinct publications** (MPN appears twice). Both labels are defensible; the row can't discriminate. Consider dropping it. |

---

## B. The stored source is not the cited source

For these the label may well be right about the *real* page — but nothing in the
dataset can confirm it, and the model is being marked wrong for correctly saying so.

**These rows are NOT excluded.** A human editor can still open most of these URLs, so
a failed or blocked fetch is a failure of ours worth measuring rather than a row to
hide. Only `row_108` — where the claim and the cited URL are unrelated — is excluded.
The rest stay in scoring, and the fetchability half of the benchmark is where they
belong once it exists.

| Row | GT | What `source_text` actually contains |
|---|---|---|
| `row_17` | Supported | **339 chars of Wayback Machine chrome.** Capture counts, "COLLECTED BY", a TIMESTAMPS line. None of the 1909 census report. 4/4 fresh models: Source unavailable. |
| `row_22` | Partially supported | 3,012 chars of Wayback navigation plus a 301 redirect notice. No Seattle Times article. 4/4 fresh models: Source unavailable. |
| `row_144` | Partially supported | eBird bot-block: *"Oops! A problem occurred while trying to determine if you are a bot… Access Denied: error code 559e7f01…"* (283 chars). |
| `row_47` | Supported | The URL slug is `saleh-and-houthis-boycott-new-yemen-government`; the stored page is a *different* MEE article, "US blacklists Yemen ex-president Saleh, Houthi commanders". The word **"boycott" appears nowhere in the stored text**. The label describes the intended article. |
| `row_108` | Not supported | A claim about *The Phoenix* magazine's Goldhawk phone line paired with a Central Bank of Ireland explainer on financial regulation. The label happens to be right, but the citation→URL mapping is broken and the row tests nothing. |
| `row_35`, `row_124`, `row_145`, `row_176`, `row_188` | various | `extraction_status: source_fetch_failed`, `source_text: ""`, but a substantive GT. The older providers scored these from a source that has since become unfetchable — `row_124`'s results quote the BRP press release verbatim against an empty stored source. |
| `row_77`, `row_111` | Supported / Source unavailable | Empty source and **zero** results from any provider. |

Three of these (`row_35`, `row_124`, `row_145`) already carry
`needs_manual_review: true`; the rest do not, and probably should.

---

## C. The live page changed after labelling

| Row | GT | Drift |
|---|---|---|
| `row_168` | Partially supported | Census Reporter now serves **ACS 2024** data: population **195,481**. The claim (and the April model runs, which quote "186,842") reflect the older vintage. What was a matching figure is now a contradiction. Separately: the claim is about **California's 55th State Assembly district** but the source profiles **Chino Valley Unified School District** — an entity mismatch in the Wikipedia citation itself. |
| `row_95` | Partially supported | Claim cites 2022 (24,398 TWh) and 1981 (8,132 TWh). The stored IEA page now carries only 2019/2018 figures. Neither number in the claim is checkable against it. |

These are the visible cases. Any row citing a live, non-archived URL carries the
same risk; the dataset stores no fetch date per row to detect it.

---

## D. Silent truncation at 12,000 characters — the systemic one

**48 of 189 rows (25.4%) store a source that stops at a cap rather than at the
end of the document** — 46 at the proxy's 12,000-character cap (a couple of
characters over, since it cuts on a boundary) and 2 at the direct-fetch
fallback's 50,000. Lengths between the two caps are complete documents.

`core/worker.js:56-66` handles this: when `data.truncated` is set or content
reaches 12,000 chars, it prepends a metadata header including `Truncated: true`,
so the userscript's model knows it is reading a fragment.

`benchmark/extract_dataset.js:170-181` does not use `core/worker.js`. It calls the
proxy directly and returns `data.content` raw:

```js
if (data.content && data.content.length > 100) {
    log(`    Proxy success: ${data.content.length} chars`);
    return data.content;          // data.truncated is discarded
}
```

**No row in `dataset.json` contains the string `Truncated: true`.** So the
benchmark's model is shown a silently amputated source while production's model
is told; and the human labeller, reading the live page, saw the whole thing.

Confirmed cases where the deciding evidence is provably past the cut:

- `row_7` — SIV percentages sit further down DHS Yearbook Table 7; the stored text stops in "Employment-Based Preferences". GT `Supported`, 4 models say Not supported *because the table ends*.
- `row_5` — "93 million" and "28%" appear nowhere in the stored 12,000 chars; the MPI page carries them further down.
- `row_3` — same page, same cut: the "4% of global population / 17% of migrants" statistic is past the boundary.
- `row_97` — the byline "Shreve" does not appear in the stored New Yorker text at all, so the source can't even establish the first of the claim's three publications.

Most truncated rows have a label other than `Not supported`, i.e. the label
asserts the source contains something — which for a fragment is exactly the
assertion that can't be trusted.

**It costs about 11 points.** What `npm run analyze` prints, with the six 2026-09-07
label corrections applied:

```
=== Accuracy by source completeness (pooled) ===

  Full sources:      62.3%  (642/1030)
  Truncated sources: 51.0%  (186/365)
  Gap:               11.4 points
```

**Roughly half of that gap is not the model being wrong.** Effectively no scoreable row carries the `Source unavailable`
label (`row_111` does, but no provider has ever run it), yet the verdict is emitted
on 124 calls — every one scored wrong under
4-class exact accuracy. Models emit it twice as often on truncated rows (12.3% vs
7.7%). Of the 42-error truncation cost, 17 is unrewardable `Source unavailable` and
25 is genuine misjudgement. Under the `equalSupportedVsRest` metric — fixed on `main`
in `3697f99` to fold the verdict into "rest" — the gap halves to **5.5 points**
(77.6% vs 72.1%).

The gap holds within every label class — *Supported* 72.5% vs 64.6%,
*Not supported* 63.6% vs 50.0%, and widest on *Partially supported* at 46.3% vs
**16.7%** — and the label mix is near-identical across the two buckets, so it
isn't a composition artifact. (Before excluding the section-B rows the same split
reads 60.9% vs 46.6%, a 14.3-point gap; exclusion lifts the full-source side
because most of those rows sit in it.)

Worse than the accuracy gap: on a truncated source **16.7% of calls falsely
report that a citation fails** — the model returns NOT SUPPORTED where the label
says the source backs the claim fully or partly — against 11.2% on whole sources.
(That measure is unaffected by the `Source unavailable` issue above.)
That is the worst error this tool can make to an editor, and it is concentrated
in exactly the rows where the evidence was cut off before the model could see it.

That number is also the argument against simply deleting these rows. They are not
corrupt data — the userscript hits the same 12,000-char cap, so they are a
faithful reproduction of a real production failure. Dropping them would raise the
headline by ~4 points while the tool got no better, and would delete the only
evidence that this failure mode exists.

---

## E. Degenerate or broken claim spans

The claim isn't a claim, so no label can be right.

| Row | GT | Extracted claim |
|---|---|---|
| `row_189` | Supported | `ISBN 9781936393466.` — a citation-template fragment. Goodreads doesn't print the ISBN in the extracted text, so all 4 fresh models correctly say the number isn't there. Drop the row. |
| `row_78` | Partially supported | `to Jessica Roesler Gund, and George Gund II.` — a fragment beginning mid-sentence. The source names both parents outright; all 4 fresh models say Supported. |
| `row_128` | Partially supported | `Republicans should be ashamed of exploiting this tragedy for their dangerous political games. She subsequently voted against the Laken Riley Act.` — an unattributed quotation with no antecedent for "she", against a raw roll-call vote page. |

Six further rows have claims under 40 characters (`row_53`, `row_82`, `row_84`,
`row_117`, `row_121`, `row_137`); those models handle fine, but they're worth a
glance for the same failure mode.

---

## F. `results.json` integrity (affects metrics, not labels)

**`row_78` is misaligned.** Its four older-provider results discuss the Gaza war,
a TIME op-ed, and countries withdrawing ambassadors from Israel — nothing to do
with Agnes Gund. Rationale/claim token overlap is **0.000** for the old providers
and **0.950** for the new ones. No neighbouring row matches either, and no row in
the current dataset contains an ambassador claim, so those results belong to a
row that has since been removed.

This is exactly the `row_<csv_line>` shift CLAUDE.md documents, at exactly the
v1→v2 insertion boundary: CSV line 77 is the last v1 row (Gaza war, which has
**zero** results) and line 78 is the first v2 row (Agnes Gund). The 2026-05-01
remap fixed rows 75/76/77 and stopped one row short.

Two further integrity notes:

- The four older providers are scored against a dataset extracted **two weeks
  after they ran**. Coverage confirms it: they cover `row_35`/`row_124`/`row_145`/
  `row_176`/`row_188` (now empty sources) and skip `row_98`; the newer four do the
  opposite. Any comparison across those two groups is comparing runs over
  different inputs.
- 71 result rows are errors — mostly `HTTP 402 Insufficient wallet balance`
  (`apertus-70b`, `qwen-sealion`) and `503` (`gemini-3.7-flash`). They're excluded
  from accuracy, but they mean `row_102` and `row_108` rest on 6 votes, not 8.

---

## The `Source unavailable` verdict is unwinnable, and providers differ wildly on it

No scoreable row carries the label, so every emission is scored wrong under exact
accuracy. Emission rates across the eight providers span nearly the whole range:

| Provider | Says `Source unavailable` |
|---|---|
| `claude-sonnet-4-5` | 21.0% |
| `liftwing-qwen3.6-27b` | 18.6% |
| `claude-sonnet-5` | 11.3% |
| `qwen-sealion` | 4.8% |
| `gemini-3.7-flash` | 2.4% |
| `apertus-70b` | 2.1% |
| `gemini-2.5-flash` | 0.6% |
| `hf-gpt-oss-20b` | 0.0% |

That single behaviour costs `liftwing-qwen3.6-27b` ~18.6 points of exact accuracy
no amount of correct judgement can recover. It compounds the problem by barely
using `Partially supported` — 9 predictions against 51 in the ground truth,
collapsing the class into `Not supported` or `Source unavailable`.

Consequently the provider ranking is **not stable across metrics**:

| Metric | Ranking |
|---|---|
| Exact accuracy | gemini-3.7 › gemini-2.5 › hf-gpt-oss › qwen-sealion › sonnet-5 › sonnet-4-5 › apertus › **liftwing** |
| Supported-vs-rest | gemini-3.7 › **sonnet-5** › hf-gpt-oss › **liftwing** › gemini-2.5 › sonnet-4-5 › **qwen-sealion** › apertus |

`liftwing` moves last → 4th, `sonnet-5` 5th → 2nd, `qwen-sealion` 4th → 7th. Only
`gemini-3.7-flash` and `apertus-70b` hold position. Exact accuracy answers "does
the verdict match the label", not "is this verifier useful", and should not be read
as a quality ranking alone.

## Impact

Exact accuracy on the current data, with the six label corrections applied. Only
`row_108` is excluded; rows whose source failed to fetch stay in.

| Provider | All rows (188) | Strict set (140) | Supported-vs-rest (strict) |
|---|---|---|---|
| `gemini-3.7-flash` | 69.2% | **74.8%** | **85.0%** |
| `gemini-2.5-flash` | 67.6% | 71.5% | 79.6% |
| `hf-gpt-oss-20b` | 65.2% | 67.7% | 81.2% |
| `qwen-sealion` | 60.6% | 65.2% | 69.6% |
| `claude-sonnet-5` | 57.5% | 60.2% | 83.5% |
| `apertus-70b` | 54.8% | 54.8% | 62.6% |
| `claude-sonnet-4-5` | 50.3% | 52.6% | 76.6% |
| `liftwing-qwen3.6-27b` | 49.7% | 51.9% | 79.7% |

Pooled: **62.3%** on whole sources against **51.0%** on truncated ones.

Provider *ordering within exact accuracy* is stable — the corrections are spread
thinly enough not to favour one model. Ordering *across* metrics is not, as the third
column shows.

## Status: what has been done

Landed 2026-09-07 — **flags and tooling only; no label was changed.**

- **`source_truncated` on every dataset row.** `extract_dataset.js` now records it
  at fetch time (`proxyContentTruncated`, mirroring `core/worker.js`'s rule)
  instead of discarding `data.truncated`. Existing rows were backfilled from
  length. `fetchSourceContent` returns `{ text, truncated }` rather than a bare
  string, so the flag can't be dropped by a future caller the way it was.
- **`excluded_reason` on the 11 section-B rows**, driven by a new
  `Exclude reason` column in `Benchmarking_data_Citations.csv`. Chosen over
  deleting rows because ids are `row_<csv_line>` — deleting lines shifts every id
  after them, which is exactly the section-F bug. A test pins ids to their CSV
  line, so a future deletion fails loudly.
- **`analyze_results.js --truncation all|full|truncated`**, alongside the existing
  `--version` and `--projection`. Excluded rows leave the headline by default
  (`--include-excluded` restores them); the count is always printed, never
  silent. An unfiltered run prints the pooled full-vs-truncated split. The filter
  **refuses** to run against a dataset with no `source_truncated` anywhere rather
  than treating absent as `false` and answering confidently wrongly.
- **`npm run analyze:full-sources` / `analyze:truncated-sources`** for the
  per-provider figures.
- `tests/truncation.test.js` covers all of it, including a test that fails if the
  benchmark's cap drifts from `core/worker.js`'s.

The clean-source subset the flags give you is `--truncation full` with the
default exclusions: **128 rows**, which is the same set as deleting everything
questionable, but reversible and still able to show the other number.

## Still open

1. **The six section-A labels** and the degenerate claims (`row_189`, `row_128`)
   — deliberately untouched, awaiting review.
2. **Pass `Truncated: true` through to the model.** The flag is now recorded, but
   `source_text` still doesn't carry the marker `core/worker.js` prepends, so the
   benchmark's model is worse informed than production's. This needs a re-extract
   to take effect. Cheapest remaining win.
3. **Decide what to do about the cap** — and in the proxy, not here. Note the fix
   is probably *not* a bigger cap: the head of a document is usually the wrong
   window for a specific claim (`row_7`'s SIV row, `row_5`'s statistic). Before
   committing to that work, re-fetch the 48 rows uncapped and re-run one provider;
   that separates truncation from long sources simply being harder, which the
   14-point gap does not currently distinguish.
4. **The row_78 alignment fix**, and either dropping the pre-2026-05-15 provider
   runs or re-running those four against the current dataset. As it stands the two
   provider cohorts were scored on different inputs.
5. **The stable-id refactor** CLAUDE.md already recommends (content hash, or a
   CSV id column). Section F is the second occurrence of that bug; the exclusion
   column avoids a third but doesn't remove the hazard.

6. **Split the benchmark into a fetchability half and a support half** (deferred,
   2026-09-07). Live sources are not stable, so a number from today and the same
   number in six months differ for reasons that have nothing to do with the model.
   Measured churn: **6 of 189 rows changed fetchability in the two weeks** between
   the April provider runs and the 15 May extraction — five went fetchable → dead,
   one came back — with no code change. Content drifts under stable URLs too
   (`row_168`'s Census Reporter vintage bump, `row_95`'s IEA page, and `row_5`,
   which the 2026-05-08 audit Wayback-bisected to a nine-month window where the
   claim matched MPI and then didn't).

   Today the corpus is **68.3% support-testable / 31.7% everything else** (129
   whole-source rows, 48 truncated, 12 unscoreable). By *error* the ratio is
   91% / 9% — truncation costs 3.5 accuracy points pooled. But the split is
   uneven across models: `gemini-3.7-flash` loses 6.4 points to truncation (22%
   of its errors) while `apertus-70b` loses nothing measurable. **The better the
   verifier, the larger the infrastructure share** — so the conflation worsens as
   models improve.

   The flags added on 2026-09-07 are half of this already: `source_truncated`
   separates "did we fetch enough", `excluded_reason` separates "did we fetch the
   right thing". The missing step is freezing `source_text` once a row is reviewed,
   after which the support half stops moving. WiCE is already this benchmark —
   `docs/wice-benchmark.md` notes it "exercises the prompt and model but **not** the
   CORS-proxy fetch path" because it ships frozen 2023 Common Crawl evidence.

   **Resolve before building:** the two halves cannot share a ground-truth
   principle. `design-plans/2026-05-08-gt-audit-corrections.md` states GT "reflects
   what an editor following the citation would find on the live page, not what was
   captured in `source_text` at extraction time" — which a frozen support benchmark
   contradicts outright. Support wants frozen text with a pinned label;
   fetchability wants the live web, and its metric is retrieval rate and
   completeness, not accuracy. Most of the label churn to date (`row_5`, `row_3`,
   `row_168`) was the page moving rather than anyone misjudging, and disappears
   once support is frozen.

---

*Reproduction: the two load-bearing queries are (a) per-row agreement between
`ground_truth` and the four post-2026-05-15 providers, and (b) `source_truncated`,
now a dataset field. Both run directly off `benchmark/dataset.json` and
`benchmark/results.json`.*
