# Ranking flagged claims by severity

> **Status (2026-09-24):** In progress. Severity pass built behind `run-sweep.js --severity`: `core/severity.js`, `core/article-context.js`, `service/severity-assessor.js`. Not yet validated against human labels (step 5 below).
>
> **2026-10-22:** Also in the userscript, behind an off-by-default setting. See "In the userscript" below.

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

This is the same principle `cleanCsvText()` applies to the `-clean.csv` (since
2026-09-25). On a truncated source it keeps only SUPPORTED and NOT SUPPORTED /
contradiction rows, and (since 2026-10-30) it drops a group's PARTIALLY
SUPPORTED and NOT SUPPORTED / omission rows when one of the group's sources is
SOURCE UNAVAILABLE, the cleaner's counterpart of `unreadSources`. The two differ in one case: a truncated **PARTIALLY
SUPPORTED** finding whose second pass found a contradiction. It is tiered T1 or
T2 here, and the cleaner still drops it, because the cleaner only reads the
first-pass verdict. Making the cleaner keep such rows by `severity_tier` would
close the gap. It is left open until the tiers are validated.

**Ordering** (`compareSeverity()`): tier, then BLP first within a tier, then
lower first-pass `support_score` first. BLP is an ordering key, not a tier
input. Whether BLP + central-absent should move up to T1 is open (WP:BLP says
remove *contentious* unsourced material, and contentiousness isn't measured).

### Output

CSV columns (not yet ToolsDB columns; `findings-store.js` is unchanged):
`is_blp`, `section_title`, `severity_tier`, `severity_subclaims` (JSON),
`severity_error`, `severity_prompt_version`. A finding the pass didn't run on
has them empty, so "unranked" never looks like "ranked lowest".

**Failures** follow the sweep's policy for verdict calls
(`--max-consecutive-failures`). The verdict is already paid for, so it is
always recorded; a failed severity pass only leaves the finding unranked:

- A transient error that outlasts its retries sets `severity_error` to
  `retries_exhausted`, and the sweep continues.
- An auth/billing or non-transient error sets it to `halted`, and the run stops
  after this finding.

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
- ~~**The userscript.**~~ Added 2026-10-22; see below.

## In the userscript (2026-10-22)

The "Rank problems by severity" setting, off by default: it adds a model call
per flagged citation. The pass itself is shared, not re-implemented:
`runSeverityPass()` in `core/severity.js` is the sequence (no-call shortcuts,
call, parse, tier), and `core/severity.js` and `core/article-context.js` are
now inlined into `main.js`. The batch's `assessSeverity()` keeps only its
error policy (halt on a spent key); the userscript's turns any failure into an
"unranked" badge.

**Severity changes the order of the report, never what it shows.** The
question was whether to filter or reorder. Reordering, because:

- The tiers are unvalidated (step 1 below). A filter would hide a flag on the
  strength of an unvalidated label; a sort only moves it down a list the editor
  still sees in full. A wrong T3 costs a scroll, not a missed problem.
- One article is a short list. The batch needs ranking to spread volunteer
  attention across thousands of findings; an editor in one article reads all of
  them anyway. What helps more is knowing *what* failed, so each card lists its
  contradicted and missing subclaims.
- Article order is how an editor works through a page section by section, and
  the verdict filters already cut the list down by verdict.

So: every flagged card gets a badge naming the finding, document order stays
the default, and "Most serious first" is a sort toggle in the report summary
(remembered per browser). T2 is split into two labels by its subclaims,
"Detail contradicted" and "Key fact not in source", since it covers both.

**Ranking runs after every verdict is in**, as a second phase of Verify All,
so verdicts arrive as fast as without it and cards never reorder while being
read; the sort applies once, at the end. Only report units are ranked: a group
with a combined verdict is ranked on that, not on its per-source rows.

**A source in the group that couldn't be fetched discounts like truncation**
(2026-10-23, both front ends). An adjacent-citation group cites several sources
for one claim. When one of them could not be fetched, a subclaim missing from
the ones that were read may be in the one nobody read: the truncation argument
one level up. `tierFor()` takes `unreadSources` and treats it exactly as
`sourceTruncated` (absence discounted, contradiction kept), and the no-call
shortcut for a pure omission applies to it too. It covers the group's combined
finding (the collective prompt already labels the dead source "could not be
retrieved") and each member judged on its own source: a member whose combined
check was skipped in the userscript, and every member's own row in the batch.
The userscript words the badge apart from truncation: "Unclear: not every
cited source was read". The CSV tier is `discounted` either way.

Deliberately **not** discounted: the single-citation view, which checks only
the clicked citation and never fetches the rest of its group. The editor
clicked one citation and knows that is all they are checking, so siblings left
unfetched there are not "unread" in this sense (decided 2026-10-23). The same
goes for a batch member's own row whose siblings were read fine: only a source
that could not be fetched at all discounts.

Not yet: tiers in the wikitext/plain-text exports (nothing unvalidated goes on
a talk page) or in the worker log. Logging the tier with the check id is the
cheapest route to step 1, since editors' Yes/No ratings would then label tiers
for free, but it needs the Worker (`alex-o-748/public-ai-proxy`) to accept the
new fields first.

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
