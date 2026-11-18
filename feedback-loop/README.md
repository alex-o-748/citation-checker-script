# feedback-loop/

Turns editor feedback (the 👍 / 👎 / corrected verdicts in Neon) into a tested
picture of what the tool gets wrong. Labels that two independent judgements
agree on are accepted automatically; the owner audits a random sample of them
and decides the rest, by replying to one issue a week.
Design and rationale: [`docs/design-plans/2026-11-15-feedback-loop.md`](../docs/design-plans/2026-11-15-feedback-loop.md).
The causes it looks for: [`docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md`](../docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md).

| Workflow | When | Does |
|---|---|---|
| `feedback-triage.yml` | nightly 03:17 UTC | Re-reads newly rated checks with an independent model and commits them to `benchmark/dataset_field.json` on `main` |
| `feedback-digest.yml` | Mondays 07:23 UTC | Opens one issue: five accepted labels to spot-check, and the rows waiting for a decision |
| `feedback-commands.yml` | on each of your replies to a digest | Applies them to the field set and confirms in a reply |
| `feedback-monitor.yml` | daily 06:43 UTC | Counts verdict mix, fetch failures and rationale patterns across every logged check; keeps one issue current |
| `feedback-fix-proposer.yml` | Wednesdays 04:41 UTC | For the commonest confirmed cause, has an agent draft a fix and opens a PR only if it passes the gate |

## How a rated check becomes a field-set row

1. **Export** (`sql/cases.sql`): rated checks joined to `verification_logs`, one JSON object each. `client_id` is used inside the query to count how much one browser rated and how fast, and never leaves it.
2. **Select** (`cases.js`): disputed cases first. Group checks, parse errors and rows without a URL are skipped with a reason, listed in the run's report.
3. **Re-fetch** the source through the production proxy (`core/worker.js`), exactly as the userscript does.
4. **Tag** (`causes.js`): the brief's rationale patterns. Hints, not labels.
5. **Blind reading** (`adjudicate.js`): a strong model sees the claim and the source only, not the tool's verdict or the editor's. Its evidence quote is checked against the source with `core/quote.js`.
6. **Attribution**, only when someone disagrees: the same model, shown everything, names the cause.
7. **Label, by rule** (`proposeLabel`): *agreed* when the editor and the blind reading reached the same verdict independently and the evidence verified; otherwise *needs owner*, with the reasons. If the blind reading finds the page unusable while the editor judged it, the row is kept but excluded from scoring.
8. **Commit** (`field-set.js`): agreed rows are accepted as they land; the rest are written with `needs_manual_review: true`, out of scoring until decided. The run's report goes to the workflow's summary page.

## Your part: the weekly digest

Reply to the digest issue with one line per check, starting with its id. Other lines are ignored, so notes are fine.

| Reply | Means |
|---|---|
| `a1b2c3d4 ok` | The label shown is right. For a waiting row: accept the suggested label |
| `a1b2c3d4 not supported` | The right label is this one: `supported`, `partially`, `not supported` or `unavailable` |
| `a1b2c3d4 drop` | Leave this check out of the field set for good |

