# feedback-loop/

Turns editor feedback (the 👍 / 👎 / corrected verdicts in Neon) into a tested
picture of what the tool gets wrong, with the owner approving every label.
Design and rationale: [`docs/design-plans/2026-11-15-feedback-loop.md`](../docs/design-plans/2026-11-15-feedback-loop.md).
The causes it looks for: [`docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md`](../docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md).

Two jobs run on GitHub Actions:

| Workflow | When | Does | Output |
|---|---|---|---|
| `feedback-triage.yml` | nightly 03:17 UTC | Re-reads newly rated checks with an independent model and proposes labels | One PR; **merging it confirms the labels** |
| `feedback-monitor.yml` | daily 06:43 UTC | Counts verdict mix, fetch failures and rationale patterns across every logged check | One issue, updated in place; a comment when the alerts change |

## How a rated check becomes a field-set row

1. **Export** (`sql/cases.sql`): rated checks joined to `verification_logs`, one JSON object each. `client_id` is used inside the query to count how much one browser rated and how fast, and never leaves it.
2. **Select** (`cases.js`): disputed cases first. Group checks, parse errors and rows without a URL are skipped with a reason, listed in the report.
3. **Re-fetch** the source through the production proxy (`core/worker.js`), exactly as the userscript does.
4. **Tag** (`causes.js`): the brief's rationale patterns. Hints, not labels.
5. **Blind reading** (`adjudicate.js`): a strong model sees the claim and the source only, not the tool's verdict or the editor's. Its evidence quote is checked against the source with `core/quote.js`.
6. **Attribution**, only when someone disagrees: the same model, shown everything, names the cause.
7. **Label, by rule** (`proposeLabel`): *agreed* when the editor and the blind reading reached the same verdict independently and the evidence verified; otherwise *needs owner*, with the reasons. If the blind reading finds the page unusable while the editor judged it, the row is kept but excluded from scoring.
8. **Merge** (`field-set.js`) into `benchmark/dataset_field.json` and write `reports/triage-<date>.md`.

## Reviewing a triage PR

- **Merge to accept the agreed rows.**
- Rows that need you have `"needs_manual_review": true` and a suggested `ground_truth`. To accept, set it to `false`. To relabel, change `ground_truth` too. To drop, delete the row.
- A row you edited is never overwritten by a later run, even with `--retriage`.
- The PR grows nightly until merged: each run builds on the open PR, so nothing is triaged (or paid for) twice.

## Using the field set

```bash
cd benchmark && node run_benchmark.js --dataset dataset_field.json --results results_field.json
```

```bash
cd benchmark && node analyze_results.js --dataset dataset_field.json --results results_field.json --analysis analysis_field.json
```

Only rows with `needs_manual_review: false` are run, and rows with an `excluded_reason` are not scored. **Never pool it with `dataset.json`.** Every row was selected by someone reacting to a verdict, mostly disagreeing, so it measures the failures editors noticed, not overall accuracy.

## Setup (once)

1. **A read-only database role.** Create it in the Neon SQL editor, not under Roles in the console: console-created roles join `neon_superuser`, which can write. Then grant it only what the loop reads:
   ```sql
   CREATE ROLE loop_reader WITH LOGIN PASSWORD 'a-long-random-password';
   GRANT USAGE ON SCHEMA public TO loop_reader;
   GRANT SELECT ON feedback, verification_logs TO loop_reader;
   ```
   Its connection string is the project's own (Neon console → Connect) with `loop_reader` and that password in place of the owner's.
2. **Repository secrets** (Settings → Secrets and variables → Actions):
   - `NEON_LOOP_DATABASE_URL`: that connection string.
   - `ANTHROPIC_API_KEY`: already set for the talk-page scraper.
   - Optional variable `ADJUDICATOR_MODEL` to override the default (`claude-opus-5-5`).
3. **Let Actions open PRs:** Settings → Actions → General → Workflow permissions → *Allow GitHub Actions to create and approve pull requests*.
4. Scheduled workflows run only from `main`, so nothing happens until this is merged. Then run **Feedback triage** by hand: first with *dry run* ticked, then with a small limit (say 10) to see a first PR.

Both workflows skip quietly, with a notice, until `NEON_LOOP_DATABASE_URL` exists.

## Running locally

Export cases with any Postgres client using the role above, then:

```bash
node feedback-loop/run-triage.js --cases cases.json --dry-run
```

```bash
ANTHROPIC_API_KEY=... node feedback-loop/run-triage.js --cases cases.json --limit 5
```

```bash
node feedback-loop/monitor.js sql > monitor.sql
```

`--dry-run` fetches and tags but calls no model and leaves the field set alone. Each runner's options are listed at the top of its file.

## Cost

Per case, the blind reading sends the prompt (~800 tokens) plus the source. Re-fetched sources in a sample of 11 real cases ran from 332 to 100,000 characters, median 7,800, mean 18,000 (about 4,500 tokens). The attribution call (~1,200 tokens) happens only on disagreements. So a night at the default `--limit 40` is roughly 250,000 input tokens plus output; the first backfill of ~500 rated checks is about 3 million. Check current pricing for the model you choose. `--limit` and `ADJUDICATOR_MODEL` are the two levers.

## Known limits

- **Rationale patterns are English.** `localizeSystemPrompt()` makes the tool explain itself in the wiki's language, so on de/it/vi/… wikis the hints and the monitor's pattern rates see nothing. Verdict shares and fetch failures are unaffected.
- **Group checks are skipped** in triage. The collective prompt combines several sources, and re-assembling them isn't built yet.
- **The source is re-fetched now, not as the tool saw it.** The log doesn't keep source text. A tool quote that verified then but not now is flagged as drift and sent to the owner.
- **Source text is stored** in the field set, as `dataset.json` already does for its 189 rows.
