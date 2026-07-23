# Brief: Source Verifier edit log sweep

## Goal

Build an automated daily job that finds Wikipedia edits made with the Source Verifier
userscript and appends them to a committed, analysable log.

Edits made via the tool have a prefilled edit summary containing the substring
`Source Verifier` (full form: `checked with [[User:Alaexis/AI Source Verification|Source Verifier]]`).
The MediaWiki API cannot filter by edit summary content, so the job must fetch recent
changes in bulk and filter client-side.

## Deliverables

1. `scripts/sweep_edits.py` — the sweep script
2. `.github/workflows/edit-log-sweep.yml` — daily GitHub Actions workflow
3. `data/edit-log.ndjson` — append-only log (created on first run)
4. `data/README.md` — short description of the schema, for anyone using the dataset

## Script requirements

### Input / configuration

Read from environment variables, with sensible defaults:

| Var | Default | Meaning |
|---|---|---|
| `SV_WIKIS` | `en.wikipedia.org` | Comma-separated list of wiki hosts to sweep |
| `SV_MATCH` | `Source Verifier` | Substring to match in the edit summary |
| `SV_LOOKBACK_HOURS` | `48` | How far back to sweep |
| `SV_LOG_PATH` | `data/edit-log.ndjson` | Output file |

The 48-hour lookback with a daily schedule is deliberate: runs overlap, so a failed or
skipped run self-heals on the next day rather than leaving a permanent hole. This makes
deduplication mandatory, not optional.

Make `SV_WIKIS` a list from the start even though only enwiki matters today — ruwiki
deployment is planned and retrofitting multi-wiki support later is more work than
accommodating it now.

### API access

Endpoint: `https://{wiki}/w/api.php`

```
action=query
format=json
formatversion=2
list=recentchanges
rctype=edit|new
rclimit=500
rcprop=title|ids|timestamp|user|comment|sizes|flags
rcstart={now}          # newer bound — results come newest-first
rcend={now - lookback} # older bound
```

Notes:

- `formatversion=2` gives cleaner JSON — use it.
- `rclimit=500` is the ceiling for non-bot clients. Do not raise it.
- Paginate on the `continue.rccontinue` value returned in each response; pass it back
  verbatim on the next request. Stop when `continue` is absent.
- Include `rctype=new` alongside `edit` so page creations made via the tool aren't missed.
- Set a descriptive `User-Agent` header identifying the tool and a contact address —
  this is required by the Wikimedia API etiquette policy and requests may be throttled
  or refused without it.
- Filter on the comment field case-insensitively. Some users retype the summary by hand.

### Rate limiting and robustness

- Sleep ~100ms between paginated requests. At ~150k edits/day on enwiki a 48h sweep is
  roughly 600 requests; this keeps the job well-behaved and still finishes in minutes.
- Retry on HTTP 429 and 5xx with exponential backoff, at least 3 attempts.
- If one wiki in `SV_WIKIS` fails entirely, log the error, continue with the others,
  and exit non-zero at the end so the failure is visible — but only after the other
  wikis have been written. A partial success must not lose the data it did collect.

### Output format

NDJSON, one edit per line, appended chronologically. Fields:

```json
{
  "wiki": "en.wikipedia.org",
  "revid": 1234567890,
  "old_revid": 1234567889,
  "pageid": 12345,
  "title": "Example article",
  "user": "Someone",
  "timestamp": "2026-07-22T14:03:11Z",
  "comment": "checked with [[User:Alaexis/AI Source Verification|Source Verifier]]",
  "size_delta": -142,
  "is_new_page": false,
  "is_minor": false,
  "first_seen": "2026-07-23T02:00:04Z"
}
```

`size_delta` is `newlen - oldlen`. `first_seen` is the sweep timestamp, kept so that
late-arriving records are distinguishable from the edit time itself.

### Deduplication

Key on `(wiki, revid)`. On startup, read the existing log and build a set of keys already
present; skip any match already recorded. Revision IDs are immutable and unique per wiki,
so this is exact — no fuzzy matching needed.

Keep the log sorted by edit timestamp on write. Appending out-of-order records and sorting
the whole file each run is acceptable at this scale (thousands of rows, not millions) and
keeps diffs readable.

### Output when run

Print a one-line summary to stdout: wikis swept, window covered, matches found, new
records appended. The workflow surfaces this in the Actions log, which is the quickest
way to confirm the job is alive without opening the data file.

## Known limitation to document in `data/README.md`

Users can edit or delete the prefilled summary before saving. Counts derived from this log
are therefore a **lower bound** on tool-assisted edits, not a complete census. Say so
plainly in the README — anyone doing analysis on this dataset needs to know, and it is the
main argument for eventually adding a proper change tag.

## Out of scope

Do not build analysis, charts, or aggregation. The log is the deliverable; analysis
happens separately against the NDJSON.
