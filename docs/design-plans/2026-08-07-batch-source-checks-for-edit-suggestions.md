# Batch source checks as an Edit Suggestions feed

> **Status (2026-08-07):** Proposed. Requirements analysis for the WMF Edit Suggestions integration — no implementation started. Open to alternatives on every numbered decision below.

## The use case

The Wikimedia Foundation wants sourcing problems to appear as **edit suggestions**: an
editor opens an article and sees "this claim may not be supported by its
citation" alongside the other suggested-edit types.

That inverts how this tool works today. The current shape is:

```
editor clicks [14] → fetch source → one LLM call → verdict in the sidebar
```

The proposed shape is:

```
crawler picks N articles → fetch every source → LLM per citation → write to DB
                                                                      ↓
                            editor opens article → Suggestions API reads DB → cards
```

Three properties change, and nearly every requirement below falls out of one of
them:

| | Today | Batch + API |
| --- | --- | --- |
| **Who is present** | The editor, watching a progress bar, with the article in front of them | Nobody. Results are written hours or days before anyone reads them |
| **Cost of a wrong answer** | Editor reads the rationale, disagrees, closes the panel | A suggestion is pushed at an editor who did not ask for it |
| **What identifies a finding** | The `[14]` on screen, right now | A row in a database that must still point at the right claim after the article has been edited |

## 1. Precision is the blocking requirement

This is the one that decides whether the feature is viable, so it goes first.

In the live tool, a wrong verdict costs the editor the ten seconds it takes to
read the rationale and dismiss it — they *asked* for the check. As an edit
suggestion it is unsolicited, and a suggestion queue that is wrong a third of
the time trains editors to ignore the whole queue, including the correct items.

Current numbers, computed from `benchmark/analysis.json` (186 entries, latest
run). "Flag" = the model returned NOT SUPPORTED or PARTIALLY SUPPORTED, i.e.
anything that would generate a suggestion:

| Provider | Exact acc. | NOT SUPPORTED precision | NOT SUPPORTED recall | Any-flag precision | Any-flag recall |
| --- | --- | --- | --- | --- | --- |
| Gemini 2.5 Flash | 66.7% | 71% | 83% | 77% | 84% |
| Qwen SEA-LION | 60.0% | 72% | 57% | 84% | 42% |
| Apertus 70B | 54.2% | 50% | 39% | 64% | 62% |
| Claude Sonnet 4.5 | 48.9% | 50% | 15% | 81% | 33% |

Read the precision column as: **between 1-in-6 and 1-in-2 suggestions would be
wrong.** That is the number to move before anything ships, and it is a
different optimization target than the one the benchmark has been tuned for so
far — the project has been chasing exact-match accuracy across four classes,
where this use case only cares about the precision of the flagged class.

What follows from that:

1. **Report precision/recall on the flag class, not just exact accuracy.**
   `analyze_results.js` should emit a precision-at-threshold curve for
   "flag vs no-flag". Everything else in this section depends on being able to
   measure it.
2. **Gate on confidence, and tune the threshold on the benchmark.** The verdict
   already carries a 0–100 confidence (`core/parsing.js`). Publishing only
   high-confidence NOT SUPPORTED findings trades recall for precision, which is
   exactly the trade this use case wants — there is no shortage of citations to
   check, so low recall costs nothing but coverage. Note the calibration
   figure in `analysis.json` (Apertus: 79 avg confidence when correct, 74 when
   wrong) — confidence is only weakly discriminative today, so this needs
   validating rather than assuming.
3. **Consider an ensemble gate.** `benchmark/voting.js` and
   `compute_ensemble.js` already exist. "Two independent models both say NOT
   SUPPORTED" is the cheapest large precision win available, at 2× inference
   cost — and inference cost is not the binding constraint in a batch pipeline
   the way latency is in the live one.
4. **Suppress PARTIALLY SUPPORTED entirely, at least for v1.** It is the class
   the models confuse most (Claude: 26 of 53 partial cases called Supported),
   the hardest for an editor to act on, and it is often an artifact of
   between-citations claim extraction splitting a compound sentence rather than
   a real sourcing defect. NOT SUPPORTED with `reason_type: "contradiction"` is
   the highest-precision, most actionable signal the tool produces — start
   there.
