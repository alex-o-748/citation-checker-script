# Checking the lead: cited parts against their sources, the rest against the body

> **Status (2026-10-22):** Proposed. Nothing is built. The numbers below come from a throwaway prototype run over 11 articles (7 enwiki, 4 ruwiki) and one model, not from the pipeline. Stage 1 below produces the real numbers.

## The problem

The lead has a different sourcing standard from the body. A lead summarizes the
article, so per [WP:LEADCITE](https://en.wikipedia.org/wiki/Wikipedia:Manual_of_Style/Lead_section#Citations)
a lead statement needs no citation of its own as long as the body covers it,
and the body is cited. Citations in the lead do exist, usually for a quote, a
figure, or something likely to be challenged. Where there is one, it should
support what it is attached to.

The tool treats a lead citation like any other. That goes wrong in two
opposite directions, and the claim scope decides which one dominates.

**1. Lead citations get credited with the summary around them.** A lead
citation usually backs one specific point, while the claim the tool builds for
it takes in the uncited summary sentences before it. The verifier then
correctly reports that the source doesn't say most of that, and the finding is
wrong. Real runs, default provider, 2026-10-22:

| Citation | Its source is about | Paragraph-scope claim | Verdict |
|---|---|---|---|
| Einstein [8] | *The Atlantic*, "The Scientist and the Fascist" | 900 chars: Switzerland 1895, the Zurich diploma, Swiss citizenship, the patent office, the PhD, Berlin 1914, Hitler 1933, "Horrified by the Nazi persecution…" | PARTIALLY SUPPORTED: "does not mention Einstein's earlier Swiss citizenship, education, or later German citizenship" |
| Einstein [14] | *Nature*, "Did Einstein really say that?" | 622 chars: statistical mechanics, photons, Bose–Einstein statistics, the last phase of his career, "God does not play dice" | NOT SUPPORTED: no mention of "statistical mechanics, quantum theory, Bose–Einstein statistics…" (plus a real point about the quote; see below) |
| Curie [6] | Berkeley Lab: "The term radioactivity was actually coined by Marie Curie" | 405 chars: born in Warsaw, the Flying University, Paris 1891, married Pierre 1895, "radioactivity—a term she coined" | NOT SUPPORTED: "no information about Curie's birthplace, education, sister, or marriage" |

Sentence scope helps less than you'd expect, because a lead citation can back
only the last *clause* of its sentence. Curie [6] at sentence scope is
"In 1895, Curie married Pierre, with whom she conducted pioneering research on
radioactivity—a term she coined." It comes back PARTIALLY SUPPORTED: "does not
mention that she married Pierre in 1895". The marriage date is in the body,
which is where a lead expects it to be.

**2. Uncited lead text is never checked at all.** No citation, no claim, no
check. Curie's fourth lead paragraph (the neoplasm studies, both Curie
Institutes, the mobile radiography units) has no citation, so nothing in it
is ever looked at. In the sample:

| | Lead sentences | Covered by some citation's claim | Never checked |
|---|---|---|---|
| Paragraph scope | 137 | 75 | **62 (45%)** |
| Sentence scope (batch default) | 137 | 40 | **97 (71%)** |

4 of the 11 leads (Dolly Parton, Haakon VIII, 2026 in Philippine television,
Телевизионный отряд краеведов-следопытов) have no citation at all, so the tool
never touches them.

Problem 1 is also measurable without a model. At paragraph scope, lead claims
span more sentences than body claims: Einstein 2.67 vs 1.76 sentences per
claim (67% vs 39% multi-sentence), Curie 1.64 vs 1.33. Climate change, whose
lead is cited almost sentence by sentence, is the exception (1.32 vs 1.28).

## The rule: what counts as "cited" in each scope

> A lead sentence is **cited** when the claims the active scope attaches to
> citations cover all of it. Every other lead sentence is **uncited**.

This is just the complement of what the tool already checks, so it moves with
the scope automatically. Curie's third lead paragraph, with its one citation
pair:

> ¹Curie was born in Warsaw, Russian Empire, where she studied at the
> clandestine Flying University and began her practical scientific training.
> ²In 1891, Curie followed her elder sister Bronisława to study in Paris, where
> she earned her higher degrees and conducted her subsequent scientific work.
> ³In 1895, Curie married Pierre, with whom she conducted pioneering research on
> radioactivity—a term she coined.[6][7] ⁴Pierre died in 1906 in a Paris street
> accident.

