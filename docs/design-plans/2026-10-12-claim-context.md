# Giving the verifier the claim's context

> **Status (2026-10-12):** In progress. Step 1 (the experiment) is built: `formatClaimContext()` in `core/prompts.js`, `benchmark/claim_context.js`, `benchmark/context_probes.js`, `run_benchmark.js --context`. First results below. Steps 2–4 are not started.

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

_To be filled in from the first run._

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