5. **Never publish SOURCE UNAVAILABLE as an editor-facing suggestion.** It is
   a statement about the crawler's luck, not about the article. A dead link is
   a real maintenance issue, but it is one existing bots already handle, and a
   paywall or bot-block is not an article defect at all. Keep these rows in the
   DB (they are operationally valuable — see §7) and filter them at the API.

## 2. A finding needs a stable anchor

Today a result is identified by the rendered citation number, `[14]`. That
number is a **rendering artifact of one revision**: insert a citation into the
lead and every number below it shifts. Batch results written on Tuesday and
read on Friday would point at the wrong claim.

Nothing in the current data model survives an edit. `verification_logs` stores
`article_url` + `citation_number` (`docs/worker-logging-reference.md`); the
report path stores `refElement` DOM handles plus `reportRevisionId`
(`main.js`). Both are revision-scoped by construction.

A stored finding needs to identify, in this order of preference:

- **The claim** — a normalized hash of the extracted claim text is the most
  robust available anchor, because `extractClaimText()` already normalizes
  whitespace and strips maintenance markers. It survives citation renumbering,
  paragraph reordering, and section moves. It does not survive a copyedit of
  the claim itself, which is the correct behavior: if the claim changed, the
  verdict is void.
- **The citation** — the source URL, plus the `<ref name="...">` when present.
  Together with the claim hash this is close to unique.
- **The revision it was computed against** — `oldid`, non-negotiable, so the
  reader can tell how stale the finding is and diff against current.

And the API needs a resolution step at read time: given a finding and the
*current* wikitext, locate the claim; if it can't be located, drop the
suggestion silently. The reader side must be prepared to fail to match — this
is the normal case for a stale finding, not an error.

**Wikitext vs HTML is a real gap.** Everything in `core/` operates on rendered
HTML — `getCitationGroup` walks `.reference` elements, `extractClaimText` uses
DOM Ranges. Edit suggestions are consumed in an editor working on **wikitext**
(or on the VE DOM). Whoever builds the suggestion card has to map
HTML-derived claim text back to a wikitext offset. Parsoid HTML carries
`data-mw` and `about`/`id` attributes that make this tractable — worth pinning
down early with the Suggestions team, because if the mapping has to happen on
our side it is a substantial new component, and if it happens on theirs we only
have to hand over clean claim text.

## 3. Staleness and invalidation

Once results outlive the page view, the pipeline owns a cache-invalidation
problem it does not have today:

- **Article edited** → every finding on that revision is suspect. Cheap
  mitigation: re-resolve the claim hash at read time (§2) and drop
  non-matching findings. Proper mitigation: subscribe to the EventStreams
  recentchange feed and mark findings dirty on edit.
- **Claim fixed by an editor** → must stop being suggested immediately, and the
  fix is exactly the outcome the feature exists to produce. Claim-hash
  resolution handles this for free: the editor rewrites the claim, the hash
  stops matching, the suggestion disappears.
- **Source changed underneath a live URL** → invisible to us. A TTL is the only
  practical answer. Something like 90 days feels right; it should be a
  configurable per-finding `expires_at` rather than a constant baked into
  queries.
- **Citation removed or replaced** → resolution fails, finding drops.

The cheap version of all of this is: store `expires_at`, resolve claim hashes at
read time, and re-crawl on a fixed cadence. The expensive version is
event-driven invalidation. Start cheap.

## 4. What has to be built (and what already exists)

The good news is that the 2026 `core/` extraction did most of the hard work
already. `core/` is pure ESM with no browser assumptions, and `cli/verify.js`
is a working headless end-to-end path: Wikipedia REST fetch → JSDOM → claim
extraction → proxy fetch → LLM → parsed verdict, with typed exit codes.