| | Checked against [6][7] | Uncited (checked against the body) |
|---|---|---|
| Paragraph scope | ¹ ² ³ | ⁴ |
| Sentence scope | ³ | ¹ ² ⁴ |

The unit is the **sentence**, not the leftover characters. When a citation sits
mid-sentence and the rest of the sentence has none, the whole sentence goes to
the body check, not just the fragment after the marker. The fragment Curie's
first sentence leaves behind, "was a Polish and naturalised-French physicist
and chemist.", has no subject and can't be checked by itself.
Mid-sentence citations are a common ruwiki lead pattern, where the birth date
is cited inside the parentheses: "Энсон Бун (англ. Anson Boon; род. 15 февраля 2000,
Питерборо, Англия[1]) — английский театральный- и киноактёр."

## Proposal

### 1. Every lead sentence is checked against the body, once per article

One body check per article revision: the body text (§ "What counts as body"),
labeled by section, plus every lead sentence, numbered. The output is one
verdict per sentence, a body quote checked by `core/quote.js` the same way
source quotes are, and the section the quote came from.

That means *every* lead sentence, not just the uncited ones:

- **The body check doesn't depend on the scope.** The scope only changes how
  its result is read (§3). One cached result serves both scopes, and changing
  the setting doesn't re-run it.
- **It catches lead/body contradictions in cited sentences too.** A lead that
  gives one date with a citation while the body gives another is a finding
  worth having.
- **It costs little extra.** The body dominates the tokens and is sent anyway.
  A sentence adds a few dozen tokens of input and one item of output.

### 2. Lead citations are checked against their sources, as today

No change to the verdict prompt or the scope rules. The body check runs
alongside the source check; it doesn't replace it.

### 3. Reading the two together

| Lead text | Against its source | Against the body | Result |
|---|---|---|---|
| Uncited sentence | — | SUPPORTED | Nothing to report |
| Uncited sentence | — | PARTIALLY / NOT SUPPORTED (omission) | **Finding: not covered in the body** |
| Any lead sentence | any | NOT SUPPORTED (contradiction) | **Finding: lead contradicts the body** |
| Cited claim | SUPPORTED | any but contradiction | As today |
| Cited claim | PARTIALLY / NOT SUPPORTED (omission) | Every sentence it touches SUPPORTED | **Downgraded:** the citation doesn't support this, but the body does |
| Cited claim | PARTIALLY / NOT SUPPORTED (omission) | Some sentence not SUPPORTED | As today |
| Cited claim | NOT SUPPORTED (contradiction) | any | As today: a contradiction stands |

This is what makes **both** scopes behave correctly in the lead. Einstein
[8]'s 900-character paragraph claim fails against *The Atlantic*. Those
sentences summarize the body's biography sections, so if the body check finds
them there, the finding drops to "body covers it" instead of reaching an
editor as a failed citation. At sentence scope the same sentences are uncited
and go straight to the body check. Curie [6] at sentence scope would be
downgraded the same way: in the prototype the body check found the 1895
marriage. Either way, every lead sentence is checked against *something*. The
scopes differ only in which check is primary for a given sentence.

**A contradiction is never downgraded**, the same rule the severity pass
applies to truncation. Einstein [14] is the example: *Nature* says the line in
Einstein's letter was "He does not play dice", not "God", and that point
survives whatever the body says.

**It fails safe in one direction.** When the body check misses support that is
there (it did on one Curie sentence in the prototype), the flag stays as it is
today. Only a false SUPPORTED from the body check makes things worse, by
downgrading a citation that really is bad. That is the error rate to measure
before shipping (§ Evaluation).

### Alternative considered: force sentence scope in the lead

This is simpler: no fallback, and each lead citation is judged on one
sentence. It fixes too little and breaks one thing:

- It doesn't fix Curie [6]: at sentence scope the citation still backs only
  the last clause.
- When a lead cites once at the end of a paragraph *for* the paragraph, which
  is common in short articles and ruwiki leads, the earlier sentences would be
  sent to the body check. If the body is thin they come back "not in the
  body", even though the citation supports them.
- The scope setting would mean different things in the lead and in the body.

The fallback costs no extra call, because the body check runs anyway.

## The body check

### What counts as lead and body

