# Recording the DOI as source-identity metadata on a logged check

> **Status (2026-08-27):** Proposed. Metadata only — no dedup, no cache key, no change to fetching or verdicts.

## Problem

`verification_logs` identifies the source of a check by exactly one field:
`source_url`, whatever `extractReferenceUrl()` happened to pull out of the
footnote. That is a location, not an identity, and the two come apart
constantly:

- The same paper appears as a publisher URL in one article, a PDF on an
  institutional repository in another, and a `web.archive.org/web/…` wrapper in
  a third. Three rows, three `source_url` values, one source.
- Our own fetch path rewrites URLs — the Wayback raw endpoint (`…id_/…`), the
  Wayback fallback when a live fetch fails. `source_url` records the citation's
  URL rather than the fetched one, so this is currently contained, but it means
  "the URL in the log" is already one of several URLs in play.
- Trailing slashes, `http` vs `https`, tracking parameters, and mirrors all
  fragment what is really one source into distinct strings. Any query that
  groups by source has to normalize first, and normalization by URL is
  guesswork.

Meanwhile a large share of academic citations already carry a **DOI** — a
persistent, publisher-assigned, globally unique identifier for exactly the
thing we checked the claim against. We throw it away.

## Goal

One additional column on the log row: the DOI of the cited source, when the
citation carries one, in normalized bare form (`10.1038/nature12373`).

That is the whole goal. Concretely, it makes queries like these possible for
the first time:

```sql
-- every check ever run against this paper, across articles and URL forms
SELECT article_title, citation_number, verdict, confidence, ts
FROM verification_logs WHERE doi = '10.1038/nature12373';

-- sources that repeatedly come back NOT SUPPORTED — a possible citation-spam
-- or misattribution signal, invisible when grouped by URL
SELECT doi, count(*) FILTER (WHERE verdict = 'NOT SUPPORTED') AS failures, count(*) AS checks
FROM verification_logs WHERE doi IS NOT NULL GROUP BY doi HAVING count(*) > 2;

-- do we do systematically worse on paywalled academic sources?
SELECT verdict, count(*) FROM verification_logs
WHERE doi IS NOT NULL GROUP BY verdict;
```

## Non-goals

Named explicitly, because each is a plausible next step and none of them is
this change:

| Not doing | Why not |
| --- | --- |
| Deduping citations by DOI | Changes which checks run. A verdict depends on the *claim* as much as the source, so two claims citing one DOI are two different questions. |
| Reusing a cached verdict for a repeat DOI | Same reason, plus it would silently make results non-reproducible. |
| Keying the source-content cache on DOI | The cache key is a fetch key; DOI doesn't name a fetchable document. |
| Resolving a DOI to fetchable full text (Crossref, Unpaywall) | Real feature, real API dependency, separate design. |
| Showing the DOI in the sidebar or the talk-page section | Nothing on screen is improved by it; it is a research field. |
| Adding DOI to the benchmark dataset schema | The benchmark's identity problem is `row_id`, which DOI doesn't solve (many rows are news/web sources with no DOI). |
| Backfilling existing rows | Impossible: the DOM the DOI would come from isn't stored. Forward-fill only. |

## Decisions

### 1. Store the bare DOI, not the resolver URL

`10.1038/nature12373`, not `https://doi.org/10.1038/nature12373`.

The resolver URL is derivable from the DOI; the DOI is not reliably derivable
from the URL (percent-encoding, `dx.doi.org` vs `doi.org`, an archive wrapper
around either). Storing the identity rather than one of its renderings is the
entire point of the column — a column of resolver URLs would reproduce the
`source_url` problem in miniature.

### 2. One `doi` column now; a general identifier bag later, if ever

The alternative is a JSON `identifiers` column carrying DOI, PMID, PMCID,
ISBN and arXiv id together.

**Rejected for now.** A single indexed `TEXT` column answers the question that
motivated this ("which checks are about this source?") with an equality
predicate and no JSON operators, and DOI is the identifier with by far the
best coverage of the sources we actually fail on. The others can each become
their own column if a question needs them.

But the *extractor* is written so that is cheap: `core/identifiers.js` exposes a
small table of `{ type, hrefHosts, textPrefix, pattern, normalize }` and
`extractDoi()` is one entry in it. Adding PMID is then a table entry plus a
column, not a rewrite.

### 3. Match on content — the href and the `doi:` prefix — never on template classes

Three shapes carry a DOI in rendered en.wiki footnote HTML:

