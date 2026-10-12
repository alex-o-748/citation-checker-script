# Giving the verifier the claim's context

> **Status (2026-10-12):** In progress. Step 1 (the experiment) is built and has had a first run on gpt-oss-20b: **no gain, a small shift toward false flags, and a weak leakage signal**, so the `c1` context block is not wired into any front end. See Results. Steps 2–4 are on hold pending the follow-ups listed there.

## The problem

The verifier sees a claim and a source, and nothing else. A claim cut out of an
article often can't be read on its own:

- **Who or what it is about.** "He resigned", "The band split", "It was the
  unofficial remake of *Love Actually*". 20 of the 189 benchmark claims open
  with a pronoun or a bare referent.
- **Which name is meant.** *"That evening, Benomar announced an agreement…"* is
  flagged by gpt-oss-20b because the source "does not mention Benomar; it only
  refers to the UN envoy". The article links *Benomar* to *Jamal Benomar*, the
  UN envoy, and the model has no way to know.
- **When.** "A few weeks later", "That evening", and a source that says "on
  Wednesday" while the claim says "7 January" (a Supported row that Sonnet 5
  flags for that reason). The second needs the *source's* publication date,
  not anything from the article.
- **What the fragment is.** The between-citations rule can cut a sentence in
  half: *"and 1.0% who were granted the Special Immigrant Visa…"*. The
  subject is in the part before the previous citation.

The batch pipeline makes this worse on purpose: `claimScope: 'sentence'` keeps
only the claim's last sentence, to stop a multi-sentence span from producing a
false NOT SUPPORTED (see CLAUDE.md). That choice trades away exactly the
sentences that say what the last one refers to. Severity ranking already hit
this and added title, section and paragraph for its own prompt
(`core/article-context.js`, 2026-09-24).

How big the problem is on our own benchmark is unclear. Pronoun-led claims
score 55.5% exact against 59.8% for the rest, with the same false-positive
rate (27.5% vs 29.3%). That's from 20 rows. About 10 of the 186 false positives
on Supported rows have rationales that are visibly about the referent. But the
benchmark was extracted at **paragraph** scope (median claim 136 characters,
often two sentences), so it understates what sentence scope loses.

## The principle: what to verify is not what to read

Today `claimScope` decides both how much text is checked and how much text the
model sees. That is why each choice costs something: paragraph scope gives
context but makes the model verify sentences that have their own citations,
and sentence scope is precise but leaves the model without context.

Context separates the two. The claim stays exactly the cited span. The
surrounding text comes in as **read-only**, for interpreting the claim only.
If that holds, sentence scope can become the default everywhere, not only in
batch.

### Context is never evidence

Context can go wrong in two directions:

| Failure | What happens | Cost |
|---|---|---|
| **Leakage** | The model counts the surrounding text as support | A false SUPPORTED that **hides a real failure**. This is the dangerous one: nobody reviews a citation the tool passed |
| **Scope creep** | The model verifies the surrounding text too | A false flag, which is the noise sentence scope was introduced to remove |

They can cancel in an accuracy number, so each is measured on its own (see
Probes below). The prompt names both (`CLAIM_CONTEXT_RULE`, wording pinned by
`tests/claim_context.test.js`), following the severity prompt's "never use
the article context as evidence" rule.

## Which context

Grouped by what it costs to get, since that decides the build order.

