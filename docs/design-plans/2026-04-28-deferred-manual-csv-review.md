# Deferred design: manual review of held-back CSV expansion

**Status:** **DEFERRED** as of 2026-04-30, in favor of the lighter "reliable subset of WMF data" path described below. Not rejected — the artifacts built here remain useful and the approach can be resumed when the goal shifts back to "ship a polished benchmark-expansion PR upstream."

**Goal (what we set out to do):** Take the 115-row held-back curation batch from `citation-checker-script` `stash@{1}` (titled "On main: pre-factor-phase-1 working state", captured 2026-04-23) and ship it upstream as a benchmark-expansion PR — minimal diff, every new row validated by a human reviewer.

## Approach we tried

1. Created an isolated worktree at `.worktrees/ccs-csv-only-pr/` on a fresh branch `csv-only-expansion` off `origin/main`.
2. Copied just the seed CSV from `stash@{1}` (`git show stash@{1}:Benchmarking_data_Citations.csv > Benchmarking_data_Citations.csv`) — 226 lines, +148 over the post-#140 origin/main baseline.
3. Ran `npm run extract` against the new CSV → 225-row `dataset.json` in upstream's pre-source-availability schema (no `source_availability`, no `observed_fetch`). Took ~14 minutes for the Wikipedia + source-URL fetches.
4. Built a single-page HTML review report (`benchmark/generate-review-html.js`) that classifies each row by review priority and lets a human walk through them in a browser. See "Reusable artifacts" below.
5. Started a `review_changes.md` log to track every reviewed row (`confirm` / `flip` / `drop` actions) so the final PR could be filtered to "only rows the human put eyes on."
6. Got 7 rows reviewed (2 confirmed, 4 flipped, 1 dropped) before pivoting.

## Why we deferred

The new path is **"quick-and-dirty commit of the most reliable bits of the WMF source-verification dataset, so we can do simple regression testing on substantive changes."** That's a different target:

| Dimension | Manual-review path (this doc) | WMF-reliable-subset path (chosen) |
|-----------|-------------------------------|-----------------------------------|
| Data source | Held-back stash CSV (115 negative-class rows) | WMF source-verification dataset (already 99 rows ingested in Phase 6, plus more available) |
| Quality bar | Every new row hand-validated against source | Filter to rows where annotators were confident; trust their work |
| Audience | Upstream PR (Alex's reviewers) | Local regression suite (us) |
| Per-row cost | 2–3 min reviewer time | ~zero, programmatic filter |
| Estimated time-to-useful-output | ~5 hours (119 rows × ~2.5 min) | ~30 minutes |
| Suitable for upstream PR | Yes — it's a clean v3 expansion | Maybe — depends on whether Alex wants WMF-derived rows |

The pivot says: for our current need (testing main.js / prompt / provider changes for regressions), we don't need every row hand-validated. We need *enough* high-confidence rows to detect a real accuracy drop. The WMF dataset already ships with annotator confidence signals; we can filter on those.

## Reusable artifacts (still in `.worktrees/ccs-csv-only-pr/`)

These survived the pivot and are valuable for any future review pass — including the deferred resumption of this design:

### 1. `benchmark/generate-review-html.js` — single-page HTML review report

Self-contained Node script. Reads `benchmark/dataset.json`, compares row keys against `git show origin/main:Benchmarking_data_Citations.csv` to identify what's new vs pre-existing, writes `benchmark/review.html`. ~250 lines. Features that turned out to be useful:

- **Status taxonomy**: each row gets a badge — `both` (new + extraction issue, highest priority), `extraction` (pre-existing row newly failing extraction), `new` (new row, verdict spot-check needed), `ok` (pre-existing, clean).
- **Filterable client-side** — buttons at the top narrow to one badge.
- **Article links use HTML Text Fragments** (`#:~:text=startText,endText`) so the browser scrolls to and highlights the claim text on page load. Spec: <https://wicg.github.io/scroll-to-text-fragment/>. Browsers w/o support fall back to plain article load.
- **Archive-URL fallback per row** (`https://web.archive.org/web/<year>/<sourceUrl>`) — Wayback redirects to the closest snapshot. Year approximated from the article's oldid range. Saves the reviewer when the live source 404s or blocks automation (Instagram, Bilibili, NYT, etc.). No API call at HTML-generation time.
- **Verdict color-coded** — green Supported, red Not supported, orange Partially supported, gray Source unavailable.
- **Header summary** — "X total rows · Y already in origin/main · Z new in this PR · W need review attention."

### 2. `review_changes.md` — running review log

Single-file Markdown table tracking each reviewed row. Columns: `Date | Row ID | Article | Cite# (occ) | Action | Original → New | Notes`. Action codes: `confirm` (verdict OK), `flip` (verdict changed), `drop` (exclude from PR — source unverifiable, content invalid, etc.).

The "PR-filter logic" section at the bottom describes how to filter `Benchmarking_data_Citations.csv` and `dataset.json` to "only reviewed rows" before final commit.

### 3. The "minimum PR" pattern — worktree off `origin/main`

Cleanest way to produce a small, focused PR when the working main has accumulated unrelated work: branch off `origin/main` (not local main), copy in just the files the PR should touch, run upstream's tooling against them. Eliminates the "schema bloat" risk of producing a PR that includes both the intended change and the local-main divergence.

## Resumption conditions

Worth picking back up when:

1. **A community-platform mini-game/queue tool gets built** (per the WMF Toolforge brainstorm earlier in the same session) — at that point, the `review_changes.md` schema becomes the data model for what the tool collects, and the HTML report's structure becomes the per-row view template.
2. **An upstream maintainer requests a full review pass** of the held-back stash content — this design is the recipe for executing that request.
3. **The WMF-reliable-subset path produces enough regression coverage** that we can return to upstream-PR-shaped contributions with a different curation pile.

## Files involved (snapshot at deferral)

- `.worktrees/ccs-csv-only-pr/Benchmarking_data_Citations.csv` — 226-row CSV (modified for 4 row flips during review)
- `.worktrees/ccs-csv-only-pr/benchmark/dataset.json` — 225-row dataset.json (modified for 4 ground_truth flips + 1 needs_manual_review flag)
- `.worktrees/ccs-csv-only-pr/benchmark/generate-review-html.js` — review tool source
- `.worktrees/ccs-csv-only-pr/benchmark/review.html` — generated report
- `.worktrees/ccs-csv-only-pr/review_changes.md` — running log (7 rows reviewed)
- `.worktrees/ccs-csv-only-pr/benchmark/dataset_review.csv` — extractor side-output flagging 41 rows with `needs_manual_review`

The `csv-only-expansion` branch has one commit: `15ce0ba benchmark: expand dataset with 148 additional citation rows`. The 4 in-progress edits are in the working tree, uncommitted.

## Cross-references

- `open-issues.md` item 20 (workspace root) — describes the held-back stash provenance and review path
- `Projects/.../citation-checker-script/CLAUDE.md` — sub-repo state (this doc lives there)
- Memory: `feedback_curation_review.md` — bulk curation needs human spot-review before integration; default to document-and-defer (this doc is the document)
