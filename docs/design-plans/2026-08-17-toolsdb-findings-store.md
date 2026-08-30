# ToolsDB findings-store write path

> **Status (2026-08-20):** Bootstrapped. `service/findings.js` is implemented and tested; the ToolsDB database (`s57953__source_verifier`) and `citation_findings` table have been created and hand-verified on the bastion (see "Definition of done" below). Original brief was for the storage stage of `2026-08-07-batch-source-checks-for-edit-suggestions.md` (§6) and the identity work in `2026-08-10-track-c-orchestration-extraction.md` (branch 5, now built as `core/anchor.js`).
>
> **Renamed 2026-08-24** (`2026-08-24-csv-deliverable-and-component-names.md`): `service/findings.js` → `service/findings-store.js`, `service/selection.js` → `service/article-picker.js`. Body below is left as drafted and refers to the old names.

## What you're building, and where

A write path for `citation_findings` — the table that stores per-citation
verification results so they can later be served as Wikipedia "edit
suggestions." This is the storage stage of a larger batch pipeline; read
`docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md`
(§2, §6) for the full rationale before writing code.

**Important scope correction, unlike other pieces you may have seen briefed
this way:** this is **not** a separate Toolforge tool or a separate repo.
`llm-router` and `source-fetcher` are standalone HTTP services because they
have no code dependency on this repo. This module does — it needs
`core/anchor.js`'s hashing functions directly, and it must agree byte-for-byte
with the rest of the batch pipeline on how a finding's identity is computed.
Build this as `service/findings.js` in the `citation-checker-script` repo,
following the exact pattern already established by `service/replicas.js` and
`service/selection.js` in that repo: pure, offline-testable query
construction in one function, a thin untestable-here I/O wrapper in another.
Read both of those files before starting — they are the reference
implementation for the pattern you're extending.

## The database: ToolsDB, not Wiki Replicas

Two different systems live behind similar-sounding names, and `service/`
already talks to one of them:

