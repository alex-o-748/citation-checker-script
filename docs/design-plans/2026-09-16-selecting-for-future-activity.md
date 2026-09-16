# Selecting articles for future activity, not past activity

> **Status (2026-09-16):** Implemented. `service/pilot-selection.js`, `service/article-picker.js`, `service/run-pick-pilot.js`.

## The problem

The batch pilot picked articles by recent edit velocity, with the two largest
boosts going to a recently created page and to editing concentrated in a burst
(`recencyBoost` 45, `burstBoost` 45). That was a deliberate bias toward current
events, on the reasoning that a developing story accumulates citations fast and
nobody has checked them yet.

The reasoning is fine. The measurement is backwards.

**Every one of those signals is a record of the past, and the batch is consumed
in the future.** Selection, volunteer review and delivery into suggestion mode
take days to weeks. An article chosen *because* it was spiking is, by the time a
suggestion reaches an editor, an article nobody is working on. The suggestion
lands on a page with no audience.

Sports events are the clearest case and the one raised directly after the
2026-09-14 volunteer call: a tournament final takes several hundred edits over
three days and then effectively none, ever again. Elections, disasters, awards
ceremonies and recent deaths share the shape. All of them topped the old
ranking — a bracket page is newly created, almost entirely bursty and densely
web-sourced, which is a clean sweep of every signal that mattered.

The `--table-ratio-max` filter (added after the first real run returned six 2026
US Open draw pages) treated a symptom. It excludes pages whose citations sit in
results tables, which is most tournament pages but not the prose ones — a match
report, an obituary, an election-night article all pass it and are just as dead
a month later.

## What replaces it

The signals barely change. The signs do.

| Signal | Was | Is |
| --- | --- | --- |
| Recently created | `+45` | `-35` (novelty penalty) |
| Edit burst | `+45` | `-45` (burst penalty) |
| `{{current}}` and siblings | `+40` | `-40` |
| Edit count in window | `+12·log2` of the raw count | `+12·log2` of the count **with the burst window's edits removed** |
| Months of the history window with any edit | — | `+50` (**persistence**, the largest single term) |
| Distinct editors in that window | — | `+25`, saturating at 30 |
| `{{failed verification}}` | `+35` | `+35`, unchanged |
| Offline citation ratio | `-60 ·` ratio | unchanged |

Plus two hard filters, applied **before** an article fetch is spent:

- **`--min-active-buckets`** (default 3 of 6 months). An article edited in fewer
  than three distinct months of the last six is rejected. An article with *no*
  measured history in the window is rejected too — that is a page younger than
  the window, which is the new-event case, and a missing measurement must never
  read as a good one.
- **event-shaped titles** (`--allow-event-titles` to disable). A year-anchored
  title — `2026 US Open`, `2025-26 Premier League`, `Athletics at the 2026
  Summer Olympics`, `Deaths in September 2026`.

### Why persistence rather than a longer window

A longer edit-count window does not separate the two populations: 400 edits in
one month and 400 spread across six are the same number. What distinguishes them
is *people coming back*, so the measure is how many distinct buckets saw any
edit at all, not how many edits each holds.

### Why the title filter exists as well

Persistence alone cannot catch a **forthcoming** event. An article about a World
Cup six months out is edited steadily every month of the run-up and looks
exactly like a durable page — right up until the event happens and the editing
stops for good. The title is the only cheap signal that sees it coming.

The patterns are deliberately small and every one is anchored on a four-digit
year. That anchor is what makes them safe: `2026 US Open` is an occasion, `US
Open` is a subject, and only the first matches. A lookahead excludes works
*titled* with a year (`1984 (novel)`, `1917 (2019 film)`), where a parenthesized
disambiguator follows. If the list ever needs to grow, it should grow with more
year-anchored patterns and not with bare topic vocabulary — `cup`, `final`,
`season` and `championship` would take out `Stanley Cup` and `Monsoon season`
with them.

## Cost

The history profile is measured **per candidate page id**, not as a second
aggregate over the revision table: `buildActivityProfileQuery()` runs one
conditional `SUM` per bucket over each page's own `(rev_page, rev_timestamp)`
index range, chunked 500 ids at a time, alongside the creation-date and
tag-membership queries that already worked this way. Adding it costs one bounded
query per chunk.

The base-pool window widened from 14 to 30 days and the pool from 1,000 to
2,000. That is the one real cost increase — a longer range scan of `revision` —
and it is there because a 14-day top-1,000 is dominated by whatever spiked, so
steadily edited articles never entered the pool to be re-ranked. Both stay
tunable, and the job runs on the `.analytics.` replica cluster, which is sized
for exactly this shape of query.

## What this does not fix

- **The pool is still "articles edited recently."** An article edited twice a
  month, every month, for ten years is a better bet than most of what gets
  selected and will not make a top-2,000 cut. Fixing that needs a different base
  query (page views, watchers, or a WikiProject-assessment join) rather than a
  different ranking of this one.
- **Persistence is a proxy, not a prediction.** Nothing here models *why* an
  article is edited. A page can be persistently edited by one bot and a
  vandalism reverter; editor breadth is a partial guard, and bot edits are not
  excluded (that needs an `actor`/`user_groups` join this deliberately skips).
- **It is unvalidated against outcomes.** The claim "these articles will still
  be edited next month" is testable — pick a batch, wait, count — and has not
  been tested. Until then the change rests on the argument, not on a measurement.

## Alternatives considered

- **Page views instead of edits.** A better audience proxy, but views live in
  the Pageviews API / dumps rather than in Wiki Replicas, which would add a
  second data source and a second failure mode to stage 1. Worth revisiting if
  the persistence proxy underperforms.
- **`page_assessments` (WikiProject class and importance).** Available on enwiki
  replicas, and it maps neatly onto the two themes named on the volunteer call —
  quality work (GA/FA/DYK) and cleanup. Not taken here because it is enwiki-only
  and answers a different question ("is this article important?" rather than "is
  anyone working on it?"). The strongest candidate for the next iteration.
- **A topic blacklist by category.** Rejected: category names are inconsistent,
  the membership query is expensive, and it addresses sports specifically rather
  than the general class of one-shot pages. The persistence filter covers the
  class.
- **Keeping the current-events bias behind a flag.** Not added. Nothing now asks
  for it, and a flag whose only effect is to reintroduce a known defect is worse
  than the two tunable knobs (`--min-active-buckets 0`, `--allow-event-titles`)
  that already let a caller take the filters off.

## Provenance

The failure mode was raised following the 2026-09-14 Discord volunteer call, in
which WMF committed to proposing the ~1,000-article list to volunteers and
sharing how it was generated *before* generating the batch. That commitment is
why `run-pick-pilot.js` now reports its funnel by rejection reason — how many
candidates were dropped for an event title, for thin history, for unfetchable
sources, for table-bound citations — rather than only a final count.

Article-selection input from that call, recorded for the next iteration: two
themes, **quality work** (DYK, GA, FA) and **cleanup** (articles tagged for AI
cleanup, unreviewed contentious topics, BLPs tagged for AI cleanup), plus BLPs,
recent deaths, AFC and new-page patrol. The recurring answer from more than one
participant was that source verification is hard to confine to a subset because
it is everywhere in the workflow. None of that is addressed here — this change
is only about not wasting slots on articles nobody will return to.