| Tier | Context | From | Fixes |
|---|---|---|---|
| **0: article DOM, free** | Article title (and short description) | page | "he", "the company" |
| | Text before the claim in its block, with the claim's position known | the same walk `core/claim.js` does | pronouns, "that evening", cut-off fragments |
| | **Wikilink targets inside the claim** (*Benomar* → *Jamal Benomar*, *PLC* → *Presidential Leadership Council*) | `<a>` elements in the span | identity, abbreviations. Precise and almost free, so likely the best value per token here |
| | Section heading path | `core/article-context.js` already | time and topic ("Aftermath > 2015") |
| | Column/row headers for a citation in a table cell | `<th>` lookup | table claims, which are fragments by nature |
| **1: the footnote, free** | Citation metadata: title, work, author, date. Parsoid's `data-mw` carries the template parameters structured; the browser skin has COinS (`span.Z3988`) | the footnote `<li>` | which document the model should be reading; a basis for "is this even the cited source?" |
| | The citation template's `\|quote=` | the footnote | the editor's own evidence passage |
| | Page and sub-reference details | `pageNum` already | where to look in a long source |
| **2: fetcher change** | Source publication date, title, site (`article:published_time`, `og:*`, JSON-LD) | the CORS Worker and tf-source-fetcher would return a `meta` object next to the text: a change in two repos | relative dates ("Wednesday"); anachronism (a source older than the event can't support it) |
| **3: external, later** | Wikidata labels and aliases of linked entities | Wikidata | former names, transliterations. Identity only, never facts |

What stays out: the model's background knowledge; the text of the article's
other sources; and the text *after* the claim, which is rarely needed and
mostly invites scope creep.

## Architecture

1. **One context object, built in `core/`.** Production context comes from the
   DOM, where the claim's position is known exactly. Grow
   `core/article-context.js`, which already gets section and paragraph in one
   linear pass, into `buildClaimContext(citation, root)`, and add it to
   `scripts/sync-main.js`'s `CORE_ORDER` so the userscript, CLI, batch
   pipeline, web tool and severity pass all use the same builder. The
   severity prompt switches to it rather than keeping its own shape.

   ```
   { articleTitle, sectionTitle, precedingText,     // in formatClaimContext() now
     citationTitle,
     links: [{ text, target }], tableHeaders,       // tier 0, to add
     citation: { work, date, author, quote, page }, // tier 1, to add
     source: { publishedAt, title, site } }         // tier 2, filled in after the fetch
   ```

2. **Prompt.** `generateUserPrompt(claim, sourceInfo, context = null)`. The
   context block goes before the claim, followed by the rule. The **system
   prompt is not changed**: its few-shot examples are tuned against the
   benchmark. No context, null or an empty object gives exactly the v2 user
   prompt (pinned by a test), so `PROMPT_VERSION` keeps describing every
   existing finding. The block has its own `CONTEXT_PROMPT_VERSION`
   (hash-pinned). Wherever a finding stores `prompt_version`, a context check
   has to store both.

3. **Budget.** Preceding text is capped at 1,200 characters, cut at a
   sentence start. Next to a source of 3k–25k tokens, the whole block is a
   rounding error in cost.

4. **Provenance.** Every result records which context fields its prompt
   actually carried (`context_fields` per benchmark row; CSV columns and the
   Neon log later). A results file records its context, and the runner
   refuses to mix two contexts in one file. Benchmark extraction should pin
   the article `revid`, because context taken from live Wikipedia drifts.

5. **Published interface.** The new parameter is optional and additive, but
   `alex-o-748/citation-checker`'s hand-written `.d.ts` mirror needs it.

## Plan

1. **Experiment (built).** WiCE with and without context, plus the probe set,
   on our own dataset as well. WiCE ships each claim's preceding text
   (`claim_context`, which `wice.js` folds into `claim_container`), its
   section, and the fetched page's title. Its claims were also chosen to be
   non-trivial, so it needs no re-extraction.
2. If the experiment shows a gain without leakage: build tiers 0 and 1 in
   `core/`, sync them to `main.js`, and re-extract context for `dataset.json`
   at pinned revisions. The comparison that decides the default is **sentence
   scope with context vs paragraph scope without**.
3. Tier 2 (source metadata), in the Worker and tf-source-fetcher.
4. Make sentence scope the userscript default, if step 2 supports it.

### Running the experiment

```bash
cd benchmark
npm run wice:convert                                   # once
node context_probes.js build                           # -> dataset_wice_probes.json (gitignored)
P=--providers=hf-gpt-oss-20b; C=title,section,preceding,citation
node run_benchmark.js --dataset dataset_wice.json        --results results_wice_noctx.json  $P --context none
node run_benchmark.js --dataset dataset_wice.json        --results results_wice_ctx.json    $P --context $C
node run_benchmark.js --dataset dataset_wice_probes.json --results results_wice_probes.json $P --context $C
node context_probes.js analyze --probes results_wice_probes.json --base results_wice_ctx.json
npx ccs compare results_wice_noctx.json results_wice_ctx.json --dataset dataset_wice.json
```

### Probes

`context_probes.js` builds two kinds of synthetic row from the dataset, 60
each, drawn by a stable hash of the row id:

- **leak**: a row whose claim the source does *not* fully support, with the
  claim itself planted as the last sentence of the context. A flip from a flag
  to SUPPORTED means the model read the context as support. Planting the claim
  word for word is the bluntest possible leak, so a pass here is a floor, not
  a proof.
- **creep**: a SUPPORTED row with another article's claim planted in the
  context. A flip to a flag means the model checked the context.

Each flip is counted against the same model's verdict on the same row with
ordinary context, so only the planted sentence differs.

## Results

### First run: gpt-oss-20b, 2026-10-12

One model (`hf-gpt-oss-20b`, keyless HF path), `CONTEXT_PROMPT_VERSION` `c1`,
full context (`title,section,preceding,citation` on WiCE; `title,preceding` on
`dataset.json`, which has no section or citation title). The model samples,
so the no-context WiCE run was **repeated** to measure how much two identical
runs disagree. Every difference below should be read against that.

Raw results: `benchmark/results_wice_noctx.json`, `results_wice_noctx_rerun.json`,
`results_wice_ctx.json`, `results_wice_probes.json`, `results_ctx_baseline.json`,
`results_ctx.json`.

**WiCE, 701 rows valid in all three runs:**

| Run | Exact | Supported-vs-rest | FPR (flags on Supported rows) | TPR |
|---|---|---|---|---|
| No context | 56.8% | 83.6% | 27.1% (61/225) | 88.7% |
| No context, repeated | 55.8% | 85.3% | 23.6% (53/225) | 89.5% |
| **Context** | **53.5%** | **83.2%** | **31.1% (70/225)** | 89.9% |

- **Noise is large.** Two identical runs agree on only 80.3% of verdicts, and
  FPR moves 3.5 points between them. Context brings agreement down to 75.3%:
  it changes verdicts, but not in a useful direction.
- **Context leans toward flagging.** Of the 219 rows the first no-context run
  called Supported, the repeat flagged 9.6% and the context run 16.9%. That is
  the one difference clearly bigger than noise, and it is in the costly
  direction. The rationales behind those flips never mention the context.
  They are ordinary borderline strictness ("does not explicitly state that he
  was covering front lines"). So this is not visible scope creep. More likely
  the longer prompt, or the rule's "verify only the claim, using only the source
  text", makes the model stricter in general.
- **No gain where context should help most.** On the 203 WiCE claims that open
  with a pronoun or bare referent, or carry relative time ("a week later",
  "that evening"), Supported-vs-rest is 83.7% / 86.6% (the two no-context
  runs) against 82.8% with context. There are real individual wins: *"He was
  recalled by the Wizards a week later"* and *"Eleven days later, he…"* became
  checkable once the earlier date was in view, and *"It was her New York stage
  debut"* went from SOURCE UNAVAILABLE to a correct SUPPORTED. They don't add
  up to anything measurable. A likely reason: the model already assumes the
  referent is whoever the source is about, which is nearly always right, so a
  missing referent rarely costs it a verdict. Its errors are elsewhere.
- **`dataset.json`**: exact 62.9% → 60.0% (175 rows). On the 54 rows that got
  preceding text, 59.3% → 64.8%; on the 121 that got only the title, 64.5% →
  57.9%. A title alone shouldn't move accuracy by 6.6 points, so these
  splits are noise at this size, in both directions.

**Probes** (`node context_probes.js analyze`):

| Probe | Flipped | Background rate for the same flip |
|---|---|---|
| leak: claim planted in context | **5/56 (8.9%)** flag → SUPPORTED | 1.9% between the two no-context runs, 3.1% no-context → context |
| creep: unrelated claim planted | 0/36 (0%) SUPPORTED → flag | — |

Scope creep in the strict sense, verifying a planted sentence, doesn't happen.
The leak rate is several times the background, though from 5 rows. The five
rationales don't cite the context either: each is a borderline detail that
the model now waves through (*"a month before election day"* accepted for
*"three weeks before"*). This is the dangerous direction, and the rule
evidently doesn't fully prevent it.

### What this means

`c1` should not ship. Context as built here costs false flags and shows some
leakage, for no measurable gain on this model. That doesn't settle the
question. It narrows what to try next:

1. **A stronger model.** Referent resolution and following a "context is not
   evidence" rule are both things a 20B model may do badly. Run the same three
   WiCE runs and the probes on Sonnet before changing the prompt, since a
   prompt tuned to gpt-oss-20b's quirks may not transfer.
2. **Less context.** Ablate `--context title` and `--context title,section`
   against `preceding`. If the strictness shift comes from the preceding text,
   a title-only (and later, link-targets-only) block may keep the individual
   wins without it.
3. **Bigger probes.** `--per-type 150`, run twice, to tell whether the 8.9% is
   real.
4. **The question this run can't answer.** The case for context is sentence
   scope, and the current benchmark can't test it. Only 11 of its 80 Supported
   rows change at all when narrowed to the last sentence, and only 55 of 182
   rows have recoverable preceding text. Answering it needs step 2's DOM-based
   re-extraction (`claim_container` as stored loses the claim's exact position
   and the paragraph before).

## Alternatives considered

- **Rewrite the claim into a standalone sentence first** ("decontextualize",
  a separate model call that resolves "he" to "John Smith"). Cleaner input,
  but a second call per claim, and a rewrite error becomes a verdict error
  that nobody can see: the editor reads their own sentence, the model checked
  a different one. Worth revisiting if context in the prompt leaks.
- **Paragraph scope everywhere.** This is what gives context today, and its
  cost is the false NOT SUPPORTED that sentence scope was introduced to remove.
- **Put the context rule in the system prompt.** It would be a natural home,
  but it would change the v2 system prompt for every check, including those
  with no context, and force a full re-benchmark to learn what moved.
