# Benchmark ground-truth audit — 2026-09-06

An audit of `benchmark/dataset.json` (189 rows) against `benchmark/results.json`
(1,472 result rows, 8 providers), looking for rows whose `ground_truth` label is
wrong, unverifiable, or attached to something other than what it appears to
label.

**Headline:** 6 rows have a label I'd call wrong on the evidence in the dataset
itself, and a further ~11 are unscoreable because the stored `source_text` is not
the cited source. Underneath both sits a systemic problem: **50 of 189 rows
(26.5%) store a source silently truncated at the proxy's 12,000-character cap**,
so the labeller and the model were not looking at the same document.

Removing the unscoreable rows and correcting the six labels moves pooled accuracy
from **57.2% → 60.4%**, and moves individual providers by up to **+4.6 points**.
The ranking is stable, but the absolute numbers are not.

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
dataset can confirm it, and the model is being marked wrong for correctly saying
so.

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

**50 of 189 rows (26.5%) have `source_text` at the 11,900–12,000 char boundary.**
That is the CORS proxy's content cap, not the length of the documents.

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

39 of the 50 truncated rows have a GT other than `Not supported`, i.e. the label
asserts the source contains something — which for a fragment is exactly the
assertion that can't be trusted.

Note also `benchmark/extract_dataset.js:208`, the direct-fetch fallback, applies a
separate 50,000-char cap (`row_81` is one such row), so "truncated" has two
different meanings in this dataset.

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

## Impact

Pooled accuracy across all 8 providers:

| | As-is | Unscoreable rows removed | + the 6 label corrections |
|---|---|---|---|
| **Pooled** | 57.2% | 58.2% | **60.4%** |
| `gemini-3.7-flash` | 67.1% | 68.6% | **71.4%** |
| `gemini-2.5-flash` | 65.6% | 66.7% | 68.2% |
| `hf-gpt-oss-20b` | 62.6% | 64.0% | 67.2% |
| `qwen-sealion` | 58.7% | 60.3% | 62.1% |
| `claude-sonnet-5` | 54.4% | 55.6% | 58.8% |
| `apertus-70b` | 52.9% | 52.1% | 53.8% |
| `claude-sonnet-4-5` | 48.9% | 49.7% | 50.6% |
| `liftwing-qwen3.6-27b` | 47.3% | 48.3% | 50.8% |

Provider *ordering* barely moves — the errors are spread thinly enough not to
favour one model. What moves is the level, by roughly 3 points pooled and 4.6 for
`claude-sonnet-5`, and the truncation problem in section D is not costed here at
all because fixing it needs a re-fetch, not a relabel.

---

## Suggested order of work

1. **Stop the truncation from being silent.** Have `extract_dataset.js` go through
   `core/worker.js` (or at minimum carry `data.truncated` into the stored text)
   so the benchmark and the userscript show the model the same thing. Then
   re-fetch the 50 truncated rows with a higher cap and re-check their labels —
   this is the largest single source of doubt in the dataset.
2. **Quarantine section B.** Mark the 11 rows `needs_manual_review: true` and
   exclude them from headline accuracy until re-fetched; several are permanently
   dead (`row_144`'s eBird bot wall, `row_17`'s PDF).
3. **Apply the six section-A corrections**, and decide whether `row_189`,
   `row_78` and `row_128` should be relabelled or dropped as degenerate.
4. **Re-run the row_78 alignment fix** and drop the pre-2026-05-15 provider runs,
   or re-run those four providers against the current dataset. As it stands the
   two provider cohorts are not comparable.
5. **Consider the stable-id refactor** CLAUDE.md already recommends (content hash
   or a CSV id column). Section F is the second occurrence of the same bug.

---

*Reproduction: the audit scripts used here are throwaway; the two load-bearing
queries are (a) per-row agreement between `ground_truth` and the four
post-2026-05-15 providers, and (b) `source_text.length >= 11900` as a truncation
proxy. Both run directly off `benchmark/dataset.json` and `benchmark/results.json`.*
