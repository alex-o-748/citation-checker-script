# Batch files

The batches whose flagged rows were delivered to Suggestion Mode
(`llmSourceVerification`) are kept as files, not only as Google Sheets.

## Where

- **Files:** branch `data/batches`, one gzipped CSV per batch, with
  `MANIFEST.txt` (original bastion path, size and modification time) and
  `SHA256SUMS` beside them. The branch holds data only and is never merged:

  ```bash
  git fetch origin data/batches && git worktree add ../batches origin/data/batches
  ```

- **Index:** `analysis/batches.json`. For each batch it records:
  - `batch_id` and `wiki`;
  - `file`: the name on the bastion and on the branch, without `.gz`;
  - `uploaded_as`: the name it was given in Google Drive;
  - `generated_at`: the file's modification time on the bastion;
  - `rows`, and `sha256` of the uncompressed CSV;
  - `live_from` / `live_until`: the window in which its flagged rows were
    shown.

  Set `live_until` when a batch is replaced. Analyses count only edits made
  while a batch was live.

| Batch | Wiki | Rows | Generated | Live from (UTC) |
|---|---|---|---|---|
| en-evergreen-500 | enwiki | 80,756 | 1 Nov 2026 | 5 Nov 00:33 |
| batch3-evergreen | enwiki | 13,896 | 1 Nov 2026 | 5 Nov 00:33 |
| isaac-400 | enwiki | 26,002 | 30 Oct 2026 | 5 Nov 00:33 |
| ru-batch2 | ruwiki | 11,758 | 2 Nov 2026 | 5 Nov 10:58 |
| ru-batch3 | ruwiki | 29,190 | 2 Nov 2026 | 5 Nov 10:58 |
| ru-batch4 | ruwiki | 32,917 | 2 Nov 2026 | 5 Nov 10:58 |
| ru-batch5 | ruwiki | 10,650 | 2 Nov 2026 | 5 Nov 10:58 |

No page appears in more than one batch of the same wiki.

## What the files are

Each file is the `-clean` output of `service/run-sweep.js`, re-cleaned with the
cleaner of 30 Oct 2026 (`service/clean-csv.js`). That cleaner adds the rule
dropping a group's PARTIALLY SUPPORTED and omission rows when one of its
sources was unread. These exact files were uploaded; the sizes match the Drive
copies byte for byte.

## Columns

One row per checked citation, or per adjacent-citation group for collective
rows. These are the columns `service/csv-report.js` writes. The enwiki files
lack the six marked †, because those batches predate them.

| Column | Meaning |
|---|---|
| `page_title`, `page_id` | The article. `page_id` survives renames; use it to join |
| `revision_id` | The revision the claim was checked against |
| `permalink` | Link to that revision |
| `citation_number` | The footnote number as displayed. On a collective row, the members' numbers joined by `, `. Display only, not an identifier |
| `ref_name` | `<ref name=…>` of the footnote, if it has one |
| `is_collective` | 1 for a group's combined verdict over all its sources |
| `group_id` | HTML id of the group's first citation marker (`cite_ref-…`). Meaningful only within one revision |
| `claim_text` | The text the citation supports, from the rendered page with footnotes removed. In batch runs, the last sentence before the citation |
| `source_url` | The cited URL. On a collective row, the members' URLs, sorted and newline-separated |
| `verdict` | SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED, SOURCE UNAVAILABLE, SKIPPED or ERROR. The flagged ones, shown in Suggestion Mode, are PARTIALLY SUPPORTED and NOT SUPPORTED |
| `support_score` | The model's support score |
| `reason_type` | Why: `omission` / `contradiction` for NOT SUPPORTED; `no_url`, `fetch_failed`, … for SOURCE UNAVAILABLE; `claim_too_short` for SKIPPED; `retries_exhausted`, … for ERROR |
| `rationale` | The model's explanation, in the wiki's language |
| `source_quote`, `quote_status` | The passage the model cited, and whether it was found verbatim in the source (see `core/quote.js`) |
| `fetch_status`, `fetch_error` | The source fetch's HTTP status, and its error when there was no content |
| `source_truncated` | 1 if the source text stopped at a fetch cap |
| `provider`, `model`, `prompt_version` | What produced the verdict. Empty when no model ran |
| `tokens_in`, `tokens_out` | Model usage |
| `published` | Always 0. The pipeline never set it, and it says nothing about Suggestion Mode |
| `is_blp` † | 1 if the article is in Category:Living people. Empty where that can't be determined |
| `section_title` † | The section the claim is in |
| `severity_tier`, `severity_subclaims`, `severity_error`, `severity_prompt_version` † | The severity pass on flagged rows (`core/severity.js`), when it ran |
| `check_id` | A random id minted for the row at generation. Unique within the file, and the way to quote a row |

The file has no `wiki` column: the wiki is the batch's, from
`analysis/batches.json`, and is also the permalink's host.
