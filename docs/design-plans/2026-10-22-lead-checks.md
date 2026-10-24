# Checking the lead against the body

> **Status (2026-10-23):** Implemented on `claude/clever-darwin-9yn9ef` (PR #387), all four stages; not yet validated against human labels (the labeled set's tooling exists, the labels don't). Where the build differs from the plan below, see "Implementation notes" at the end. The numbers in "The problem" come from a throwaway prototype over 11 articles (7 enwiki, 4 ruwiki) and one model. The first draft (2026-10-22) proposed a different design; it is recorded under "Alternatives considered".

## The problem

The lead has a different sourcing standard from the body. A lead summarizes the
article, so per [WP:LEADCITE](https://en.wikipedia.org/wiki/Wikipedia:Manual_of_Style/Lead_section#Citations)
a lead statement needs no citation of its own as long as the body covers it,
and the body is cited. Citations in the lead do exist, usually for a quote, a
figure, or something likely to be challenged.

The tool treats a lead citation like any other. That goes wrong in two ways.

**1. False flags on lead citations.** A lead citation usually backs one
specific point, while the claim the tool builds for it takes in the uncited
summary around it. The verifier correctly reports that the source doesn't say
the rest, and the finding is wrong. Real runs, default provider, 2026-10-22:

| Citation | Its source is about | Paragraph-scope claim | Verdict |
|---|---|---|---|
| Einstein [8] | *The Atlantic*, "The Scientist and the Fascist" | 900 chars: Switzerland 1895, the Zurich diploma, Swiss citizenship, the patent office, the PhD, Berlin 1914, Hitler 1933, "Horrified by the Nazi persecution…" | PARTIALLY SUPPORTED: "does not mention Einstein's earlier Swiss citizenship, education, or later German citizenship" |
| Einstein [14] | *Nature*, "Did Einstein really say that?" | 622 chars: statistical mechanics, photons, Bose–Einstein statistics, the last phase of his career, "God does not play dice" | NOT SUPPORTED (contradiction): the letter says "He does not play dice", not "God". A real finding, plus "no mention of statistical mechanics…" |
| Curie [6] | Berkeley Lab: "The term radioactivity was actually coined by Marie Curie" | 405 chars: born in Warsaw, the Flying University, Paris 1891, married Pierre 1895, "radioactivity—a term she coined" | NOT SUPPORTED (omission): "no information about Curie's birthplace, education, sister, or marriage" |

Sentence scope helps, but a lead citation can back only the last *clause* of
its sentence. Curie [6] at sentence scope is "In 1895, Curie married Pierre,
with whom she conducted pioneering research on radioactivity—a term she
coined." It comes back PARTIALLY SUPPORTED: "does not mention that she
married Pierre in 1895". The marriage date is in the body, which is where a
lead expects it to be.

At paragraph scope, lead claims span more sentences than body claims: Einstein
2.67 vs 1.76 sentences per claim (67% vs 39% multi-sentence), Curie 1.64 vs
1.33. Climate change, whose lead is cited almost sentence by sentence, is the
exception (1.32 vs 1.28).

**2. Uncited lead text is never checked.** No citation, no claim, no check.

| | Lead sentences | Inside some citation's claim | Never checked |
|---|---|---|---|
| Paragraph scope (userscript default) | 137 | 75 | **62 (45%)** |
| Sentence scope (batch default) | 137 | 40 | **97 (71%)** |

4 of the 11 leads (Dolly Parton, Haakon VIII, 2026 in Philippine television,
Телевизионный отряд краеведов-следопытов) have no citation at all.

## Design

Two independent checks, and one presentation rule that connects them.

### 1. Citation checks: unchanged

Every citation, the lead's included, is checked exactly as today, at whatever
claim scope the user picked: paragraph by default in the userscript, sentence
in the batch. The verdict prompt is not touched.

### 2. New: the lead check

Every lead sentence is checked against the body, once per article revision.
This happens whether or not the sentence has a citation, and whatever the
claim scope. It is a separate check with its own findings:

| Body verdict | Finding |
|---|---|
| SUPPORTED | Nothing to report |
| PARTIALLY / NOT SUPPORTED (omission) | **Not covered in the body:** add it to the body |
| NOT SUPPORTED (contradiction) | **The lead and body disagree** |

A sentence that fails both its citation check and the lead check is reported
twice, on purpose. These are two different problems with two different
fixes: a better source, and content added to the body.

Because the lead check ignores citations and scope, there is no "which
sentences count as cited" rule. One cached result per revision serves every
scope setting.

### 3. New: lead citations' omission and partial verdicts are demoted

In lead prose, PARTIALLY SUPPORTED and NOT SUPPORTED with `reason_type:
omission` are **demoted**, not deleted. Contradictions and SOURCE UNAVAILABLE
are reported as today.

This is the false-flag fix. Over-crediting a citation with the summary around
it always produces omission or partial (the source "doesn't mention" the
summary), never contradiction. On the three examples:

| Citation | Paragraph scope | Sentence scope |
|---|---|---|
| Curie [6] | omission → demoted ✓ | partial → demoted ✓ |
| Einstein [8] | partial → demoted ✓ | omission → demoted ✓ |
| Einstein [14] | contradiction → kept ✓ | partial → demoted ✗ |

It follows WP:LEADCITE: in the lead, the standard is "the body covers it". The
lead check judges coverage, and a lead citation is reported only when its
source says something different.

**What it costs: real failing lead citations.** With the lead check in place,
most of them still surface another way:

- **If the body doesn't cover the statement**, the lead check flags it.
- **If the body does cover it**, that body text has its own citation, which is
  checked normally.

What is actually lost:

- **The bad lead citation itself, when the body has the content.** A reader
  can still verify the statement through the body, so the stakes are low.
- **Real problems the model happens to label partial.** Einstein [14]'s
  misquote is a contradiction at paragraph scope and partial at sentence
  scope, so "keep contradictions" depends on a label the model doesn't apply
  consistently. "Source hedges, the lead states it as fact" is always
  PARTIALLY.

Two conditions follow:

- **It ships with the lead check, never before.** On its own, it hides real
  findings with nothing to replace them.
- **Demoted rows are kept**, so we can measure how many were real (§
  Evaluation).

It applies to lead **prose** only. Citations in the infobox (also section 0)
are unaffected in v1.

### Where each surface shows it

| | Lead check | Demoted lead citations |
|---|---|---|
| **Userscript, single click** | A "Check lead against body" action, since an uncited sentence has no citation to click | The verdict is still shown, with one line: "This is in the lead, where a statement can be supported by the body instead." The editor asked to see it |
| **Userscript, Verify All** | A "Lead vs body" phase after the citation checks, with cards for "not covered in the body" and "the lead and body disagree" | A collapsed "Lead: omission / partial" group, out of the summary counts and the wikitext report |
| **Batch** | New rows: `check_kind = lead_body`, no citation number, `claim_text` = the sentence, `source_url` = the article's permalink at the swept revision | The row is kept in the CSV and ToolsDB with `lead_demoted = 1`, never published, and skipped by the severity pass |

The batch rows' permalink `source_url` means `source_url_hash` never matches
a citation row's, so the existing unique key can't collide when a lead
sentence is also a citation's claim. Lead-check rows stay unpublished like
every other finding. "Not covered in the body" is a different suggestion type
from "this citation fails", which is a question for the Suggestions team
before anything is published.

Optional, and display only: show the lead-check result for a sentence on its
lead citation's card ("Lead check: covered in the body"). Nothing is
reclassified, but an editor reviewing the demoted group can see at a glance
that it's a placement issue.

## The lead check in detail

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
- **An article with no headings has no body**, so it gets no lead check, and
  its citations are not demoted: nothing would replace them. In general,
  demotion applies only where a lead check runs.
- Leads that are lists (`ul` after "may refer to:") are skipped in v1.

### Sentences

The batch splits lead paragraphs with sentencex (`service/sentences.js`). The
userscript needs a full-sentence split in `core/claim.js`, beside
`lastSentence()`, and the same weaknesses apply. Against sentencex on 2,175
enwiki claims, the regex cut 87 last sentences too short, at initials
("J. Einstein & Cie") and inside quotations. Russian abbreviations
("г. Махачкала") are cut the same way.
A lead split in the wrong place sends a fragment to the body check. So the
splitter fix (no split after a single capital letter, a short abbreviation
list per UI language, no split inside open quotes) is a prerequisite for the
userscript's lead check.

### Size

Body sizes in the sample, before appendix sections were removed: 1.9k to 106k
chars, about 42k for Marie Curie. 2 of the 11 (Einstein, the Philippine TV
list) are over 100k. The Worker already sends sources up to 100,000 chars
(`WORKER_CONTENT_CAP`), so a body under that is the size providers already
handle. A body over budget keeps whole sections, ranked by word overlap with
the lead, until the budget is reached. The check is then marked
`body_truncated`: absence is discounted and contradiction is not, exactly as
for a truncated source.

Retrieval alone was considered and is kept only as that fallback. Retrieval
alone means sending each sentence with just the few body paragraphs that best
match it. A lead is written at a higher level of generality than its body, so
the passage behind "she received numerous other honours" shares few words
with it. An "absent from the body" verdict judged on a retrieved subset is the
false positive this project keeps trying not to produce.

### Calls

Sentences are batched, several per call, with the body sent in each call:

- One call per sentence costs the body × N. For Einstein that is 27 × ~26k
  tokens.
- One call for the whole lead runs out of output budget. In the prototype,
  8 Curie sentences in one call used **15.8k output tokens**. The default
  model reasons first, and its output budget is 16,384. Lift Wing clamps
  output to 4,096 (`core/providers.js`).

So the chunk size is a per-provider constant, probably 3–4 for reasoning
models. The prototype's three Curie calls each took ~10.3k input tokens and
7–19 s.

### Prompt

The lead check gets a new prompt with its own version constant
(`LEAD_PROMPT_VERSION`, hash-pinned like `SEVERITY_PROMPT_VERSION`).
Differences from the citation prompt:

- The "source" is the rest of the same article, labeled by section.
- **A summary counts as support.** A fair summary of what the body says counts,
  including facts gathered from several sections. Specifics don't count unless
  the body states them: numbers, dates, names, superlatives ("the first"),
  direct quotations, and attributed evaluations ("widely regarded as").
- The verdict vocabulary and `reason_type` stay the same, so every downstream
  consumer works unchanged. `omission` here means "not covered in the body".
- The output is a JSON array keyed by sentence number, each with a body quote
  (checked by `core/quote.js` against the body text) and the section it came
  from.

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

Most quotes were paraphrased (`not-found`), so quote fidelity needs work in
the real prompt. One article and one model prove nothing about accuracy; they
do show that the call shape works and that the signal is there.

## Code

| Where | What |
|---|---|
| `core/lead.js` (new) | Find the lead, its prose sentences and the body text, for both HTML shapes. Also `isLeadDemoted(verdict, reasonType)`, the demotion rule as one pure function every surface calls. Joins `scripts/sync-main.js`'s `CORE_ORDER` when the userscript side lands |
| `core/claim.js` | A full-sentence splitter beside `lastSentence()`, injectable like it, with the fixes above |
| `core/prompts.js` | `generateLeadSystemPrompt()` / `generateLeadUserPrompt()`, `LEAD_PROMPT_VERSION` |
| `core/parsing.js` | Parsing an array result |
| `service/verifier.js` | `verifyLead()`: chunking, retry, the halt rule, quote checks against the body |
| `service/run-sweep.js`, `finding-builder.js`, `csv-report.js` | Lead-check rows; `check_kind` and `lead_demoted` columns; severity pass skips demoted rows |
| `service/migrations/006` | `check_kind`, `lead_demoted` |
| `service/sweep-checks.js` | A run check: lead-check ERROR share |
| `main.js` | The Verify All phase, the demoted group, the single-click note, the standalone action. Every new string goes through `this.t()` and into all four message tables |
| `benchmark/dataset_lead.json` (new) | The labeled set below |

## Evaluation

- **A new hand-labeled set:** ~150 lead sentences from ~25 articles (enwiki and
  ruwiki), each labeled against its body as supported / partially / not covered
  / contradicted. It lives in its own file and is never merged into
  `dataset.json`, for the same reason as WiCE: it measures a different task.
  The positive class is "not supported by the body", consistent with the
  repo's "positive = failing".
- **The demotion rule:** hand-check a sample of demoted rows from the first
  sweeps to estimate how many were real failures that nothing else caught.
  That is the one way this design can make things worse.

## Stages

1. **`core/lead.js` and the splitter:** lead, sentences and body for both HTML
   shapes, with tests. No model calls. Add a line to `run-extract.js`'s funnel
   (lead sentences, body size) and run it over a past batch to replace the
   sample numbers above.
2. **The lead check:** prompt, parser, `verifyLead()`, the labeled set, a
   benchmark run.
3. **Batch:** lead-check rows and demotion together, plus the migration and the
   sweep check.
4. **Userscript:** the lead check and demotion together, plus i18n.

## Alternatives considered

- **Coverage rule and conditional downgrade** (the 2026-10-22 draft). Count
  a lead sentence as "cited" when the active scope's claims cover it, send only
  the rest to the body, and downgrade a failing lead citation only when the
  body supports every sentence of its claim. Dropped: the result depended on
  the scope in ways that were hard to explain, and the two checks were coupled.
  At paragraph scope the downgrade needed every sentence of a multi-sentence
  claim body-supported, so one body-check miss kept the false flag (it did
  for Curie [6]).
- **Force sentence scope in the lead.** Doesn't fix Curie [6] (the citation
  backs only the last clause), and the scope setting would mean different
  things in the lead and the body.
- **Make sentence scope the userscript default.** Shrinks the false-flag
  problem, but doesn't remove it. It also first needs the splitter fix, a way
  to keep users who explicitly chose paragraph, and `claim_scope` in the
  verification log (which doesn't record it today). It is still worth
  deciding for the body's sake, but it is a separate question and no longer
  blocks this.

## Related, separate fix

- **Explanatory notes are counted as citations.** `collectCitations()` returns
  `[a]`, `[b]` and `[note 1]` (`{{efn}}` and other group refs) as citations;
  7 in the 11 sample leads. A note has no source URL, so each one becomes a
  SOURCE UNAVAILABLE / `no_url` row. At paragraph scope each note also cuts
  the claim of the next real citation short. Parsoid marks them with
  `data-mw-group` on the marker. This is a separate fix in `core/citations.js`.

## Implementation notes (2026-10-23)

Built as designed, with these differences and additions:

- **Where the prompt lives.** `core/lead-check.js` holds the prompt, its
  hash-pinned `LEAD_PROMPT_VERSION`, the array parser and `runLeadCheck()`,
  the one sequence both front ends run (as `core/severity.js` does for the
  severity pass). `core/prompts.js` is untouched.
- **A lead row's `source_url` is `index.php?curid=<page_id>`**, not the
  revision permalink. By page, so a re-sweep updates the row in place as a
  citation row is updated; the `permalink` column still pins the revision.
- **The batch opts in, the userscript opts out.** `run-sweep.js --lead-check`
  is off by default, like `--severity`: it adds rows of a new kind to CSVs
  volunteers review. In the userscript the lead check is a few calls per
  Verify All rather than one per citation, so it is on by default ("Check the
  lead against the body" in Settings, `verifier_lead_check`).
- **Two failures are absorbed by the check itself**, because both depend on
  how much is asked at once. An answer that ran out of output budget (a
  reasoning model thinking about every sentence) is retried as two calls of
  half the sentences, down to one; it happened on live runs at 4 sentences
  per call. A prompt too long for the model is retried with the body halved,
  down to 10,000 chars. `isOutputBudgetError` moved to `core/retry.js` for
  this.
- **The sentence splitter fix landed in stage 1** for every userscript use,
  not only lead sentences: `core/claim.js`'s `splitSentences()`, which
  `lastSentence()` is now built on. Against sentencex on 2,175 enwiki claims
  it cuts no last sentence short (the old regex cut 87).
- **Footnote lists don't make a section an appendix.** The first version did,
  and dropped short content sections that end in `{{reflist}}` with no
  heading of their own. Only a bibliography (`.refbegin`) holding nearly all
  of a section marks it, plus the per-wiki heading names.
- **Not logged in the userscript.** The verification log has no field to tell
  a lead sentence from a citation, so lead results stay out of it until the
  Worker learns one.
- **The labeled set is tooling only**: `benchmark/extract_lead_dataset.js`,
  `run_lead_benchmark.js`, `analyze_lead.js` (`npm run lead:*`). The ~150
  labels in "Evaluation" are still to be made.
- **Checked end to end in a browser** (Chromium, real OOUI, saved enwiki and
  ruwiki articles, since Wikipedia rate-limits the build container): the
  lead-only check on Haakon VIII, Verify All on Нахлаот in the Russian UI, and
  Verify All on Marie Curie's lead citations, which set aside four: [3], [5],
  [6][7] and [13], each a lead citation credited with summary its source was
  never meant to cover.
