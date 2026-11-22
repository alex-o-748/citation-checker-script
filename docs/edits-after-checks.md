# Do checks lead to edits?

`service/run-edit-followup.js` estimates how often a flagged citation gets
fixed after a check. It reads article histories instead of edit summaries.

## Why not count edit summaries

The Edit Section button prefills a summary that links the script page, and
`scripts/sweep_edits.py` (the daily `edit-log-sweep` workflow) logs every edit
that keeps it. Almost nobody does. On enwiki, 202 of the 222 article edits with
the summary by November 2026 were the maintainer's own, while Neon logged about
39,000 checks in the 60 days up to 2026-11-21. Experienced editors write their
own summaries, and the prefilled one ("source does not support claim") often
doesn't describe what they did. A summary count is a floor so far below the
real number that it says nothing about use.

## The method

Neon's `verification_logs` records, for every check, the article, the exact
`revision_id` checked, the time, the citation's source URL and the verdict.
Since 2026-09-23, every row carries `revision_id`.

1. **Runs.** Checks are grouped by article and checked revision. A citation
   checked twice in a run keeps its latest verdict.
2. **History.** Each checked revision is resolved to its page ID (50 per
   request), and the page's revisions are read from the checked one forward,
   to the last check plus the longest window. The lookup goes by revision ID,
   not title: Neon's `article_title` drops the namespace, and a title stops
   pointing at the page once it is moved or redirected. Only mainspace counts
   unless `--all-namespaces` is passed.
3. **Changes.** For each citation, the first human edit after the check that
   did one of the following, matched on the source URL:
   - **removed**: the URL occurs fewer times (dropped or replaced);
   - **tagged**: `{{failed verification}}`, `{{better source needed}}` or a
     similar tag appeared right after a ref holding the URL;
   - **claim**: the URL stayed, but the sentence its ref ends was reworded.
     Refs and maintenance tags are stripped before the sentence is cut out,
     so tagging or removing a neighbouring citation doesn't count. (The first
     version bounded the claim at the previous ref instead, so every removal
     of a flagged source also counted as a claim edit on the next citation,
     usually a Supported one, which inflated the baseline. Fixed 2026-11-22.)
4. **Baseline.** Supported citations from the same runs go through the same
   steps. Same article, same edits, same hours: an article that is busy anyway
   raises both rates, and only the verdict separates them. **The gap between
   flagged and Supported is the estimate.**

Reported at 1, 6, 24 and 48 hours (`--windows`). If the gap stops growing
after the first hour, editors act immediately. Source Unavailable is reported
separately, because dead links get fixed whatever the tool said.

## What it does not count

- **Bot edits.** Editors in the `bot` group are skipped, which removes
  InternetArchiveBot's dead-link repairs.
- **Edits before the run's first check.** They can't have been caused by it.
- **Citations whose URL isn't in the checked revision's wikitext.** These are
  counted as unmatched and left out of every rate, not guessed at. On the
  first sample, 3 of 124 citations were unmatched.
- **Group checks.** They have no single source URL.
- **Fixes that leave no trace in the three signals**, such as a rewording far
  from the ref. Every rate is a lower bound.

Neon stores no user, so who ran a check is unknown. The Supported baseline is
what makes that acceptable. `--exclude-editor <name>` drops runs in which that
editor edited after the check, which takes one person's own use out of the
numbers.

## Running it

Export the checks from Neon (the query is `EXPORT_SQL` in
`service/edit-followup.js`, and `--help` prints it):

```bash
psql "$DATABASE_URL" -c "\copy (<EXPORT_SQL>) TO 'checks.csv' CSV HEADER"
```

```bash
node service/run-edit-followup.js checks.csv --cache-dir .followup-cache --exclude-editor Alaexis
```

It writes `<out>.md`, `<out>.json` and `<out>-citations.csv` (one row per
citation, no usernames). The report's editor table lists the top 10 by edits
that changed a flagged citation; `--top-editors 0 --min-editor-edits 4` lists
everyone with at least 4. Its **Supported changed** column is the same
editor's changes to Supported citations in the same runs: when it is close to
the flagged count, the editor was rewriting the article, not acting on flags. With `--cache-dir`, a re-run with other windows or
filters only re-resolves revision IDs.

Run it from Toolforge or a laptop. Wikipedia rate-limits shared cloud IPs
hard: from a Claude Code cloud container even single requests got 429s, and
the 20-run sample needed retries. A full 60-day export is about 1,000 runs and
2,000 to 3,000 requests at the default 200 ms spacing.

## First sample (2026-11-22)

20 enwiki runs from 3 to 30 days earlier, picked by hash (each run had at least
one flagged and one Supported citation), 18 analyzed (2 were drafts or
sandboxes). Too few runs to quote a rate, but enough to check that the signals
pick up real fixes:

| Window | Flagged changed (any signal) | Supported changed | Gap |
|---|---|---|---|
| 1 h | 0 of 38 | 0 of 38 | 0 |
| 24 h | 4 of 38 | 0 of 38 | +10.5 pts |
| 48 h | 5 of 38 | 0 of 38 | +13.2 pts |

All five were claim edits, and on inspection each was a real fix:
*Justin Bieber* lost exactly the unsupported clause ("were both 18 when he was
born"), *Touhou Project* cut a review summary down to what the source says,
and three flagged claims in *Air Greenland Flight 3205* were rewritten. One
early false positive was fixed before these numbers: text written in front of
a ref that had no claim before it (an article growing around an infobox ref).
In this sample, no edit removed a flagged source or tagged it.
