# Checking uncited text against the model's knowledge

> **Status (2026-11-20):** In progress on `claude/article-accuracy-model-checks-6babki` ([#390](https://github.com/alex-o-748/citation-checker-script/pull/390)); the lead check it builds on (#387) is merged. Built: extraction, the check, the batch pipeline, and the userscript behind a setting that is **off by default** and runs on its own model (§ The userscript). The labeled evaluation set is not built. The numbers come from a smoke test on 7 enwiki articles with 9 injected errors (§ What the smoke test found); they show the shape works and which model to use, and nothing about accuracy.

## The problem

The tool checks a sentence only through a citation. With the lead check
(`docs/design-plans/2026-10-22-lead-checks.md`), the lead is covered too: every
lead sentence is read against the body. What is left is **body text that no
citation covers**, and nothing ever looks at it.

There is a lot of it even in well-sourced articles. On 7 enwiki articles
(2026-10-23, after the rules below): Marie Curie 4 uncited body sentences,
Dolly Parton 6, Nikola Tesla 7, Kraków 11, Ada Lovelace 12, Eiffel Tower 34,
Albert Einstein 33. Moscow Metro has 154.

An uncited sentence has nothing to be checked against, so this check asks the
model what it knows. That is a different kind of evidence from the other two
checks, which are both grounded. The design follows from that difference.

## Design

### Every sentence is checked by exactly one thing

| The sentence is | Checked against | By |
|---|---|---|
| Followed by a citation in its paragraph | Its source | The citation check (unchanged) |
| In the lead (of an article with a body) | The body | The lead check (#387) |
| Neither | The model's general knowledge | **This check** |

The message to editors is one line: *cited text is checked against its source,
the lead against the body, and anything else against the model's general
knowledge.*

### What counts as uncited

**A sentence counts as cited when a citation marker sits in it or anywhere
after it in the same paragraph.** So a paragraph's uncited text is the run of
whole sentences after the sentence holding its last marker, or the whole
paragraph when it has no marker.

- **It is Wikipedia's own reading** of a paragraph-final citation, which may
  cover the sentences before it.
- **It doesn't depend on the claim scope.** #387 dropped a "coverage rule" tied
  to the user's scope setting because the results were hard to explain. This
  rule depends only on the page. One result per revision serves every scope,
  so it can be cached.
- **A sentence with a marker inside it is cited** ("The school, according to
  Smith,[4] was the largest in the city."). The citation is in that sentence,
  and the words after the marker are a fragment, not a sentence.

What is read:

- **Body `<p>`s only**, from the same body #387's `articleBody()` reads: no
  appendix sections, navboxes or reference lists, and nothing inside a table,
  figure, quotation, infobox or hatnote. `core/lead.js` now hands out those
  paragraphs (`bodyParagraphs()`) from the same walk, so "body" means the same
  thing in both checks.
- **Not the lead** when the article has a body. **An article with no headings**
  has no body and so no lead check, and its paragraphs are read here instead.
  No prose is left with no check at all.
- **Lead-ins are left out.** A sentence ending in a colon ("Awards that she
  received include:", "Eiffel said:") introduces a list or quotation, and that
  is usually where the citation is. On the sample this removed 20 of 120
  uncited sentences.
- **Sentences under `MIN_CLAIM_LENGTH` are left out**, like claims that short.
- **At most `UNCITED_MAX_SENTENCES` (150) per article**, in article order, with
  `capped` recorded. Moscow Metro is the case this exists for.

Known gaps, all in the safe direction (a sentence missed, never misreported):

- **Explanatory notes count as citations.** `[a]` from `{{efn}}` is a
  `.reference`. This is #387's separate `core/citations.js` fix; once notes
  stop counting as citations, they stop counting here too.
- **The batch's sentence scope** checks only the last sentence before each
  citation. The earlier sentences of a multi-sentence span count as cited here
  but are checked by nothing in the batch. That is a property of sentence
  scope, not of this rule.
- **With the lead check off**, uncited lead sentences are checked by nothing:
  this check leaves the lead out whenever the article has a body, whether or
  not the lead check runs (the userscript's lead setting, the batch's
  `--lead-check`). Reading the lead here when no lead check runs would close
  it, at the cost of a result that depends on that setting.
- **Articles with no citations at all** are skipped by the sweep before any
  check runs (`ARTICLE_OUTCOMES.NO_CITATIONS`). Picked batches rarely contain
  them. They are the case this check would help most, and a separate change.

### The check reports exceptions, not verdicts

The model gets numbered statements with their context and is asked which ones
it has a **specific reason to believe are wrong**. "None" is the expected
answer. That shapes everything else:

- **A statement it doesn't report has no verdict.** "Not reported" is not
  "checked and fine", so there is no row for it. The CSV holds findings (and
  ERROR rows for sentences a failed call left unchecked), not one row per
  sentence. That is enough to measure precision. Recall needs the labeled set
  (§ Evaluation).
- **Few findings.** At most 3 per call (`UNCITED_PER_CALL_MAX`, stated in the
  prompt and enforced on the answer) and 3 per article
  (`UNCITED_MAX_FINDINGS`, `--uncited-max-findings` to raise), ranked high
  before medium confidence, then by article order.
- **The action is always the same: find a source.** Per WP:V, that is a fair
  request for any uncited statement, true or not. So a false alarm costs a
  citation search, not a correct sentence, and that is what makes a weaker
  model usable here. The model's idea of the correct value is in its comment.
  It is never offered as an edit, because it is the least reliable thing the
  model produces.

### The prompt

`generateUncitedSystemPrompt()`, with its own hash-pinned version
(`UNCITED_PROMPT_VERSION`), like the lead and severity prompts. The verdict
prompt is not touched.

- What to report: a wrong date, number, name, place, title or ranking; events
  in the wrong order or attributed to the wrong person or work; something
  implausible on its face.
- **Only well-established facts**, "the kind any good reference work on the
  subject states". Obscure details are left alone. This line was added after
  the first smoke run (§ What the smoke test found).
- Never report something because the model doesn't know it, can't confirm it,
  or it may postdate its knowledge (the cutoff problem), and never because it
  has no citation.
- No opinions, wording, tone, neutrality or missing detail.
- Each issue gives an `id`, an `excerpt` (the doubted words, copied from the
  statement), `comments`, and a `confidence` of `high` or `medium` (anything
  lower is not to be reported, and is dropped if it is).
- One example: a wrong year that is reported, a true statement, and an obscure
  one that is left alone.

**Input:** the article title, its opening paragraph (capped at 1,000 chars), and
the statements grouped by section and paragraph. Each paragraph comes with the
text before its first statement as context (capped at 1,500 chars, keeping the
end), so "She later moved to Paris" can be resolved. When a call starts partway
through a paragraph, the context includes the uncited sentences before it.

**The excerpt** is checked against the statement it names, using
`core/quote.js`'s normalization with no minimum length: "1899" found inside one
sentence means something, unlike in a whole source. If it isn't there but is in
exactly one other statement of the call, the issue moves to that statement (a
model that numbers off by one still names the words). An issue for no
statement in the call is dropped. The excerpt's status is stored like a quote's.

### Calls

Statements are chunked per provider (`UNCITED_CHUNK_SIZES`: 8 for Lift Wing,
12–15 for the open HF models, 25–30 for the commercial ones; first guesses).
The answer is short, but a reasoning model thinks about each statement first,
and Lift Wing's router clamps output to 4,096 tokens. An answer that runs out
of output budget, or a prompt too long for the model, is retried as two halves,
down to one statement, as in the lead check. `kind: 'uncited'` gets the same
raised output budget as `'group'` and `'lead'`.

### Rows

| Column | Value |
|---|---|
| `check_kind` | `uncited` (fits #387's `VARBINARY(16)`; no migration of its own) |
| `verdict` / `reason_type` | `NOT SUPPORTED` / `doubtful`. The shared vocabulary, so every consumer counts it as flagged |
| `claim_text`, `section_title` | The sentence and its section (null in a headingless article) |
| `source_url` | The article (`index.php?curid=`), as for a lead row. Its `prompt_version` (`u1`) keeps it apart from a lead row in `uniq_finding` |
| `rationale` | The model's comment |
| `source_quote` / `quote_status` | The excerpt and where it was found. The row's source is the article, so its quote is from the article |
| `uncited_confidence` | `high` / `medium`. CSV only, like the severity columns |
| `support_score` | null: the model gives none |

The severity pass never runs on these rows (it needs a source), and the
post-run checks know them. They are not fetches, not duplicates of each other
or of a lead row, and not judged by the verdict prompt's format rules (they
have rules of their own: a confidence and a rationale). They are their own
review stratum (`uncited_doubtful`). An `uncited_check` run check warns when
more than 5% of articles had a sentence left unchecked, and fails above 20%.
That is a share of all articles, because the CSV can't tell a checked article
with no findings from an unchecked one.

## The userscript

A setting, **off by default** (`verifier_uncited_check`): "Check uncited text
against general knowledge". It stays off because the evidence is the model's
memory rather than a source, and it is unvalidated.

**Which model runs it follows the sidebar's provider** (`uncitedModelFor()`),
with no setting of its own:

- **A provider that needs the editor's own key** (Claude, Gemini, OpenAI):
  that provider's model. It is as strong as anything here, and the editor is
  paying for it already.
- **Any free provider** (Lift Wing, Hugging Face, PublicAI): **Lift Wing
  Qwen3.8** (`UNCITED_FREE_PROVIDER`), never the free provider's own model,
  since gpt-oss-20b did worst here.

GLM 5.2 was briefly the free choice (2026-11-20), until the re-run below
showed Qwen3.8 almost as good: 8 of 9 injected errors and no false flag,
against GLM's 9 and one. Not enough to spend the shared Hugging Face credits
#389 moved the defaults off. (Before that it was a dropdown: Lift Wing by
default, or "Same as citation checks".)

It follows the rules #387's report rebuild set for an extra check:

- **A phase of Verify All, never an action of its own.** It runs after the lead
  check, on the chosen model at that model's pace (3 s between Lift Wing
  calls). "Check the lead against the body" was taken off the start screen for
  the same reason, so there is no "Check uncited text" either.
- **The confirmation gives only the time estimate**, and its calls are
  counted in it, as the lead check's are.
- **A section of the lead's shape**, between "Lead vs body" and the citations:
  a header (chevron, "Uncited text", a few words of status), closed so that its
  results arriving never move the citation rows. Its status reads "runs after
  the citations", "checking, 2 of 12", "1 of 12 sentences may be wrong",
  "nothing found in 12 sentences", or "not checked (stopped)".
- **Its findings are ordinary report rows** (`findingHtml()`): "No citation,
  may be wrong", the sentence and the model's comment. Opening one shows the
  doubted words and the section, and highlights the sentence in the article,
  as a lead row does. A note above the rows names the model and says it works
  from general knowledge, not a source, so a finding is a reason to look for a
  source before changing anything. Further notes give the sentence cap, a stop
  part-way, and sentences left unchecked.
- **Doubted words are shown only where they appear in the sentence
  verbatim.** An excerpt found only after normalization, or not found, shows
  nothing, so every character shown is the article's.
- **Not counted, not exported, not logged.** The summary counts citation
  verdicts only. The wikitext and plain-text reports leave the section out:
  unvalidated doubts don't belong on a talk page. The verification log has no
  field for a sentence checked against no source (the lead check has the same
  gap).

Tested in Chromium with real OOUI (2026-11-20), on the rebuilt report:
- Verify All on a small article with stubbed calls. It ran citations, then the
  lead check, then the uncited check. The section sat between the lead's and
  the citations', closed, and opening its row highlighted exactly the
  sentence. Run in light, dark, and Hebrew (RTL).
- The settings (2026-10-24): off by default, the dropdown disabled until the
  setting is on, both persisted.
- A live run on Ada Lovelace against Qwen3.8 (2026-10-24, on the earlier
  report): § What the smoke test found.

`tests/uncited_ui.test.js` pins the shipped methods.

## What the smoke test found

Throwaway harness, 2026-10-23: 7 enwiki articles, 107 uncited sentences, with
9 deliberate errors swapped into uncited sentences (Princeton "from 1935" →
"1915"; Einstein–Cartan → "Einstein and Heisenberg"; Babbage's Turin seminar →
"Oxford"; Wheatstone → "Faraday"; Le Jules Verne → "H. G. Wells"; analogue TV
off "2011" → "1991"; Tesla left "Graz" → "Vienna"; Podgórze on the "Vistula" →
"Danube"; the Einstein House landmark "1976" → "1906"). Two articles had no
injections (Marie Curie, Dolly Parton).

| | Qwen3.6-27B (Lift Wing) | gpt-oss-20b (HF; the userscript's default) |
|---|---|---|
| Injected errors caught | **8 of 9** (missed Graz → Vienna) | 7 of 9 (missed Turin → Oxford, 2011 → 1991) |
| Untouched sentences flagged | **5 of 98** | 14 of 98 |
| Kept in the per-article top 3 | 10, of which 8 injected | 15, of which 5 injected |
| Calls, wall time | 17, 62 s | 15, 73 s |
| Tokens in / out | 22.7k / 2.0k | 18.4k / 26.3k |

What that says:

- **Model choice matters more than anything else measured.** gpt-oss-20b
  confidently denies true facts: that Menabrea became Prime Minister of Italy,
  and that the Committee of Three Hundred existed. It also "corrects" details
  about lifts and foundations. Qwen's five other flags were one that looks like
  a real catch (Einstein: the photon "only became universally accepted in 1919,
  with … Compton scattering", which was 1923), one arguable one, and three wrong
  ones. Two of the wrong ones rest on facts the model invented: a 1916 Einstein
  experiment "with Walter Kaufmann", and the claim that *Backwoods Barbie* was
  not written for *9 to 5: The Musical*, when it was.
- **Confidence ranks nothing yet.** Every finding from both models, in every
  run, was `high`. So the top-3 cut is in effect article order. It happened to
  keep 8 of Qwen's 9 real hits, but for gpt-oss on the Eiffel Tower it kept three
  false flags and dropped the injected error behind them. A better ranking
  signal is the first thing to measure on the evaluation set. **Agreement across
  two runs** is the cheapest candidate: findings varied between otherwise
  identical runs.
- **Two prompt lines came out of the runs.** "Only judge well-established
  facts" took gpt-oss from 19 untouched-sentence flags to 14 at the same recall,
  and left Qwen at 5 (the numbers above are with it). "Decide before you write"
  stopped a Qwen comment that argued its way to "I will report no issues" and
  reported the issue anyway. The flag stayed (still wrong), but the comment now
  states a claim a reviewer can judge.
- **Not tried in the smoke test:** `llm-qwen38-27b`, the `liftwing`
  provider's model since 2026-10-21, which the deployed router rejected on
  2026-10-23 ("Model not allowed") and accepts since 2026-10-24; DeepSeek-V3.2
  through tf-llm-router's `/hf` (its HF token was rejected, 401); GLM and
  DeepSeek through the Worker (not allowed). A larger open model is the obvious
  comparison once one is reachable.
- **Qwen3.8, two browser runs on Ada Lovelace (2026-10-24, 12 uncited
  sentences).** The first, with no error in the checked text, flagged one
  sentence: Menabrea "was never Prime Minister of Italy". He was, from 1867
  to 1869. That is the same confident denial gpt-oss made. The second, with
  Turin → Oxford injected, caught the injection with a correct comment and
  flagged nothing else. Two runs prove nothing, but they point the same way as
  the smoke test: the check catches well-known errors, and its false flags are
  confident and vary between runs.

**GLM 5.2 and Qwen3.8, 2026-11-20** (the same 7 articles and 9 injections;
both reachable by then):

| | GLM 5.2 (HF, Novita) | Qwen3.8-27B (Lift Wing) |
|---|---|---|
| Injected errors caught | **9 of 9** | 8 of 9 (missed Graz → Vienna) |
| Untouched sentences flagged | 1 of 98: the Einstein/Compton sentence, the likely real error above | 0 of 98 |
| Calls, wall time | 11, 101 s | 17, 26 s |
| Tokens in / out | 16.5k / 7.5k | 23.0k / 0.6k |

GLM is the first model to give a `medium` (on Graz → Vienna), and its comments
named the right facts; one of Qwen3.8's credited Augustus De Morgan with what
Babbage did. Seven articles prove nothing, but every run points the same way.

**Consequences:** the userscript runs this check on Lift Wing Qwen3.8 for any
free provider and on the editor's own model for a paid one (§ The userscript).
It is never silently on gpt-oss-20b. The batch uses its `--provider`, Lift
Wing by default. GLM 5.2 is the model to revisit once the evaluation set can
tell one point of recall from noise.

## Code

| Where | What |
|---|---|
| `core/uncited.js` (new) | `uncitedSentences()`: the rule above, for both HTML shapes |
| `core/lead.js` | `bodyParagraphs()`, from the same walk as `articleBody()`; `LEAD_TEXT_NOISE` exported |
| `core/uncited-check.js` (new) | Prompt, `UNCITED_PROMPT_VERSION`, parser, `locateExcerpt()`, `rankUncitedFindings()`, and `runUncitedCheck()`, the one sequence every front end runs |
| `service/claim-extractor.js` | `article.uncited`, plain data |
| `service/verifier.js` | `verifyUncited()`: the comment-language directive and the halt-on-auth rule |
| `service/finding-builder.js` | `CHECK_KINDS.UNCITED`, `assembleUncitedFinding()` |
| `service/run-sweep.js` | `--uncited-check`, `--uncited-max-findings`, the summary line |
| `service/csv-report.js` | `uncited_confidence` |
| `service/sweep-checks.js` | The handling above, `uncitedFormatProblems()`, the `uncited_check` run check |
| `service/run-extract.js` | An uncited line in the funnel, so a past batch can be measured with no model calls |
| `main.js` | The setting, `articleUncited()`, `uncitedModel()`, `runReportUncitedCheck()`, the report section, and strings in all five tables (§ The userscript) |
| `scripts/sync-main.js` | `uncited.js` and `uncited-check.js` in `CORE_ORDER` |

Both core modules are browser-safe and prefix their top-level names, ready for
`scripts/sync-main.js`'s `CORE_ORDER` when the userscript side lands.

## Evaluation

The smoke test's injections are the model for the real set:

- **Injected errors.** Take uncited sentences from Good and Featured articles
  and change one well-established fact in each (a date, a number, a name, a
  place). That measures recall, and whether the injected sentence lands in the
  per-article top 3.
- **The untouched sentences** of the same articles measure how often a correct
  sentence is flagged. Every such flag needs a human look, because some will be
  real (the smoke test's Compton case).
- **Real errors:** the revision before a revert of vandalism to an uncited
  sentence.
- **The metric is precision of what is shown**, the per-article top 3, since
  that is all an editor sees. Recall is secondary: missing an error leaves the
  article as it is today.

Like `dataset_wice.json` and #387's lead set, this goes in its own file and is
never merged into `dataset.json`.

## Stages

1. **Extraction** (`core/uncited.js`, `bodyParagraphs()`), with tests. Done.
2. **The check** (`core/uncited-check.js`), with tests. Done.
3. **Batch** (`--uncited-check`, rows, post-run checks), with tests. Done. Run
   `run-extract.js` over a past batch for real sentence counts, then a small
   sweep with `--uncited-check` on Lift Wing, and hand-check every finding.
4. **The evaluation set** above, and a model comparison on it.
5. **Userscript**, behind a setting that is off by default and on its own
   model, as a phase of Verify All with a report section like the lead's
   (§ The userscript). Done, ahead of 4, because it is opt-in. Turning it on by
   default, exporting its findings, or logging them waits on 4.

## Alternatives considered

- **Whole-article review** ("what in this article seems off?"). It finds things
  in cited text too, but there it competes with a grounded check and its false
  alarms cost more: an editor doubting a correctly sourced sentence. It also
  needs chunking, ranking and merging with citation verdicts. The split keeps
  each check to one kind of evidence.
- **Defining "cited" by the active claim scope.** Rejected for the reason #387
  dropped its coverage rule: results that change with a setting are hard to
  explain, and can't be cached per revision.
- **One row per checked sentence**, with a "not flagged" verdict. That would
  give a recall denominator, but would claim a judgement the model never made,
  and would fill ToolsDB with rows that are never shown.
- **Asking the model for the correct value as a suggested edit.** That is the
  least reliable output, and correcting an encyclopedia from memory is the
  failure the check must not invite.
- **Retrieval or web search to ground the check.** That would make it a
  different, grounded check, with its own fetch path and cost. Worth revisiting
  once this one is measured.