**Reusable unchanged:** `core/claim.js`, `core/urls.js`, `core/parsing.js`,
`core/prompts.js`, `core/providers.js`, `core/verdicts.js`, `core/retry.js`,
`core/worker.js`.

**What's missing:**

| Piece | Notes |
| --- | --- |
| **Article-level headless runner** | `cli/verify.js` does one citation; `verifyAllCitations()` does a whole article but is 250 lines welded to the sidebar DOM, OOUI confirm dialogs, progress bars, and `mw.config`. The orchestration logic (source cache, group collective pass, retry, cancellation) is worth extracting to `core/` and sharing, rather than writing a third copy |
| **Work queue / scheduler** | Which articles, in what order, how often. Does not exist in any form |
| **Findings store** | `verification_logs` is a fire-and-forget telemetry log with no idempotency key, no revision, no claim text, no rationale. A findings table is a new schema, not an extension of that one (see §6) |
| **Read API** | New. Auth, per-article and per-wiki queries, filtering |
| **Feedback ingestion** | Accept/reject signal from editors flowing back (see §9) |
| **Cost accounting** | `usage` is returned per call by every provider in `core/providers.js` and thrown away outside the benchmark |

One structural note: `main.js` is built by inlining `core/` via
`scripts/sync-main.js`. A batch service should import `core/` directly, the way
`benchmark/` and `cli/` do — resist any temptation to fork logic into the
service.

## 5. What the proxy has to become

The worker (`publicai-proxy.alaexis.workers.dev`, source not in this repo) is
currently sized for a human clicking citations. In the batch world it becomes
the hot path for every fetch and most inference, and the load profile inverts:
bursty, unattended, high-volume, no human to notice when it degrades.

**Politeness and blocking.** Today, fetches are spread across many editors'
sessions. A crawler concentrates them on one Cloudflare egress. Publishers will
rate-limit or block, and the current failure mode — SOURCE UNAVAILABLE — is
indistinguishable from a genuinely dead link, so blocking would silently
corrupt the dataset rather than announce itself. Needed: a descriptive
User-Agent with a contact URL, per-host rate limiting and backoff,
`robots.txt` respect, and — importantly — a distinction in the response between
"dead" and "we were refused". `fetchSourceContent()` already returns `status`,
so the schema is there; the worker needs to populate it accurately and the
consumer needs to treat 403/429 as *retry later*, never as a finding.

**Fetch caching and dedup.** One source often backs claims across many
articles, and re-crawls hit the same URLs repeatedly. A content-addressed cache
in the worker (R2 or KV, keyed on URL + page, with the extracted text and a
fetch timestamp) removes most of the fetch load and, incidentally, makes runs
reproducible — a benchmark property this project already cares about
(`--change-axis source_text` in `docs/comparing-benchmark-runs.md`). The
userscript's `sourceCache` does this per-run, in memory; the batch pipeline
needs it durable and shared.

**The 413 ceiling.** `core/providers.js` handles a 413 from the proxy with a
message telling the *user* to trim the source or switch providers. There is no
user in a batch run. The pipeline needs an automatic path: chunk the source and
verify against the most relevant chunk, or route oversized requests to a
direct-call provider. As it stands, every long source silently fails.

**Quota exhaustion is the realistic failure mode, and it is currently silent.**
In the latest benchmark, 31 of 186 calls failed for *both* PublicAI-hosted
models — all of them `HTTP 402: Insufficient wallet balance`. Not flakiness:
the credits ran out partway through and every subsequent call failed
identically. 17% of that run is void, and nothing in the pipeline announced it.
`core/retry.js` doesn't retry 402 (correctly — retrying won't help), but a
batch runner needs to **halt** on 402/401 rather than burn through the queue
writing failures. Add: pre-flight quota check, hard stop on auth/billing
errors, and alerting.

**Auth.** `/log` currently accepts unauthenticated POSTs with
`Access-Control-Allow-Origin: *` — fine for anonymous telemetry, unacceptable
for a store that feeds editor-facing suggestions. Writes need a service
credential; reads need their own auth and rate limits.

