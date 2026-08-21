# Wiring the ToolsDB findings write path

> **Status (2026-08-21):** Proposed. Architecture for the gap between `service/pipeline.js` (produces claims + source text) and `service/findings.js` (writes one finding row). The storage *primitive* is built and hand-verified — see `2026-08-17-toolsdb-findings-store.md`; nothing calls it. This doc designs what does.

## The gap, precisely

`service/findings.js` can write a finding. Nothing produces one.

```
service/selection.js   → candidate articles          ✅ built, tested
service/pipeline.js    → claims + source text        ✅ built, tested
        ???            → a finding record            ❌ this doc
service/findings.js    → one row in citation_findings ✅ built, hand-verified
        ???            → a ToolsDB connection        ❌ this doc
```

`grep -rn upsertFinding` returns only its own definition and its test. Four
things are missing, and only the second is interesting:

| Missing | Where it goes |
| --- | --- |
| A ToolsDB connection (`replicas.js` opens *wiki* replicas only) | `service/toolsdb.js` |
| The mapping from a pipeline citation to a 26-field row | `service/finding-record.js` |
| Owners for `prompt_version`, `expires_at`, `group_id`, `citation_number` | `core/prompts.js`, the mapper |
| A runner, with batching and failure isolation | `service/store-findings.js`, `service/findings.js` |

## The thing to notice first: this does not wait on stage 4

The obvious objection is that findings need verdicts, verdicts need an LLM,
and stage 4 doesn't exist. That is true and it does not block anything, because
**two real verdict sources exist today**:

- **Citations with no URL** (offline sources — books, journals) produce
  `SOURCE UNAVAILABLE` with no model call at all. `verifyAllCitations()` and
  `service/pipeline.js` both already do this. These are real rows, with real
  claim hashes, from code that ships.
- **The replay corpus.** `benchmark/dataset.json` carries stored `source_text`
  for 182 of 189 entries and `results.json` carries the verdicts real models
  really returned for them. Zero inference, zero network.

So verification enters as an **injected seam**, exactly like `fetchSource`
already does in `processArticle()`:

```js
verifyCitation(claim, source, ctx) => {
  verdict, confidence, reasonType, rationale,
  provider, model, tokensIn, tokensOut
}
```

Three implementations over time: the no-LLM one (today), a replay one reading
`results.json` (today, and it is the demo), and tf-llm-router (later). The
write path reaches *done* against the first two. This is deliberately the
parent doc's build-sequence principle — step 11, "the highest-value step in the
whole sequence and it is available immediately" — applied to storage.

## 1. `service/toolsdb.js` — the connection

Mirrors `service/replicas.js`, and per the storage doc reuses its
`parseReplicaConfig()` rather than re-parsing `~/replica.my.cnf`.

```js
export const TOOLSDB_HOST = 'tools.db.svc.wikimedia.cloud';
export function toolsDatabase(credentialUser, name = 'source_verifier');
export async function openToolsDbConnection({ cnfPath, readFile, createConnection, ... });
```

Three decisions:

