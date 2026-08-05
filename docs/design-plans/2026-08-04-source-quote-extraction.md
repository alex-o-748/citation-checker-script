# Extracting a verified source quote alongside the verdict

> **Status (2026-08-05):** Implemented on branch `claude/quote-extraction-verdicts-8tprub`, merged with `dev`. Benchmark re-run outstanding — see "Open item" below.

## Problem

The model returns a verdict plus a free-text `comments` field. In practice
`comments` usually *contains* a quote from the source, because the few-shot
examples opened with one:

```json
{"confidence": 95, "verdict": "SUPPORTED",
 "comments": "\"Acme Corp was established in 1985. Its founder, John Smith\" - Definitive match with paraphrasing."}
```

Two problems follow from the quote being buried in prose rather than being a
field of its own:

1. **The editor can't check the verdict quickly.** To decide whether to trust a
   "Not supported," they have to read a paragraph of model reasoning and then go
   hunting in the source for the passage it refers to. The one thing that would
   settle it — *what does the source actually say?* — is mixed in with the
   model's opinion about it.
2. **The dataset can't use it.** Ground-truth rows carry the rationale as an
   opaque string. There is no field to compare across providers, no way to ask
   "did this model quote the source at all," and no way to tell a quote from a
   paraphrase of one.

And a third problem that only becomes visible once you look for it: **nothing
was checking that the quote was real.** A model that paraphrases the source, or
invents a plausible sentence, produced output indistinguishable from one that
copied faithfully.

## Goal

A structured `source_quote` field, shown to the editor as evidence, stored in
the dataset — and *verified against the source* before either happens.

The quote is relevant where a passage can exist: SUPPORTED, PARTIALLY
SUPPORTED, and NOT SUPPORTED by contradiction. Omission and SOURCE UNAVAILABLE
have nothing to quote by construction.

## Decisions

### 1. One LLM call, not two

The quote is an extra field in the existing JSON response, not a second
extraction pass. A second call would double cost and latency on every citation
and introduce a new failure mode (the extractor disagreeing with the judge)
in exchange for marginally better quotes. The model has already located the
decisive passage in order to reach its verdict; asking it to name that passage
is nearly free.

**Rejected:** a dedicated extraction call; a local retrieval heuristic
(most-similar sentence to the claim), which is cheap but picks the wrong
sentence whenever the claim is contradicted rather than supported.

### 2. The quote is verified locally, and that check gates the display

`core/quote.js` looks the quote up in the source text the model was actually
shown. This is the load-bearing decision: it converts "the model says the
source says X" into "the source says X," which is a categorically different
claim, and it costs nothing — no API call, no network, deterministic, testable.

Matching is **normalized but not fuzzy**. Case, curly vs straight quotes,
dash variants, line breaks and whitespace runs are folded, because models
reformat constantly and a strict `includes()` would reject most genuine
quotes. Beyond that there is no edit-distance or token-overlap slack: a
passage either occurs in the source or it does not. Ellipsis-joined fragments
(`"A ... B"`) verify when each part occurs, in order.

This is the deliberate reliability trade the tool is tuned for: a paraphrase
close enough to be honest will be rejected along with a fabrication. Missing
some true quotes is acceptable; presenting a fabricated one as evidence is not.

### 3. An unverified quote is never displayed

If the quote doesn't check out, the UI shows a one-line caution — *the quote
the AI gave was not found in the source text* — and the rationale, but **not
the quote text**. Showing it would put a possibly-invented sentence in front of
an editor in the visual position reserved for evidence, which is worse than
showing nothing.

The caution appears only for verdicts that should have had a quote. An
unverifiable quote attached to a SOURCE UNAVAILABLE verdict is noise, not a
warning.

The `status` (`exact` / `normalized` / `partial` / `not-found` / …) is retained
in the result object regardless, so the benchmark can measure quote fidelity
even where the UI stays quiet.

### 4. Only verified quotes leave the tool — except into the log

The wikitext report and the plaintext export carry the quote **only when it
verified**. An on-wiki report is read by other editors who have no way to know
a quote was unchecked.

The verification log is the deliberate exception. `logVerification()` records
`source_quote` and `quote_status` on every row regardless of outcome, because a
`not-found` row is the most informative row in the table: it identifies a
provider that fabricates passages, and it flags a specific check worth
re-reading. Hiding it from an editor and hiding it from the researcher are
different decisions, and only the first one is right.

Source text is arbitrary prose from the open web, so quotes are passed through
`escapeWikitableCell()` (pipes, braces, newlines) before entering a wikitable,
and through `escapeHtml()` before entering the panel.

### 5. `comments` loses its quote prefix

The few-shot examples now put the passage in `source_quote` and keep `comments`
to the explanation. Leaving both would print the same sentence twice in the
panel. This does change the benchmark-tuned prompt — see below.

## What changed

| File | Change |
| --- | --- |
| `core/quote.js` | **New.** `normalizeForMatch`, `verifyQuote`, `quoteExpectedFor`. |
| `core/prompts.js` | `source_quote` in both schemas + copy rules; all 11 few-shot examples updated. Fixed an unescaped `\"` that made one example invalid JSON. |
| `core/parsing.js` | Parses `source_quote` (with `sourceQuote` / `quote` aliases); always a string. |
| `core/submission.js` | Optional `llmQuote` / `llmQuoteVerified` Form fields, and `DATASET_SUBMISSION_OPTIONAL_KEYS` so unconfigured optional fields no longer disable submission. Now reaches only the wikitext report's Submit column — see "Merging with dev". |
| `core/feedback.js` | `source_quote` / `quote_status` in the `/log` payload. |
| `main.js` | `buildQuoteView` / `quoteViewOf` / `quoteHtml`; evidence block in the panel and in all three report surfaces; quote in both exports; `escapeWikitableCell`; French prompt directive not to translate the quote. |
| `cli/verify.js` | Prints the quote when verified, its failure status when not. |
| `benchmark/run_benchmark.js` | Records `source_quote`, `quote_status`, `quote_verified` per result. |
| `benchmark/analyze_results.js` | Per-provider quote **offer rate** and **fidelity**; `calculateMetrics` exported and `main()` gated for tests. |

## Merging with dev

While this branch was in flight, `dev` replaced the panel's Google Form
submission button with in-place rating controls (`buildFeedbackControls`) and
started logging every verification to Neon with a client-minted `check_id`.
That is the same data-quality goal this design was aimed at, reached by a
better route: a database keyed to the exact check, rather than a form the
editor has to fill in.

So the quote follows the verification log rather than the Form. The Form
scaffolding survives only where `dev` still uses it — the Submit column of the
generated wikitext report — and the panel-level quote submission was dropped
with the button it hung off.

The merge required a schema addition; see `docs/worker-logging-reference.md`
for the migration and the reason unverified quotes are stored.

## Open item: benchmark re-run

The prompt changed, so the accuracy numbers in `benchmark/analysis.json` are no
longer strictly comparable. The change is additive (a new field plus copy
rules) and the verdict/confidence/reason_type contract is untouched, so a large
shift would be surprising — but "surprising" is not "measured."

To close it:

```bash
cd benchmark
npm run benchmark -- --output results_quote.json
npx ccs compare results.json results_quote.json --dataset dataset.json
```

Watch for two things: verdict accuracy drift (the risk this re-run exists to
rule out) and the new quote fidelity rate per provider (the payoff — a provider
below ~80% is paraphrasing rather than copying, and its rationales should be
read with that in mind).