**Where it should run.** Right now inference and fetching are routed through
one personal Cloudflare Worker paid for by one person's API credits. If this
becomes a Foundation-facing feature, that is a bus-factor and a funding
problem, not a technical one — but it needs an owner. Lift Wing is already
wired up as a provider (`callLiftwingAPI` in `core/providers.js`, routed via
the same worker) and is the obvious home for WMF-hosted inference; the batch
path would want to call it directly rather than through a personal proxy.

## 6. Storage

`verification_logs` is a telemetry log. A findings store is a different table:

```sql
CREATE TABLE citation_findings (
  id              BIGSERIAL PRIMARY KEY,
  wiki            TEXT NOT NULL,        -- 'enwiki' — this is per-wiki from day one
  page_id         INT  NOT NULL,        -- stable across renames, unlike the title
  page_title      TEXT NOT NULL,        -- denormalized for display
  revision_id     BIGINT NOT NULL,      -- the oldid this was computed against
  claim_hash      TEXT NOT NULL,        -- normalized claim text hash — the anchor (§2)
  claim_text      TEXT NOT NULL,        -- for display and for re-resolution
  citation_number INT,                  -- display only; NOT an identifier
  ref_name        TEXT,                 -- <ref name="..."> when present
  source_url      TEXT,
  source_hash     TEXT,                 -- content hash of the fetched text
  group_id        TEXT,                 -- adjacent-citation group (core/claim.js)
  is_collective   BOOLEAN,              -- collective vs per-source verdict
  verdict         TEXT NOT NULL,
  confidence      INT,
  reason_type     TEXT,                 -- 'contradiction' | 'omission'
  rationale       TEXT,                 -- the model's comments — editors need the why
  provider        TEXT,
  model           TEXT,
  prompt_version  TEXT NOT NULL,        -- invalidate findings when prompts change
  fetch_status    INT,                  -- upstream HTTP status; distinguishes fetch failures
  source_truncated BOOLEAN,
  tokens_in       INT,
  tokens_out      INT,
  cost_usd        NUMERIC,
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  published       BOOLEAN DEFAULT false, -- passed the precision gate in §1
  UNIQUE (wiki, page_id, claim_hash, source_url, provider, prompt_version)
);
```

Three fields carry more weight than they look like they do:

- **`prompt_version`** — the system prompt's 9 few-shot examples are load-bearing
  (CLAUDE.md says so explicitly), and changing them changes verdicts. Without a
  version column there is no way to answer "which findings were produced by the
  prompt we no longer trust", and no way to invalidate them.
- **`published`** — separates *what we computed* from *what we show*. The
  precision gate (§1) is a filter on this column, which means the threshold can
  be re-tuned without re-running inference.
- **`rationale`** — a suggestion that says "this citation may not support the
  claim" with no reasoning is unactionable, and the model's quoted-evidence
  comment is the most useful thing it produces.

Adjacent-citation groups are already handled by
`docs/design-plans/2026-06-23-collective-group-verification.md`: for a group,
the **collective** verdict is the one to publish, not the per-source verdicts —
that design exists precisely because per-source verdicts on grouped citations
are misleading. `getReportUnits()` in `main.js` implements the merge and is the
reference for the semantics.

## 7. Coverage

Not every citation is checkable, and the batch pipeline should be explicit about
its denominator rather than treating "unchecked" as "fine":

- **Google Books URLs are skipped outright** (`isGoogleBooksUrl`, `core/urls.js`).
- **Offline sources** — books, journals, newspapers — have no URL. In the live
  tool the editor can upload a PDF or paste text (`handlePdfFileSelected`,
  `loadManualSourceText`). There is no equivalent in batch, and no way to
  invent one.
- **Paywalls, bot-blocks, and JS-rendered pages** fetch "successfully" and
  return login walls or empty shells. The prompt has explicit guidance for
  spotting unusable sources, which is why SOURCE UNAVAILABLE exists as a
  verdict — but see §1.5: these are not suggestions.