**Derive the database name; do not hardcode `s57953__source_verifier`.**
`parseReplicaConfig()` already returns `user`, and that value *is* the
credential user the database name is built from. Hardcoding it breaks the
moment this runs under a second tool account — which §5 of the parent doc
explicitly anticipates ("those belong in two tool accounts, not one", so a
browser-facing proxy can't starve the batch sweep). `toolsDatabase(user)`
validates against `/^[su]\d+$/` first: an empty or typo'd user otherwise
produces `undefined__source_verifier`, which fails as a confusing access-denied
rather than as "your config is wrong".

**Lazy-import `mysql2`.** `service/replicas.js` imports the driver at module
top level, which means `tests/replicas.test.js` cannot run at all where the
driver isn't installed — it is one of this repo's 16 currently-failing test
files, and it fails before reaching a single pure function. `service/findings.js`
has no such import, which is exactly why its tests pass everywhere. Keep the
driver behind `await import('mysql2/promise')` inside the connect function so
`toolsDatabase()` stays testable with zero dependencies. Ten seconds of work,
and the new module's tests stay green in any environment.

**Reuse `makeQueryFn()`** from `replicas.js` — the `(sql, params) => rows`
adapter is driver-shaped, not replica-shaped, and `upsertFinding()` already
expects that exact signature.

One thing to pin with a test: `core/anchor.js` returns **Buffers**, and the
`BINARY(32)` columns want Buffers. A future refactor to hex strings would write
64 bytes into a 32-byte column, which MariaDB truncates in non-strict mode —
every hash silently collapsing to its first 16 bytes, every row colliding on
the unique key. Assert `Buffer.isBuffer(params[4]) && params[4].length === 32`.

## 2. `service/finding-record.js` — the mapping

Pure, no I/O, the bulk of the new tests. One entry point:

```js
export function toFindingRecords(articleResult, context) => { records, skipped }
```

Article-level rather than citation-level, because the group decisions below are
group-scoped. Returns skips alongside records — the runner reports them, and
some of them are load-bearing.

### 2a. Store per-source rows *and* the collective row

§6 says the collective verdict is the one to **publish** for a group. It does
not say it is the only one to *store*, and it shouldn't:

- The unique key is `(wiki, page_id, claim_hash, source_url_hash, provider, prompt_version)`.
  A collective verdict covers *N* URLs. Storing only that row means picking one
  member's `source_url_hash` as its identity — so a re-run that renders the
  group in a different order picks a different member, and dedup breaks.
- §7 is explicit that unpublished findings are stored for operational value,
  and the storage doc extends that to no-URL rows.
- `main.js` keeps per-source results precisely for the debug rows
  (`getReportUnits()`'s comment says so).

So: **one row per source (`is_collective = 0`) plus one row per group
(`is_collective = 1`)**, and the merge `getReportUnits()` performs lives in the
`published` predicate and the read API instead. The write path stays dumb and
reversible, which is the property every part of this design keeps asking for.

### 2b. The collective row needs a set-valued identity — and it fixes `group_id` too

The collective row's `source_url_hash` must be a deterministic function of the
member *set*. Add to `core/anchor.js`:

```js
export function groupSourceUrlHash(urls);  // sha256("group\0" + sorted, normalized, NUL-joined)
```

Sorted, so member order — a rendering artifact — doesn't change identity.
NUL-joined, so `["ab","c"]` and `["a","bc"]` can't collide. Domain-separated
with a `"group\0"` prefix so a group hash and a single-URL hash are provably
different values even for a one-element set.

This also repairs `group_id`, which today is `cite_ref-3-0` — a **Parsoid DOM
id**, i.e. exactly the class of revision-scoped rendering artifact §2 exists to
warn about. It churns on every edit that touches the reference list, so rows
written on Tuesday and Friday for the same group don't join. Store
`group_id = groupSourceUrlHash(members).toString('hex')` instead: 64 hex chars,
which fits `VARBINARY(64)` exactly, stable across renumbering and re-rendering,
and it joins the collective row to its per-source siblings without a DOM id in
sight. One derivation, two columns.

### 2c. `citation_number` — a type mismatch already encoded in a test

`citation_number` is `INT`. `collectCitations()` produces a **string**
(`refElement.textContent` minus brackets), and `tests/findings.test.js`'s
collective case passes `'1, 2'`. Into an INT column that inserts `1` with a
warning under non-strict mode, or errors under strict.

The schema comment already says *"display only; NOT an identifier"*, so:
`toCitationNumber()` parses a leading integer and returns **`null`** for
anything else (Roman numerals, `note 1`, letters). A collective row stores the
**lowest** member number when all members parse — a useful display anchor —
else null. Correcting that existing test is in scope; it is four characters.

### 2d. Two classes of row that must *not* be written

§5 is explicit that a 403 or 429 is *retry later, never a finding*, and warns
that a publisher block would otherwise "silently corrupt the findings rather
than announce itself". A stored `SOURCE UNAVAILABLE` is indistinguishable, a
week later, from "we checked and the source was genuinely gone".

The mapper therefore classifies and skips:

| Case | Why skipped |
| --- | --- |
| `fetch_status` 403 / 429 | We were refused, not told the source is missing (§5) |
| The stage-3 **stub** (`extract-articles.js`'s `stubFetchSource`) | Nothing was attempted; its error string is not a finding |

Both land in `skipped[]` with a reason code, and the runner prints the counts.
This turns two documented hazards into enforced ones.

### 2e. `expires_at` — a policy, not a magic number

§3 wants per-finding expiry rather than a constant baked into queries. The
useful axis is *why the row exists*:

| Row | TTL | Because |
| --- | --- | --- |
| Verdict from a fetched source | 30d | The risk is the source silently changing under a live URL |
| `SOURCE UNAVAILABLE` from a fetch failure | 3d | A transient failure should be retried soon |
| No-URL (offline source) | `NULL` | It will never become fetchable; it expires when the claim changes, which the claim hash already handles |

Exported as `expiresAt(record, now)` with named, overridable constants, so it
is testable and so the numbers are visible rather than buried in a SQL string.

### 2f. `published` is always 0 from this path

The precision gate is a separate unbuilt piece (§1) and the mapper must not
guess. Worth stating the fork now, though, because it is cheap today and
expensive later: publication should be an **`UPDATE ... SET published` sweep
over stored rows**, not a write-time decision. §6's stated benefit — "the
threshold can be re-tuned without re-running any inference" — only holds if the
predicate runs over what is already stored.

`revision_id` needs no special handling: `selectCandidates()` reads
`page_latest` and `fetchArticleHtml()` pins the fetch to that oldid, so the row
honestly records the revision the verdict was computed against, even if the
article was edited in between.

## 3. `prompt_version` — nothing owns it today

The only occurrences in the repo are the string `'v1.0'` in a test. The column
is `NOT NULL` *and part of the unique key*, so a value that drifts silently
forks every row into a parallel lineage, and a value that fails to change when
the prompt does silently overwrites findings from a prompt we no longer trust.
That is the exact failure §6 introduced the column to prevent.

**Derive it from the prompt text**, in `core/prompts.js`:

```js
export function promptVersion();  // "p1-<sha256(normalized system + group prompts)[0..12]>"
```

Both generators take no arguments and contain nothing volatile — verified — so
the hash is stable. Hash the whitespace-normalized concatenation so reflowing a
paragraph doesn't fork the lineage; keep the human-readable `p1-` prefix as a
coarse epoch a maintainer can bump deliberately.

Why not a hand-maintained constant: CLAUDE.md already warns the nine few-shot
examples are load-bearing and that changing them changes verdicts. A constant
relies on the person editing those examples remembering to bump it. A hash
cannot be forgotten.

Pin the current value in a test, the way `tests/quote.test.js` pins
`QUOTE_STATUS_LIST` — so any prompt edit fails loudly and the author has to
acknowledge the fork rather than discover it in the data. Batch is English-only
per §10, so only the English prompts are versioned.

## 4. Write policy — bulk, chunked, transactional per article

`upsertFinding()` is one row per round trip; an 80-citation article is 80 round
trips. Add a bulk builder **derived from the same column list** as the
single-row one — a copy-pasted column list is precisely where a future edit
shifts every value one column left, silently:

```js
export function buildBulkUpsertQuery(findings, { chunkSize = 500 });
```

Chunked at 500 rows: 26 params × 2520 rows hits the 65535 prepared-statement
placeholder ceiling, and 500 leaves room without approaching
`max_allowed_packet`. Each article's chunks run inside one transaction —
all-or-nothing, because a half-written article is worse than a skipped one
(the missing rows read as "we checked and found nothing"). On a chunk failure,
fall back to per-row writes for that chunk to isolate and name the offending
row, then continue the sweep.

`upsertFinding()` stays exactly as it is. The bulk path is additive.

## 5. `service/store-findings.js` — the runner

Thin wiring in the shape of `select-articles.js` and `extract-articles.js`,
with `main()` behind the `import.meta.url` guard per CLAUDE.md.

```
node service/store-findings.js --criterion failed-verification --max 5
node service/store-findings.js --max 1 --live-source-fetch --write
```

**`--dry-run` is the default; `--write` opts in.** Stage 3 is stubbed by
default (WMCS has not cleared unattended fetching), so a default-on write would
pour dozens of fabricated "unavailable" rows into the live table on someone's
first exploratory run — the exact thing the storage doc's closing line was
careful to avoid ("the live table holds no fixture data"). §2d's skip rules
make that mostly moot; the default makes it impossible.

Writes stream per article as `runBatch` yields — that generator exists so
callers "can persist findings incrementally rather than buffering an entire
sweep". The Replicas connection closes before the REST fetches begin, as
`extract-articles.js` already does; the ToolsDB connection opens once and
closes in a `finally`.

## 6. Testing

Steps 1–5 are pure and run in any environment. Following `tests/selection.test.js`:

- **`finding-record.js`** carries the weight: solo citation; group of 3 → 4 rows;
  no-URL row; 403 and stub skips; citation-number coercion incl. `'1, 2'`;
  TTL per class; group id identical across reordered members; group hash ≠
  single-URL hash for a one-element set.
- **`buildBulkUpsertQuery`**: placeholder count = 26 × N, column list byte-identical
  to the single-row builder, chunk boundaries.
- **`toolsdb.js`**: database-name derivation and its validation, no driver needed.
- **The runner**: a fake `query` recording calls, same shape as `fakeReplica()`.

Only real MariaDB can prove multi-row `ON DUPLICATE KEY UPDATE`, so hand-verify
on the bastion as before. One trap worth knowing going in: `affectedRows` counts
**1 per insert and 2 per update**, so it legitimately exceeds N — assert with
`SELECT COUNT(*)`, never with `affectedRows`.

## Sequence

| # | Step | Blocked on |
| --- | --- | --- |
| 1 | `groupSourceUrlHash()` in `core/anchor.js` | — |
| 2 | `promptVersion()` in `core/prompts.js` + pinning test | — |
| 3 | `service/toolsdb.js` | — |
| 4 | `service/finding-record.js` | 1, 2 |
| 5 | Bulk builder in `service/findings.js`; fix the collective test's `citation_number` | — |
| 6 | `service/store-findings.js` | 3, 4, 5 |
| 7 | Bastion: one article, `--write`, twice → row count stable; delete fixtures | 6 |
| 8 | Replay mode over `dataset.json` — the demonstrable system | 6 |

1–6 need no Toolforge session and no WMCS answer.

## Explicitly out of scope

- **Stage 4 verification.** Enters through the injected `verifyCitation` seam.
- **The publication filter.** Separate piece; §2f argues it should be a sweep.
- **The read API**, which needs read-time claim re-resolution (§2).
- **Scheduling.** The Toolforge jobs framework, once there is something worth scheduling.

## Open question for the maintainer

Should replay-over-`dataset.json` (step 8) be a supported mode of
`store-findings.js`, or a throwaway script? It is the parent doc's step 11 and
the thing worth demonstrating to the Foundation, which argues for supported —
but it means the runner grows a second input source, and every real-article
code path then has a fixture twin to keep working.