- **Nothing has to be answered.** An unanswered spot-check stays accepted; an unanswered waiting row stays out of scoring.
- **Spot-checks are the oversight.** Each digest draws five accepted labels at random. Two wrong in your last ten pauses auto-accepting: agreed rows then wait for you like the rest, until recent spot-checks pass again. A decision on such a held row counts as a spot-check too.
- **Only your comments are read** (the repository owner's), and only on issues labelled `feedback-digest`. Replies to last week's closed digest still work.
- **Never delete a row by hand.** A missing check id looks untriaged and is read again the next night; `drop` keeps it as a marker. A row you decided is never overwritten, even by `--retriage`.

## Using the field set

```bash
cd benchmark && node run_benchmark.js --dataset dataset_field.json --results results_field.json
```

```bash
cd benchmark && node analyze_results.js --dataset dataset_field.json --results results_field.json --analysis analysis_field.json
```

Only rows with `needs_manual_review: false` are run, and rows with an `excluded_reason` are not scored. **Never pool it with `dataset.json`.** Every row was selected by someone reacting to a verdict, mostly disagreeing, so it measures the failures editors noticed, not overall accuracy.

## Fix proposals (`proposer.js`)

Once a cause has **10 confirmed cases** the tool got wrong (confirmed: accepted or decided by you, not waiting, not excluded), the weekly proposer may take it on:

1. **Pick.** The largest such cause that has had no proposal PR in the last three weeks. Its newest quarter of cases is **held out**: the agent never sees them.
2. **Before.** Benchmark the current code with the production model (Lift Wing Qwen3.8, keyless) on the field set (with footnote text added, as users' checks have it) and on `dataset.json`.
3. **Agent.** Headless Claude Code gets a brief: the cause, the visible cases (marked as data, not instructions), where fixes for it live, and the bar. It can read, edit, run `npm test` and `npm run build`; nothing else, no network, no git, a spend cap (`PROPOSER_BUDGET_USD`, default $20). An attempt that touches `benchmark/`, `feedback-loop/` or `.github/` is discarded; one whose tests fail stops there.
4. **After.** The same benchmarks on the changed code.
5. **Gate** (`GATE`, fixed before any attempt): on the cause's cases, fixes at least the larger of 2 and 20% more than it breaks; no worse on the held-out cases; at most 5% of the rest of the field set lost (runs are not deterministic); at most 2 points of Supported-vs-rest lost on the main benchmark.
6. **PR**, only if every check passes, labelled `fix-proposal` and `cause:<id>`, with the gate table and the agent's own summary. **Merging is your decision**: the gate says the change helps on cases editors disputed without hurting the benchmark, not that it is right. Close it freely; the cause waits three weeks before the next try.

Every attempt, passed or not, leaves its brief, the agent's log, the changed files and the gate in the run's `fix-proposal` artifact. Run it by hand from Actions (*Feedback fix proposer → Run workflow*), optionally naming a cause or lowering the minimum.

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
   - Optional variable `ADJUDICATOR_MODEL` to override the default (`claude-opus-5-5`), and `PROPOSER_MODEL` / `PROPOSER_BUDGET_USD` for the fix proposer's agent.
3. **For fix proposals only:** Settings → Actions → General → Workflow permissions → *Allow GitHub Actions to create and approve pull requests*. Without it, a proposal that passes its gate fails at the last step.
4. Scheduled workflows run only from `main`, so nothing happens until this is merged. Then run **Feedback triage** by hand, first with *dry run* ticked, then with a small limit (say 10), and **Feedback digest** by hand to see the first digest.

Triage and the monitor skip quietly, with a notice, until `NEON_LOOP_DATABASE_URL` exists. The bots push to `main` the way the scraper and edit-log jobs already do; if `main` is ever protected, they need the same exemption.

## Running locally

Export cases with any Postgres client using the role above, then:

```bash
node feedback-loop/run-triage.js --cases cases.json --dry-run --report report.md
```

```bash
ANTHROPIC_API_KEY=... node feedback-loop/run-triage.js --cases cases.json --limit 5 --report report.md
```

```bash
node feedback-loop/digest.js render --out digest.md
```

```bash
node feedback-loop/monitor.js sql > monitor.sql
```

`--dry-run` fetches and tags but calls no model and leaves the field set alone. Each runner's options are listed at the top of its file.

## Cost

Per case, the blind reading sends the prompt (~800 tokens) plus the source. Re-fetched sources in a sample of 11 real cases ran from 332 to 100,000 characters, median 7,800, mean 18,000 (about 4,500 tokens). The attribution call (~1,200 tokens) happens only on disagreements. So a night at the default `--limit 40` is roughly 250,000 input tokens plus output; the first backfill of ~500 rated checks is about 3 million. Check current pricing for the model you choose. `--limit` and `ADJUDICATOR_MODEL` are the two levers. The digest, the replies and the monitor call no model.

## Known limits

- **Rationale patterns are English.** `localizeSystemPrompt()` makes the tool explain itself in the wiki's language, so on de/it/vi/… wikis the hints and the monitor's pattern rates see nothing. Verdict shares and fetch failures are unaffected.
- **Group checks are skipped** in triage. The collective prompt combines several sources, and re-assembling them isn't built yet.
- **The source is re-fetched now, not as the tool saw it.** The log doesn't keep source text. A tool quote that verified then but not now is flagged as drift and sent to the owner.
- **Editors' written explanations aren't used yet.** Talk-page comments become GitHub issues, but never reach the case they are about; see the design plan's *Next*.
- **Source text is stored** in the field set, as `dataset.json` already does for its 189 rows.