Worth measuring before committing to a coverage estimate: run the pipeline over
a few hundred articles and report what fraction of citations reach the LLM at
all. My expectation is that it is well under half, and that is fine — but the
Foundation should hear it as a number up front rather than discover it later.

## 8. Article selection

Nothing exists here and it deserves thought, because it determines both cost and
perceived quality. Options, roughly in increasing order of sophistication:

- Articles already carrying `{{failed verification}}` / `{{citation needed}}`
  — the highest prior, and a built-in ground-truth signal, since
  `MAINTENANCE_MARKER_RE` in `core/claim.js` already detects them.
- High-traffic articles (pageview API), where a fixed error rate does the most
  damage.
- Articles in WikiProject or campaign scope, if the Suggestions surface is
  already organized that way.
- Recently-edited articles, where a new unsourced claim is freshest.

The cheapest useful thing to build first is a queue table with a priority
column and a manual seed list.

## 9. The feedback loop is the real prize

If a suggestion card carries accept/reject, every interaction becomes a labeled
example — exactly the data `Benchmarking_data_Citations.csv` is painstakingly
hand-built from today (189 rows, and a documented history of ground-truth
audits). At Foundation scale this would produce more labeled data in a week
than the project has accumulated in a year.

That argues for designing the feedback capture **into the first version**, not
bolting it on: store the finding id, the editor's action, and — optionally, if
the surface allows it — a reason. Feed it back into the benchmark dataset via
the existing tooling. The `submission.js` Google-Form path is the current
mechanism and is fine for volunteers, but a Foundation integration should write
straight to the store.

One caution: this feedback is not the same as the current ground truth. Editors
reject suggestions for reasons unrelated to correctness (already fixed, not
worth it, disagree with the tag). Reject-rate is a usefulness metric; treat it
as a proxy for precision only after auditing a sample.

## 10. Governance

Flagging sourcing problems at scale is a community-facing act, not just an
engineering one. Things that will come up, best raised early:

- **Per-wiki scope.** The prompt is English and its few-shot examples are tuned
  on English Wikipedia. The UI is localized (fr/es) but the prompts deliberately
  are not, and `localizeSystemPrompt()` only asks for output in another
  language. Extending to other wikis means new benchmark data per wiki, not just
  translation.
- **Attribution and transparency.** Editors should be able to see which model
  produced a suggestion and when — the schema above supports it; the card
  should surface it.
- **Opt-out.** Some projects will want none of this.
- **No automated edits.** Suggestions only. This should be stated explicitly
  somewhere durable.

## Suggested phasing

1. **Measure.** Add flag-precision/recall + threshold curves to
   `analyze_results.js`. Decide whether a confidence gate or an ensemble gets
   precision to a defensible number. Nothing else matters until this lands.
2. **Extract the orchestration.** Pull the article-level loop out of
   `verifyAllCitations()` into `core/`, and add a `ccs verify-article` CLI
   subcommand on top of it. This is useful on its own and is the batch runner's
   engine.
3. **Anchor.** Add claim-hash computation to `core/claim.js` (with tests) and
   the resolution routine that maps a stored finding onto current article text.
4. **Store.** `citation_findings` schema, authenticated write path, cost
   accounting.
5. **Harden the proxy.** Durable fetch cache, per-host politeness, 413 chunking,
   402 halt-and-alert, service auth.
6. **Serve.** Read API with the published-only filter and read-time resolution.
7. **Close the loop.** Feedback ingestion into the benchmark dataset.

Steps 1–3 are worth doing regardless of whether the Foundation integration
happens — they improve the existing tool. Step 1 is the one that decides whether
the rest is worth building.

## Open questions for the Foundation

1. Who hosts inference and the fetch proxy? Lift Wing for inference is the
   obvious answer; the fetch side has no obvious home.
2. Does the Suggestions surface resolve claim text to a wikitext location, or
   must we hand over a wikitext offset?
3. What precision bar does the Suggestions queue require? There is presumably a
   number other suggestion types are held to.
4. Which wikis, and what is the expected article volume? This sets the cost
   envelope.
5. Does the card surface accept/reject, and can that signal be exported back?
