# Edit log dataset

`edit-log.ndjson` is an append-only log of Wikipedia edits made with the
[Source Verifier](https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification)
userscript. It is produced by `scripts/sweep_edits.py`, run daily by the
`.github/workflows/edit-log-sweep.yml` GitHub Actions workflow.

Edits made through the tool carry a prefilled edit summary containing the
substring `Source Verifier` (full form:
`checked with [[User:Alaexis/AI Source Verification|Source Verifier]]`). The
MediaWiki API cannot filter recent changes by summary content, so the sweep
fetches recent changes in bulk and matches the summary client-side
(case-insensitively, since some editors retype the summary by hand).

## Format

NDJSON — one JSON object per line, sorted by edit `timestamp`. Each line is one
edit:

| Field | Type | Meaning |
|---|---|---|
| `wiki` | string | Wiki host the edit was made on, e.g. `en.wikipedia.org` |
| `revid` | int | Revision ID of the edit (immutable, unique per wiki) |
| `old_revid` | int \| null | Revision ID this edit was based on (`0` for page creations) |
| `pageid` | int | Page ID of the edited page |
| `title` | string | Page title at the time of the edit |
| `user` | string | Username (or IP) that made the edit |
| `timestamp` | string | Edit time, ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`) |
| `comment` | string | The edit summary that matched |
| `size_delta` | int \| null | `newlen - oldlen` in bytes (`null` if sizes were unavailable) |
| `is_new_page` | bool | Whether the edit created a new page |
| `is_minor` | bool | Whether the edit was flagged minor |
| `first_seen` | string | Sweep timestamp when this record was logged, ISO 8601 UTC |

`first_seen` is kept separately from `timestamp` so that late-arriving records
(picked up by a later sweep) are distinguishable from the edit time itself.

## Deduplication

Records are keyed on `(wiki, revid)`. The daily job uses a 48-hour lookback
window so consecutive runs overlap and a missed run self-heals on the next day;
deduplication on `(wiki, revid)` keeps that overlap from producing duplicate
rows. Revision IDs are immutable and unique per wiki, so the match is exact.

## Known limitation — this is a lower bound, not a census

The prefilled edit summary can be edited or deleted by the user before saving.
Any edit where the summary was changed to no longer contain `Source Verifier`
will not appear in this log, even though it was made with the tool. **Counts
derived from this dataset are therefore a lower bound on tool-assisted edits,
not a complete count.** A proper MediaWiki
[change tag](https://www.mediawiki.org/wiki/Manual:Tags) would be needed for a
complete census; adding one is the main follow-up this limitation argues for.