| | Wiki Replicas (`service/replicas.js`, already built) | ToolsDB (what you're building) |
| --- | --- | --- |
| Purpose | Read-only mirror of Wikipedia's production DB | Your tool's own writable database |
| Host | `<wikidb>.analytics.db.svc.wikimedia.cloud` | `tools.db.svc.wikimedia.cloud` |
| Database name | `<wikidb>_p`, e.g. `enwiki_p` | `<credentialUser>__<name>`, e.g. `s51234__source_verifier` |
| Credentials | `~/replica.my.cnf` | **The same file** — reuse it |

That last row matters: `service/replicas.js` already has `parseReplicaConfig()`,
which reads `~/replica.my.cnf` and returns `{ user, password }`. **Reuse that
function** rather than re-parsing the file — it's already tested, and the
`user` value it returns is literally the `<credentialUser>` you need for the
ToolsDB database name (something like `s51234`, not your tool's name).

## Bootstrap the database and table by hand first

This repo has a strong, working precedent for this exact situation
(`service/selection.js`'s Wiki Replicas query was hand-verified via the
`mariadb` CLI before any connection code was written around it — see that
file's commit history if you want the reasoning). Do the same here: confirm
the schema works against the real database before writing code that assumes
it does.

On the Toolforge bastion, inside the tool account:

```bash
mariadb --defaults-file=~/replica.my.cnf -h tools.db.svc.wikimedia.cloud
```

Find your credential user (needed for the database name) — it's the `user =`
line in `~/replica.my.cnf`. **Confirmed 2026-08-20: `<credentialUser>` is
`s57953`** — the database is `s57953__source_verifier`. Substituting that
value for `<credentialUser>` below:

```sql
CREATE DATABASE IF NOT EXISTS `<credentialUser>__source_verifier`;
USE `<credentialUser>__source_verifier`;

CREATE TABLE citation_findings (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  wiki             VARBINARY(32)  NOT NULL,
  page_id          INT UNSIGNED   NOT NULL,
  page_title       VARBINARY(255) NOT NULL,
  revision_id      BIGINT UNSIGNED NOT NULL,
  claim_hash       BINARY(32)     NOT NULL,
  claim_text       TEXT           NOT NULL,
  citation_number  INT,
  ref_name         VARBINARY(255),
  source_url       TEXT,
  source_url_hash  BINARY(32)     NOT NULL,
  fetched_at       TIMESTAMP      NULL,
  group_id         VARBINARY(64),
  is_collective    TINYINT(1)     NOT NULL DEFAULT 0,
  verdict          VARBINARY(32)  NOT NULL,
  confidence       TINYINT UNSIGNED,
  reason_type      VARBINARY(16),
  rationale        TEXT,
  provider         VARBINARY(32),
  model            VARBINARY(128),
  prompt_version   VARBINARY(32)  NOT NULL,
  fetch_status     SMALLINT,
  source_truncated TINYINT(1)     NOT NULL DEFAULT 0,
  tokens_in        INT,
  tokens_out       INT,
  created_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at       TIMESTAMP      NULL,
  published        TINYINT(1)     NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_finding (wiki, page_id, claim_hash, source_url_hash, provider, prompt_version),
  KEY idx_lookup (wiki, page_id, published),
  KEY idx_expiry (expires_at)
);
```

This is the schema as corrected in
`docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md`
§6 — copy it verbatim rather than re-typing from memory or from an older
copy of that doc; an earlier draft used a content hash (`source_hash`)
instead of `source_url_hash`, which was deliberately replaced because
hashing fetched content is brittle (dynamic page elements change the hash
between two fetches of the same source). If you see `source_hash` anywhere,
it's stale — check which branch you're reading it from before trusting it;
as of this writing `main` itself still carries the stale version, and only
the `claude/source-checks-edit-suggestions-qxj6nk` branch (PR #285) has the
correction. If that PR has since merged, this caveat no longer applies.

Insert one row by hand with plausible values, confirm it lands, confirm a
second insert with the same identity fields (`wiki`, `page_id`, `claim_hash`,
`source_url_hash`, `provider`, `prompt_version`) collides on the unique key
as expected rather than duplicating. Only once that's confirmed, move on to
writing `service/findings.js`.

## The write function

Mirror `service/selection.js`'s split exactly: a pure function that builds
SQL + params (testable without a database), and a thin wrapper that runs it
(not meaningfully testable here, keep it small).

```js
// service/findings.js
import { claimHash, sourceUrlHash } from '../core/anchor.js';

export function buildUpsertQuery(finding) {
    // returns { sql, params }
}

export async function upsertFinding(query, finding) {
    // query: injected (sql, params) => result function, same shape
    // selectCandidates() already uses — see service/selection.js.
}
```

`buildUpsertQuery` should compute `claim_hash` and `source_url_hash`
internally by calling `claimHash(finding.claimText)` and
`sourceUrlHash(finding.sourceUrl)` — **do not** make the caller compute
these and pass them in. The whole point of centralizing that logic in
`core/anchor.js` is that nobody outside it needs to know how the hash is
derived; every caller just supplies the plain text and URL.

### MariaDB upsert syntax — not the same as the Postgres schema elsewhere in this repo

`docs/worker-logging-reference.md` documents a *different*, Postgres-backed
table (`verification_logs`, on Neon) that this repo also has code for. That
one is irrelevant here — don't copy patterns from it. MariaDB does not have
`ON CONFLICT`; the equivalent is:

```sql
INSERT INTO citation_findings (
  wiki, page_id, page_title, revision_id,
  claim_hash, claim_text, citation_number, ref_name,
  source_url, source_url_hash, fetched_at,
  group_id, is_collective,
  verdict, confidence, reason_type, rationale,
  provider, model, prompt_version,
  fetch_status, source_truncated, tokens_in, tokens_out,
  expires_at, published
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  page_title = VALUES(page_title),
  revision_id = VALUES(revision_id),
  claim_text = VALUES(claim_text),
  citation_number = VALUES(citation_number),
  ref_name = VALUES(ref_name),
  source_url = VALUES(source_url),
  fetched_at = VALUES(fetched_at),
  group_id = VALUES(group_id),
  is_collective = VALUES(is_collective),
  verdict = VALUES(verdict),
  confidence = VALUES(confidence),
  reason_type = VALUES(reason_type),
  rationale = VALUES(rationale),
  provider = VALUES(provider),
  model = VALUES(model),
  fetch_status = VALUES(fetch_status),
  source_truncated = VALUES(source_truncated),
  tokens_in = VALUES(tokens_in),
  tokens_out = VALUES(tokens_out),
  expires_at = VALUES(expires_at),
  published = VALUES(published)
```

Note `created_at` is absent from the `UPDATE` clause deliberately — a column
not mentioned there is simply left untouched, which is what you want: a
re-crawled finding keeps its original first-seen timestamp, not the latest
re-crawl time.

Note also `prompt_version` is absent from the `UPDATE` clause **and cannot be
otherwise**: it's part of the unique key. A finding re-computed under a
different prompt version doesn't update the old row — it can't, the key
doesn't match — it inserts a *new* row alongside the old one. This is
intentional, not a gap to fix: it's how "invalidate findings when prompts
change" (the design doc's phrase for this column) actually works in
practice. The old row stays queryable (for audit, for detecting what
changed) while the `published` flag and the read-path's own logic decide
which prompt version's findings are current.

## Design question, resolved: no-URL findings are stored

Citations with no URL at all (offline sources — books, journals) still
produce a verdict today: the live userscript's `verifyAllCitations()` (and
this repo's `service/pipeline.js`) both handle "no URL" by recording
`SOURCE UNAVAILABLE` without ever calling an LLM. `source_url_hash` is
`NOT NULL` in the schema, so these rows need *some* value there.

`core/anchor.js`'s `sourceUrlHash()` already handles this cleanly —
`sourceUrlHash(null)`, `sourceUrlHash(undefined)`, and `sourceUrlHash('')`
all produce the same deterministic hash (of the empty string), so a no-URL
citation gets a consistent, non-null value rather than an error. That part
is settled and tested.

**Decided (maintainer, 2026-08-20): yes, a no-URL finding belongs in this
table.** Store it the same way as any other unpublished finding — the
doc's proposed default is now the rule: `prompt_version` set to whatever's
current at write time (even though no prompt was actually used) and
`published = 0`. `model` has no natural value for these rows and is left
`NULL`. This keeps SOURCE UNAVAILABLE findings queryable for the same
operational reasons §7 gives for storing other unpublished findings,
without requiring a schema change to accommodate a row that never called
an LLM.

## What this module is explicitly not responsible for

- **Computing the verdict.** Nothing in this codebase calls an LLM to
  produce `verdict`/`confidence`/`rationale`/`reason_type` yet in the batch
  path — that's a separate, not-yet-built piece (routing through the
  now-complete `llm-router` tool). `buildUpsertQuery`/`upsertFinding` accept
  a fully-formed finding object as input and don't care where the verdict
  fields came from — test them with synthetic finding objects, the same way
  `service/pipeline.js`'s tests use fake `fetchSource`/`fetchArticle`
  functions rather than real ones.
- **Deciding `published`.** The precision-gate policy (design doc §1 — publish
  only high-confidence contradictions) is a separate, not-yet-built piece.
  This module accepts `published` as a plain input field and writes whatever
  it's given.
- **Reading findings back.** The design doc's "Serve" stage (§ Architecture
  at a glance, stage 6) is a different piece of work with different
  requirements (read-time claim re-resolution against the current article).
  Out of scope here.
- **Scheduling or queueing.** Someone else decides which articles to process
  and when; this module just writes one finding at a time when asked.

## Testing

Follow `tests/selection.test.js`'s shape closely — it's the most directly
analogous test file in this repo, and it works well:

- `buildUpsertQuery` gets unit tests with no database: assert the SQL binds
  every value (`?` count matches params length, same check
  `tests/selection.test.js` already does), assert it computes
  `claim_hash`/`source_url_hash` via `core/anchor.js` rather than expecting
  the caller to supply them, assert the no-URL case produces the documented
  empty-string hash rather than throwing or nulling the column.
- A fake `query` function (an in-memory array standing in for the table,
  same pattern as `tests/selection.test.js`'s `fakeReplica()`) can exercise
  `upsertFinding()`'s insert-then-update behavior without touching MariaDB
  syntax at all — the fake doesn't need to understand SQL, just record what
  it was called with.
- The real `ON DUPLICATE KEY UPDATE` behavior — that a second write with the
  same identity updates in place rather than duplicating — can only be
  proven against real MariaDB. Do that by hand on the bastion (two `INSERT`s
  via the `mariadb` CLI, or two calls to your real `upsertFinding()` against
  the live database), the same way `service/selection.js`'s query shape was
  hand-verified before this repo trusted it.

## Definition of done

1. [x] Database and table created on ToolsDB, confirmed by hand via the
   `mariadb` CLI (not just "the code ran without erroring"). Done 2026-08-20:
   `s57953__source_verifier`.`citation_findings`, created from the bastion.
2. [x] `buildUpsertQuery` has unit tests covering: a normal finding, a
   collective-group finding (`is_collective = 1`), a no-URL/SOURCE UNAVAILABLE
   finding, and re-running the same finding (asserting the SQL is one
   `INSERT ... ON DUPLICATE KEY UPDATE`, not a separate exists-check-then-branch).
   See `tests/findings.test.js`.
3. [x] A real end-to-end write against the live ToolsDB table, run twice with an
   identical finding, confirmed via `SELECT COUNT(*)` to have produced one
   row, not two. Confirmed 2026-08-20 on the bastion.
4. [x] A real end-to-end write of two findings differing only in `prompt_version`,
   confirmed to have produced two rows, not an overwrite. Confirmed 2026-08-20
   (`row_count` went from 1 to 2 after the `prompt_version='v2'` insert).
5. [x] `npm test` still passes with no regressions to the existing suite.
   `tests/findings.test.js` passes 4/4; the 16 unrelated pre-existing failures
   elsewhere in the suite are present on this branch with or without this work.

All test rows (`page_id = 999999999`) were deleted after verification —
the live table holds no fixture data.