```html
<!-- (a) cite template with |doi= : a link to the resolver, percent-encoded -->
<a rel="nofollow" class="external text"
   href="https://doi.org/10.1038%2Fnature12373">10.1038/nature12373</a>

<!-- (b) a bare external link somebody typed by hand -->
<a href="https://dx.doi.org/10.1234/abc.def">the paper</a>

<!-- (c) plain prose, older manual citations -->
doi:10.1234/abc.def
```

Citation Style 1's wrapper markup (`cs1-lock-free`, the "doi (identifier)"
wikilink, the lock icons) changes on the wiki's schedule, not ours, so keying
on a class name is a match that silently stops matching. Matching the href and
the text is stable.

**The pattern is only accepted in two positions**, never as a bare
`10.xxxx/yyy` anywhere in the footnote text:

- in the path of an `href` whose host is `doi.org` or `dx.doi.org` — including
  one nested inside an archive URL, which is a genuine DOI and should match;
- immediately after a `doi:` or `doi.org/` prefix in the footnote's text.

Without that restriction, an ordinary source URL of the form
`https://example.com/10.1234/report` becomes a false DOI. A false identity is
worse than a missing one: a missing DOI is a `NULL` the query skips, while a
false one silently merges two unrelated sources into one group.

The DOI pattern itself is Crossref's practical form, `10.\d{4,9}/\S+`, applied
after percent-decoding (shape (a) delivers `10.1038%2Fnature12373`).

### 4. Normalize: lowercase, strip prefix, strip trailing prose punctuation

DOIs are case-insensitive for ASCII, and the same DOI is written
`10.1038/Nature12373` and `10.1038/nature12373` in different citations — the
column is worthless for grouping if those are two values. So: percent-decode,
strip a leading `doi:` / `DOI:`, lowercase, and strip a trailing `.`, `,`, `;`
or `)` picked up from surrounding prose. Reject anything that doesn't match the
pattern after all that, and reject anything over 255 characters.

Rejection returns `null`, which is the same as absence. There is no
"unverified DOI" state and no warning — this mirrors the quote-verification
rule in `core/quote.js`: a value we can't stand behind is simply not recorded.

### 5. Resolve the footnote the same way the URL does — via one shared helper

A Harvard/sfn short-cite footnote contains no DOI; the full citation it points
at via `#CITEREF…` does. `extractReferenceUrl()` already follows that hop, and
the DOI extractor must follow the same one or it will miss every sfn-style
citation in exactly the articles (academic ones) most likely to have DOIs.

Rather than copy that traversal, **factor the footnote-resolution out of
`extractReferenceUrl()` into `resolveFootnoteElement(refElement, doc)` in
`core/urls.js`** and have both call it. This is a small refactor, but it is the
difference between one traversal implementation and two that will drift.

### 6. Group rows carry `NULL`, not a joined list

A `kind='group'` row already has `source_url = NULL` because there were several
sources. `doi` follows the same rule.

**Rejected:** comma-joining, the way `citation_number` does. A joined string of
DOIs is not a DOI, so every query on the column would have to parse it, and the
individual DOIs are already on the per-source rows of the same group. The
column means "the DOI of *the* source this row checked" — a group row has no
such thing, and `NULL` says that correctly.

### 7. Untrusted text, but no new exposure

The DOI comes from arbitrary article wikitext, so it is untrusted by
construction. The mitigations are already structural: it is validated against a
strict pattern and length-capped before it leaves the browser (decision 4), it
is parameterized by the Neon driver on insert, and — because this is metadata
only (non-goals) — **it is never rendered into the panel, never written into
wikitext, and never fetched**. So it adds no surface to the escaping paths in
`escapeHtml()` / `escapeWikitableCell()` and no new outbound request.

If a later change does put the DOI on screen or in a report, that change owns
the escaping; this one deliberately does not open the door.

## Implementation

Seven touch points, in dependency order.

