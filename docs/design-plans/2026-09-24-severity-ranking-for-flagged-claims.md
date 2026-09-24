# Ranking flagged claims by severity

> **Status (2026-09-24):** In progress. Severity pass built behind `run-sweep.js --severity`: `core/severity.js`, `core/article-context.js`, `service/severity-assessor.js`. Not yet validated against human labels (step 5 below).

## The problem

Reviewing flagged claims, both Alaexis and Isaac Johnson landed on the same
reaction in a Slack thread (shared here 2026-09-23): *"technically it's not (fully) sourced, but it's
a minor detail and likely true."* Isaac's version: Partially-supported flags
are often trivial, a small missing piece that is easy to verify from links in
the cited source. He added that there is almost always *something* worth doing
anyway, like adding a citation, clarifying the text or tidying the reference.
His QA sheet's two yellow categories exist to capture that.

A flat list of flags spends volunteers' attention evenly. It should go to the
flags that matter most first. That calls for a ranking, not a better binary
verdict.

## What the first pass already gives, and what it doesn't

The verdict call returns `verdict`, `support_score` and, for NOT SUPPORTED
only, `reason_type` (`contradiction` / `omission`). Two gaps:

- **PARTIALLY SUPPORTED has no reason at all.** Nothing records *which* part
  failed or *how*, and that is the case Isaac calls often trivial.
- **Mixed failures collapse.** The prompt says "if both apply, use
  contradiction", so a claim with one contradicted and one missing part
  can't be told apart from a fully contradicted one.

Neither says whether the failing part matters to the sentence.

## Design

### A second, separate model call on flagged findings only

The verdict prompt stays untouched. Its few-shot examples are tuned against
the benchmark, so changing it would force a re-benchmark to learn what moved.
The severity pass is its own prompt with its own version
(`SEVERITY_PROMPT_VERSION`, hash-pinned in `tests/severity.test.js`) and runs
only on NOT SUPPORTED / PARTIALLY SUPPORTED. Cost scales with the flag rate.

The model splits the claim into subclaims and labels each one:

| Field | Values | Decided from |
|---|---|---|
| `status` | `supported` / `absent` / `contradicted` | **The source text only** |
| `central` | true / false | The claim, plus article title, section and paragraph |

**Categories, never scores.** LLMs calibrate badly on numbers and reasonably on
categories. A tier computed from observable labels can also be explained to a
volunteer ("a central fact is contradicted"); a model's 0.73 cannot.

**The model is never asked whether the claim is probably true.** The "likely
true anyway" judgement is the model's training prior, and trusting that prior
is how hallucinations get in. Verification exists so that it isn't trusted.

**The first-pass verdict is not shown to the second pass.** Shown a flag, the
model tends to find a failure to agree with it, and then the `disagreement`
tier (below) stops meaning anything.

### Context: article title, section, paragraph

The batch pipeline cuts claims down to one sentence (`claimScope: 'sentence'`),
so without context the model judges centrality blind. `core/article-context.js`
adds:

- **`sectionTitle`**: the heading path ("Career > Music"), or null for the lead.
  The lead matters on its own: lead sentences summarize the body and are often
  sourced there (WP:LEADCITE), so absence in the lead is often a
  citation-placement problem.
- **`paragraphText`**: the enclosing `<p>` (or list item / table cell), footnote
  markers stripped, capped at 2,000 characters.

**The paragraph is context for importance, not evidence.** Nearby sentences
carry their own citations. Without an explicit rule the model starts treating a
subclaim as supported because the paragraph says it elsewhere. The prompt says
so in as many words, and a test pins the wording.

Extraction is one pass over the document (`querySelectorAll` returns headings
and citation markers interleaved in document order). It is not a backwards
search per citation, which would be quadratic on the browser skin's flat
markup; the same trap `core/claim.js` documents. A test asserts per-citation
cost stays flat as the article grows 8×.

The module is kept out of `core/citations.js` and out of `scripts/sync-main.js`
because the userscript has no use for it yet.

### BLP: the one deterministic signal kept

`Category:Living people`, read from Parsoid's
`<link rel="mw:PageProp/Category">` elements in the article HTML the pipeline
already fetches. So a `--titles-file` run gets it with no Wiki Replicas query.
Reuses `WIKI_LIVING_PEOPLE_CATEGORIES` (enwiki only) and, like the picker,
returns **null rather than false** on any other wiki: "can't tell" is not "no".

Other deterministic features were considered and dropped as too noisy:
number/date regexes, quotation marks, contentious-word lists and claim-vs-source
figure matching. The last duplicates the contradiction/omission distinction the
model already makes.

### Tiers

`tierFor()` in `core/severity.js`, a pure function:

| Tier | Rule |
|---|---|
| `T1` | A central subclaim is contradicted |
| `T2` | A central subclaim is absent (from a source read in full), or a peripheral one is contradicted |
| `T3` | Only peripheral subclaims are absent: the "minor detail" case |
| `discounted` | Only absences, on a truncated source |
| `disagreement` | Every subclaim supported, contrary to the first pass: the likeliest false positives |

**Truncation discounts absence almost completely, and never discounts a
contradiction.** "The source doesn't mention it" means little when the source
was cut off at 12,000 characters: truncated benchmark rows falsely report
failure on 18.4% of calls. A contradiction survives truncation, because the
conflicting passage is in the part that was read. A NOT SUPPORTED + `omission`
finding on a truncated source is discounted without a model call.

This is softer than `cleanCsvText()`, which drops every truncated row from the
`-clean.csv`. That filter is unchanged; the severity columns are in both files
and the clean file simply has no truncated rows.

**Ordering** (`compareSeverity()`): tier, then BLP first within a tier, then
lower first-pass `support_score` first. BLP is an ordering key, not a tier
input. Whether BLP + central-absent should move up to T1 is open (WP:BLP says
remove *contentious* unsourced material, and contentiousness isn't measured).

### Output

CSV columns (not yet ToolsDB columns; `findings-store.js` is unchanged):
`is_blp`, `section_title`, `severity_tier`, `severity_subclaims` (JSON),
`severity_error`, `severity_prompt_version`. A finding the pass didn't run on
has them empty, so "unranked" never looks like "ranked lowest".

## Explicitly out of scope for now

- **Suggested actions** (remove / correct / rephrase / add citation / fix
  citation). Kept modular: a later module can read the subclaim labels. Two
  notes for whoever builds it:
  - About half can be derived from the tiers and the section with no model
    judgement.
  - The part that needs the model is "what does the source support instead"
    (for rephrase vs add citation).
  - Showing volunteers "remove" is risky. Showing the evidence leaves the
    decision with the editor.
- **Traditional ML** (NLI models, a learned ranker). Mostly redoes what the LLM
  already does, and there aren't enough labels to fit anything.
- **The userscript.** Nothing here reaches `main.js`.

## Next steps

1. **Validate on human labels.** Run the pass over findings that Isaac's QA
   sheet has labelled, and check whether tier separates red from the two
   yellows **better than sorting by `support_score` alone**. If it doesn't, the
   second call isn't earning its cost. This needs a small runner that re-reads
   a findings CSV, re-fetches each article at its `revision_id` and the
   source, and runs only the severity pass. Not built yet.
2. Report how often `disagreement` fires. A high rate is a finding about
   first-pass precision in its own right.
3. Decide the BLP question above once the labelled data exists.
