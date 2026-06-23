# Collective verification of adjacent citation groups

> **Status (2026-06-23):** In progress on branch `claude/wizardly-heisenberg-ll278o`. Batch-report scope only; single-click and benchmark coverage deferred.

## Problem

Wikipedia editors routinely back a single claim with several adjacent citations
— `The treaty was signed in Paris in 1990.[1][2]` — where each source supports
*part* of the claim and only the combination supports the whole. The tool
already **detects** these adjacent runs (`getCitationGroup` / `hasTextBetween`
in `core/claim.js`) and renders them as group blocks, but it still **verifies
each source in isolation** against the full claim. The result is misleading:
`[1]` (which only gives the year) and `[2]` (which only gives the place) each
come back "partially supported" or "not supported," when together they fully
support the claim.

## Goal

Add a single **collective verdict** per adjacent group: assemble all of the
group's sources into one labeled blob and ask the LLM whether they support the
claim *together*. Solo citations are unchanged.

## Decisions (chosen by the maintainer)

1. **Output model — collective *and* individual.** A group of N produces N
   per-source calls (unchanged) **plus** one collective call (N+1 total). The
   collective verdict is the headline; the per-source verdicts are retained in
   the panel as debug detail ("maybe I'll remove them later").
2. **Pills/filters keyed to the collective verdict.** The summary chips and
   filter visibility count **one verdict per group** (its collective verdict)
   plus one per solo citation. The individual per-source rows do not feed the
   pills; toggling a chip shows/hides the whole group block by its collective
   verdict. Rows stay visible inside a shown group.
3. **Scope — batch report only.** The "Verify all citations" report, where the
   group infrastructure already lives. The single-citation click flow still
   verifies only the clicked source (group indicator stays informational).
4. **Benchmark deferred.** Shipped with `node:test` unit tests for the new pure
   logic; a grouped benchmark dataset/harness is a follow-up.

## Design

### Pure logic (`core/prompts.js`, synced into `main.js`)

- `extractSourceText(sourceInfo)` — factored out of `generateUserPrompt` so the
  single-source and multi-source paths strip the `Source Content:` / `Manual
  source text:` framing identically. `generateUserPrompt` output is unchanged.
- `assembleGroupSources(entries)` — labels each source (`Source [1] (url):` …),
  keeps unavailable sources in place with a `[This source could not be
  retrieved: …]` note (so the model can reason about partial coverage), and
  reports `anyAvailable`. Callers dedupe sources shared by named refs, merging
  their citation numbers onto one label.
- `generateGroupSystemPrompt()` — a **new** prompt (so the single-source
  benchmark, which uses `generateSystemPrompt`, is untouched). Same JSON schema,
  verdict vocabulary, confidence scale, and `reason_type` rules; the additions
  are the "evaluate TOGETHER / no single source need cover the whole claim"
  framing, partial-availability handling, and three multi-source few-shot
  examples (collective support, one-source-unavailable, partial coverage).
- `generateGroupUserPrompt(claim, assembledText)`.

### Orchestration (`main.js`, `verifyAllCitations`)

The per-source loop is unchanged. When a citation closes a multi-citation group
(`groupIndex === groupSize - 1`), `verifyGroupCollective` runs: it reads each
member's already-cached source (group members are contiguous and processed in
order, so the cache is warm), dedupes by cache key, assembles, and makes one
`callProviderAPIGroup` call wrapped in the same `withRetry` + rate-limit machinery
as the per-source path. All sources unavailable → `SOURCE UNAVAILABLE` with no
LLM call. Collective results live in `this.reportGroupResults` (keyed by
`groupId`), separate from the per-source `reportResults`.

`getReportUnits()` merges the two into one entry per claim (solo results pass
through; groups collapse to their collective verdict) in document order. The
summary counts and both exporters iterate units, so a group counts once.

### Rendering

`buildGroupBlock` gains a collective-verdict slot (pending → filled by
`renderGroupCollectiveResult`, which also tags the block with
`data-collective-verdict` for filtering) and an "Individual sources" label above
the retained per-source rows. `applyReportFilters` now hides a group block by
its collective verdict rather than by "any row matches." Wikitext/plaintext
exports render one combined row per group (members linked, sources listed).

## Alternatives considered

- **Collective-only (drop individual verdicts).** Briefly chosen, then reversed:
  the maintainer wants the individual verdicts visible in the panel for
  debugging. Kept as a likely future simplification (delete the per-source rows
  and the N per-source calls, leaving 1 call per group).
- **Reuse `generateSystemPrompt` with a concatenated multi-source body.** Risks
  the single-source prompt's strict-in-isolation framing bleeding into group
  judgments. A dedicated prompt isolates the change and keeps the existing
  benchmark fixed.
- **One call returning per-source attribution (structured sub-rows).** More
  schema/parser surface; deferred in favor of the simpler N + 1 model the
  maintainer picked.

## Known limitations (follow-ups)

- No per-source token **budget** when combining; a large group could approach
  the context window (each member is already individually truncated; the
  collective result is flagged `truncated` if any member was). 
- Collective verdicts are **not** sent to the `/log` endpoint (its schema is
  single-URL).
- Manual-source-only groups (Google Books / no URL) can't be collectively
  fetched in the report; such members appear labeled-unavailable.
- Single-citation click flow and a grouped benchmark remain out of scope.

## Tests

`tests/prompts.test.js` covers `extractSourceText` (incl. parity with the old
`generateUserPrompt` behavior), `assembleGroupSources` (labeling, unavailable
reasons, `anyAvailable`, shared-ref merging, whitespace-only content),
`generateGroupSystemPrompt`, and `generateGroupUserPrompt`. The `main.js`
orchestration (DOM/instance-bound) follows the existing convention of not being
unit-tested directly.