| # | File | Change |
| --- | --- | --- |
| 1 | `core/urls.js` | Extract `resolveFootnoteElement(refElement, doc)` from `extractReferenceUrl()` (including the `#CITEREF` hop and the parent-`<li>` fallback); `extractReferenceUrl()` and `extractPageNumber()` call it. Pure refactor, no behavior change. |
| 2 | `core/identifiers.js` **(new)** | `normalizeDoi(raw)` and `extractDoi(refElement, doc = globalThis.document)`, per decisions 3–5. Same `doc`-parameter convention as `core/urls.js` so Node callers work. |
| 3 | `core/citations.js` | `collectCitations()` adds `doi: extractDoi(refElement, doc)` to each citation object, next to `url` and `pageNum`. The report path, the CLI, and `service/pipeline.js` all pick it up for free. |
| 4 | `core/feedback.js` | `buildLogPayload()` maps `fields.doi` → `doi`, defaulting to `null`, with a comment saying what it is for. |
| 5 | `main.js` | `this.activeDoi = null` in the constructor beside `activeSourceUrl` (line ~2721). In the reference-selection handler, set `this.activeDoi = extractDoi(refElement)` **before** the `if (!refUrl)` early return — a book or paywalled citation with no fetchable URL still has a DOI, and that is a row worth identifying. `logVerification()` passes `doi: fromContext('doi', this.activeDoi)`. The three batch call sites pass `doi: citation.doi`; the collective path passes `doi: null` (decision 6). |
| 6 | `scripts/sync-main.js` | Add `'identifiers.js'` to `CORE_ORDER`, after `urls.js` and before `citations.js`. Then `npm run build`. |
| 7 | `CLAUDE.md` | One line in the `core/` file list. |

### Worker and database (separate repo)

`alex-o-748/public-ai-proxy`, `src/index.js`:

```sql
ALTER TABLE verification_logs ADD COLUMN doi TEXT;
CREATE INDEX verification_logs_doi_idx ON verification_logs (doi) WHERE doi IS NOT NULL;
```

and add `doi` to the explicit column list and `VALUES` tuple of the `/log`
`INSERT`.

**This is the step that will look done and not be.** As
`docs/worker-logging-reference.md` already warns: the client may send any field
it likes, but a field that is not named in the Worker's INSERT is dropped in
silence — no error, client-side or server-side. A `doi` column that is always
`NULL` will look like a broken extractor. Check the Worker's column list first.

Ordering is not critical, because `/log` is fire-and-forget: shipping the
client first means a window where the field is sent and discarded, which is
harmless. Shipping the Worker first means a window where the column exists and
is always `NULL`. Either is fine; nothing breaks.

`docs/worker-logging-reference.md` needs the schema block, the migration block,
and the handler snippet updated in the same change.

## Tests

`tests/identifiers.test.js` (new), JSDOM fixtures in the style of
`tests/urls.test.js`:

- each of the three DOM shapes from decision 3, including the percent-encoded
  `href` form;
- a `doi.org` URL nested inside a `web.archive.org` wrapper → extracted;
- a Harvard/sfn short-cite whose full citation carries the DOI → extracted via
  the `#CITEREF` hop;
- **the false-positive guard**: `https://example.com/10.1234/report` → `null`;
- normalization: mixed case, `doi:` prefix, trailing `.` / `,` / `)`;
- rejection: junk, over-length input, a footnote with no DOI → `null`;
- two DOIs in one footnote → the first in document order, deterministically.

Extensions to existing suites:

- `tests/urls.test.js` — the refactor of step 1 keeps `extractReferenceUrl()`
  behavior identical (the existing tests are the guard; no new ones needed
  beyond a direct `resolveFootnoteElement` case).
- `tests/citations.test.js` — `collectCitations()` attaches `doi`, and `null`
  when the footnote has none.
- `tests/feedback.test.js` — `buildLogPayload()` carries `doi` and nulls it by
  default, matching the existing assertions for `revision_id` and
  `quote_status`.

`npm test` from the repo root, plus `node scripts/sync-main.js --check` to
confirm `main.js` was re-inlined.

## Risks

| Risk | Assessment |
| --- | --- |
| False DOIs merging unrelated sources | The reason for decision 3's position restriction and decision 4's strict validation. Tested directly. |
| Coverage lower than hoped | Likely, and acceptable — most of our current dataset is news and web sources with no DOI. The column is `NULL` for those, which costs nothing. Worth measuring after a few weeks rather than predicting. |
| The Worker INSERT is not updated | The known silent-failure mode, called out above and in `docs/worker-logging-reference.md`. |
| `extractReferenceUrl()` regression from the step-1 refactor | Existing `tests/urls.test.js` coverage is the guard; the refactor moves code without changing it. |
| Verdict or benchmark drift | None. Nothing in this change is visible to a prompt, a model, or the benchmark runner. |

## Open question

Whether `doi` should also be attached to the findings records in
`service/findings.js` (the Toolforge batch path), which has its own store and
its own schema. It gets `citation.doi` for free from step 3, so it is only a
question of whether the store keeps it. Answering that needs a look at the
findings schema and is deliberately left out of this change.
