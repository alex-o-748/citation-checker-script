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

> **Amended twice, 2026-08-11.** Unlocated text is still never shown. But the
> *unit* was too blunt — see "The PDF hyphenation case" — and the caution line
> described below has since been removed entirely; see "Withdrawing the
> caution line". Both amendments are at the end of this document.


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

## The PDF hyphenation case (2026-08-11)

A live check on *First Baptist Church (Las Vegas, New Mexico)* against an NRHP
nomination PDF logged `quote_status: "partial"`, so the panel showed a caution
line instead of a quote — on a SUPPORTED verdict at confidence 95, where the
model's quote was in fact entirely genuine.

The cause was in the source, not the model. A PDF text layer breaks words
across lines and leaves the hyphen behind, so the document contains
`two-\nstory` and `school-\nlike`. The model copied the first artifact
verbatim (`two- story` — the giveaway, visible in the logged quote) and
silently repaired the second to `school-like`. One fragment of three therefore
missed, and the whole quote was suppressed.

Two changes, and the second is the more important one:

1. **Fold `-\s+` to `-` in normalization.** Symmetric, so a genuine quote
   matches whether the model kept the artifact or repaired it. This alone
   makes the reported case verify whole.
2. **Show the fragments that did verify.** `verifyQuote` now returns
   `verifiedText` — the located fragments, ellipsis-joined — and every renderer
   displays that rather than the model's raw quote. A `partial` result shows
   its genuine fragments with a note that something was dropped, instead of
   showing nothing.

The guarantee is untouched: every character displayed was found in the source.
What changed is the granularity at which it is enforced — per fragment rather
than per quote. The original design threw away two verified sentences because a
third didn't match, which served the guarantee's letter and not its purpose.

Worth noting for the benchmark re-run: PDF-derived sources are common in the
dataset, so the pre-fix quote fidelity numbers would have understated every
provider.

## Withdrawing the caution line (2026-08-11)

The original design paired a hidden quote with a visible warning: *the quote
the AI gave was not found in the source text — judge the explanation below with
that in mind.* The maintainer's objection, on seeing it in the panel, was that
it is debugging output wearing a user-facing coat — **unless we know the
verdict is actually less accurate when the quote doesn't verify.**

That is right, and the warning is worse than merely unhelpful. It makes an
implicit claim — *trust this verdict less* — that nothing has established. A
model that paraphrases rather than copies may be judging perfectly well; quote
fidelity and verdict accuracy are separate properties and have not been shown
to correlate. Steering an editor away from a correct verdict is a definite cost
paid for a speculative benefit.

So the panel now shows the located text or nothing, and a partial match is
presented identically to a full one. The block makes one promise — *this text
is in the source* — and it holds in both cases. Anything beyond that was
commentary on the model, not evidence about the claim.

Nothing is lost for research: `quote_status` is still logged on every row. And
the question is now measurable rather than rhetorical — `npm run analyze`
reports verdict accuracy split by whether the quote verified, plus the gap
between them. A large gap earns the warning its place back. A gap near zero
settles it.

The general rule this leaves behind: **the panel reports what the source says,
not how the model behaved.** The log is where model behaviour belongs.

## The HTML entity case (2026-08-11)

A Harmon Killebrew check against twincities.com produced a quote that was
correct word for word and still came back `not-found`.

The CORS proxy's `extractText()` (`alex-o-748/public-ai-proxy`,
`src/index.js:605`) decodes exactly four entities — `&nbsp; &amp; &lt; &gt;`.
twincities.com is WordPress, whose `wptexturize` emits curly apostrophes as
`&#8217;`, so the source text handed to the model reads *the mall&#8217;s
amusement park*. The model understood the entity, and quoted it back as *the
mall's*. Verification then compared a literal `&#8217;` against `'`.

This is the same class as the PDF hyphenation case above — an encoding
difference between what the source literally contains and what the model
sensibly wrote — and it takes the same shape of fix: `normalizeForMatch` now
decodes numeric, hex and common named entities before the character folds.
Symmetric, so it can only make a genuine quote match.

The deeper fix belongs upstream: **the model should not be reading raw entities
either.** Every `&#8217;` in a source is a token spent on nothing and a small
comprehension hazard, and the extractor is where it should be resolved. That is
a Worker change; the client-side decode is what makes verification correct
regardless of who did the extracting, including manual paste and PDF paths the
Worker never touches.

Both cases point the same way: a mismatch between quote and source is far more
often an artifact of how the source was extracted than a sign the model made
something up. Worth remembering before reading `not-found` as fabrication.

## The artifact sweep (2026-08-11)

Two false negatives in a row, both encoding artifacts, was enough to stop
fixing them one at a time. A probe ran fifteen realistic manglings — the
Worker's `extractText` applied to real HTML shapes, PDF text-layer quirks, and
the ways a model reformats when it copies — against quotes that were genuinely
correct. **Six of the fifteen failed.**

Fixed, because in each the entity and the character are the same thing:

| Artifact | Example | Fix |
| --- | --- | --- |
| Latin-1 letter entities | `Jos&eacute;` vs `José` | Table generated from U+00C0..U+00FF |
| Modifier-letter apostrophe | `Hawaiʻi` vs `Hawai'i` | Added U+02BC/U+02BC to the quote fold |
| Model-added full stop | source ends `…2002`, quote ends `…2002.` | Retry without trailing `[.,;:]`, and display the *trimmed* form so the shown text is still exactly the source's |

The first is the one that matters: the entity fix shipped an hour earlier
covered punctuation only, so every accented name in an older CMS was still
failing. A partial fix to a whole-class bug reads as a fix and isn't one.

**Deliberately still rejected**, with tests pinning them so nobody "fixes" them
later:

- **Letter-spaced headings** (`A N N U A L  R E P O R T`). Matching these needs
  space-insensitive comparison, under which almost any text matches almost any
  other.
- **A word split by an inline tag** (`Kille<em>brew</em>` → `Kille brew`). Same
  space-insensitivity problem, and the real fix is upstream: `extractText`
  replaces every tag with a space, including tags that sit inside a word.
- **Bracketed insertions** (`[sic]`) mid-quote. Removing bracketed content
  could remove real source text.

The pattern worth carrying forward: **`not-found` has so far always meant the
extractor mangled the text, never that the model invented it.** Treat a report
of a wrong `not-found` as an extraction bug until proven otherwise, and probe
the whole class rather than the instance.

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