| | Parsoid (batch) | Browser skin (userscript) |
|---|---|---|
| Lead | `section[data-mw-section-id="0"]` | `.mw-parser-output` children before the first `.mw-heading` / `h2` |
| Lead prose | `p` not inside an infobox, table, figure, hatnote, sidebar or maintenance box | same |
| Body | every later section | everything after the first heading |
| Never part of the body | reference lists, navboxes, hatnotes, sidebars, infoboxes, edit links, citation markers, and the appendix sections (See also, Further reading, External links, bibliographies) | same |

- **The lead is never part of the body text.** If it were, every lead
  sentence would support itself. A test pins this.
- **Appendix sections have to go.** The prototype sent Curie's "Nonfiction"
  reading list and "See also" links to the model as if they were body text.
  Heading names are per language (Примечания, Литература, Ссылки), so detect
  appendices by structure first (a section that holds a reference list,
  `.refbegin`, or only a list of links) and use a per-wiki list of headings as
  a backstop.
- **The infobox counts as neither** in v1. It is a summary too, with its own
  conventions, and its cited cells are already checked as citations.
- **An article with no headings has no body.** Lead logic is off, and the
  article behaves exactly as today.
- Leads that are lists (`ul` after "may refer to:") are skipped in v1.

### Size

Body sizes in the sample, before appendix sections were removed: 1.9k to 106k
chars, about 42k for Marie Curie. 2 of the 11 (Einstein, the Philippine TV
list) are over 100k. The Worker already
sends sources up to 100,000 chars (`WORKER_CONTENT_CAP`), so a body under
that is the size providers already handle. A body over budget keeps whole
sections, ranked by word overlap with the lead, until the budget is reached.
The check is then marked `body_truncated`: absence is discounted and
contradiction is not, exactly as for a truncated source.

Retrieval alone was considered and is kept only as that fallback. Retrieval
alone means sending each sentence with just the few body paragraphs that best
match it. A lead is written at a higher level of generality than its body, so
the passage behind "she received numerous other honours" shares few words
with it. An "absent from the body" verdict judged on a retrieved subset is
exactly the false positive this project keeps trying not to produce.

### Calls

Sentences are batched, several per call, with the body sent in each call:

- One call per sentence costs the body × N. For Einstein that is 27 × ~26k
  tokens.
- One call for the whole lead runs out of output budget. In the prototype,
  8 Curie sentences per call used **15.8k output tokens** in one chunk. The
  default model reasons first, and its output budget is 16,384. Lift Wing
  clamps output to 4,096 (`core/providers.js`), so 8 per call is out of the
  question there.

So the chunk size is a per-provider constant, probably 3–4 for reasoning
models. The prototype's three Curie calls each took ~10.3k input tokens and
7–19 s.

### Prompt

The body check gets a new prompt with its own version constant
(`LEAD_PROMPT_VERSION`, hash-pinned like `SEVERITY_PROMPT_VERSION`). The
verdict prompt is not touched. Differences from the citation prompt:

- The "source" is the rest of the same article, labeled by section.
- **A summary counts as support.** A fair summary of what the body says counts,
  including facts gathered from several sections. Specifics don't count unless
  the body states them: numbers, dates, names, superlatives ("the first"),
  direct quotations, and attributed evaluations ("widely regarded as").
- The verdict vocabulary and `reason_type` stay the same, so every downstream
  consumer works unchanged. `omission` here means "not covered in the body".
- The output is a JSON array keyed by sentence number.

### What the prototype found

The prototype ran on Marie Curie's 20 lead sentences against its 42.7k-char
body, with no few-shot examples and the default provider. 11 came back
SUPPORTED. Spot-checked against the body, most of the 9 flags hold up:

- **Not in the body**, and right: the neoplasm studies (an uncited lead
  paragraph), "the first married couple to win the Nobel Prize… five Nobel
  Prizes", Poland's 2011 Year of Marie Curie, and "naturalised-French".
- **Not quite what the body says**, and useful: "founded the Curie Institute in
  Paris in 1920". The body says the Radium Institute was created *for* her,
  on an initiative from 1909.
- **Arguable:** "the only person to win a Nobel Prize in two different
  scientific fields" came back as a contradiction. The body says she "remains
  alone with Linus Pauling as Nobel laureates in two fields each", and it
  doesn't say that Pauling's second prize (Peace) is not a science.
- **Wrong:** "In 1891, Curie followed her elder sister Bronisława to study in
  Paris" came back as an omission. The body covers it across three paragraphs.

For Curie [6] that splits by scope. At sentence scope the body check
supported the 1895 marriage, so the false flag would be downgraded. At
paragraph scope it would stay, because the check missed sentence ² (the
fail-safe direction). The Einstein body was not run. Most quotes were
paraphrased (`not-found`), so quote fidelity needs work in the real prompt.
One article and one model prove nothing about accuracy; they do show that the
call shape works and that the signal is there.

## Output

### Userscript

- **Verify All** gets a "Lead vs body" phase after the citation checks: one
  batched call, or a few chunks. An uncited sentence the body doesn't cover
  gets a report card ("Not covered in the body"; clicking it scrolls to its
  paragraph). A flagged lead citation the body covers gets a note and moves to
  a lower filter.
- **Single click on a lead citation:** the check is unchanged. If the verdict
  isn't SUPPORTED, a "Check against the article body" button runs the body
  check for that one claim. It doesn't run automatically: with a user's own
  key, a body-sized call on every click costs real money.
- **A separate "Check lead against body" action**, because an uncited sentence
  has no citation to click.
- Every new string goes through `this.t()` and into all four message tables.

### Batch

- New rows: `check_kind = lead_body`, no citation number, `claim_text` = the
  lead sentence, and `source_url` = the article's permalink at the swept
  revision. Because of that URL, `source_url_hash` never matches a citation
  row's, so the existing unique key can't collide even when a sentence is also
  a citation's claim.
- Citation rows in the lead get a `body_verdict` column. In severity ranking, a
  flagged lead citation that the body covers gets a new tier below `T3`.
- ToolsDB: migration 006 adds `check_kind` and `body_verdict`.
- The rows stay unpublished. An uncited lead sentence the body doesn't cover is
  a different kind of suggestion from a failing citation: the fix is in the
  body, or a new citation, not a better source. That is a question for the
  Suggestions team before anything is published.

## Evaluation

- **A new hand-labeled set:** ~150 lead sentences from ~25 articles (enwiki and
  ruwiki), each labeled against its body as supported / partially / not covered
  / contradicted. It lives in its own file, `benchmark/dataset_lead.json`, and
  is never merged into `dataset.json`, for the same reason as WiCE: it measures
  a different task. The positive class is "not supported by the body",
  consistent with the repo's "positive = failing".
- **The downgrade rule:** count how many lead-citation flags in past sweeps it
  would move, and hand-check a sample for false downgrades. This is the one
  direction in which the change can make things worse (see "It fails safe in
  one direction").

## Related: explanatory notes are counted as citations

`collectCitations()` returns `[a]`, `[b]` and `[note 1]` (`{{efn}}` and other
group refs) as citations. Curie's first sentence has two and Einstein's has
one; 7 in the 11 sample leads. A note has no source URL, so each one becomes a
SOURCE UNAVAILABLE / `no_url` row. At paragraph scope each note also cuts the
claim of the next real citation short. Lead coverage must ignore notes, since
a note supports nothing. Parsoid marks them with `data-mw-group` on the marker.
The general fix belongs in `core/citations.js` and is a separate change.

## Stages

1. **`core/lead.js`:** lead and body extraction plus the coverage rule, for
   both HTML shapes and both scopes, with tests. No model calls. Add a line to
   `run-extract.js`'s funnel (lead sentences cited / uncited, per scope) and run
   it over a past batch to replace the sample numbers above.
2. **Body check:** prompt, parser, `service/verifier.js`'s `verifyLead()`, the
   labeled set, a benchmark run.
3. **Batch:** `run-sweep.js` rows and columns, the severity tier, a sweep check
   (lead-check ERROR share), and the migration.
4. **Userscript:** the Verify All phase, the single-click button, i18n.
   `core/lead.js` joins `CORE_ORDER` here.

## Open decisions

1. **Paragraph scope in the lead:** keep it, with the body fallback (proposed),
   or force sentence scope in the lead.
2. **Body check coverage:** every lead sentence (proposed) or only the
   uncited ones.
3. **A flagged lead citation that the body covers:** a low tier (proposed) or
   suppressed altogether.
4. **Explanatory notes:** fix them in `collectCitations()` for the whole article
   (proposed, as a separate PR) or only in the lead coverage rule.
