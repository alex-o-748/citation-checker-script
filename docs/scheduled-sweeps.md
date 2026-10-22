# Scheduled sweeps

How the batch pipeline runs on a schedule, starting with a weekly ruwiki series.
It covers what a run does, what to check before the first one, and where to look afterwards.

## What a run does

`service/run-scheduled.js` is the one command the cron job runs (`service/jobs.yaml`):

```
take the lock -> run-pick-pilot.js -> run-sweep.js --live-source-fetch -> run-trends.js -> release the lock
```

- **Pick.** `run-pick-pilot.js` chooses `--max` articles (default 25) and leaves out every article that ToolsDB already holds findings for. That exclusion is how consecutive runs cover new ground without a per-batch exclude list.
- **Sweep.** `run-sweep.js` checks every citation in those articles. It stores each finding in ToolsDB and records the run in `sweep_runs`.
- **Trends.** `run-trends.js` prints how this run compares with the previous runs of its series. The report goes into the run's log and never changes the exit code.
- **Lock.** The Toolforge jobs framework documents nothing that stops a scheduled job from starting while its previous run is still going. Two overlapping runs would pick the same articles, so a second run exits 6 instead. A lock older than `--lock-stale-hours` (24) belongs to a killed run and is taken over.

Each run gets its own directory, `~/sweeps/<wiki>/<run-id>/`:

| File | What it is |
|---|---|
| `titles.txt`, `scores.json` | The pick: which articles, and each one's score breakdown |
| `findings.csv`, `findings-clean.csv` | Every finding, and the cleaned copy |
| `findings-checks.md`, `findings-checks.json`, `findings-review.csv` | The post-run checks, and the rows worth reading |
| `findings-run.json` | The run record, the same one stored in ToolsDB's `sweep_runs` |
| `run.log` | The whole run's output |

The run id, for example `ruwiki-20261027T031700Z-3f9a`, is the directory name, the `run_id` column on every finding (CSV and ToolsDB), and the key of the run's `sweep_runs` row.

## Before the first scheduled run

1. **Apply migrations 003–006** (`service/migrations/`) on the bastion, in order, as each file's header shows.
   006 adds `sweep_runs` and `citation_findings.run_id`. A storing sweep now refuses to start without it, rather than failing every write for hours.
2. **Import the earlier ruwiki batches** with `service/run-import-findings.js` if they never reached ToolsDB.
   Otherwise the first pick re-checks them. To check, run `SELECT COUNT(DISTINCT page_id) FROM citation_findings WHERE wiki = 'ruwiki'` and compare the result with the number of articles those batches covered.
3. **Confirm the model.** `jobs.yaml` pins `--provider liftwing-safeguard`, which is what the 2026-10 ruwiki batches used and what the checks' ERROR thresholds were calibrated on.
   `run-sweep.js`'s default (`liftwing`) moved to Qwen3.8 on 2026-10-21. To switch the series to a different model, change it here. Trends will show the switch, and drift comparison restarts from it.
4. **Deploy:** `webservice node18 shell`, then `cd ~/citation-checker-script && git pull && npm install`.
5. **Trial run**, one-off and small, under its own series so it stays out of the weekly trends:
   ```bash
   toolforge jobs run sweep-trial --image node18 --mem 2Gi --wait \
       --command "./citation-checker-script/service/run-scheduled.js --wiki ruwiki --provider liftwing-safeguard --series ruwiki-trial --max 3"
   ```
   Then read `~/sweeps/ruwiki/<run-id>/run.log`, and confirm the run's row exists: `SELECT * FROM sweep_runs ORDER BY started_at DESC LIMIT 1`.
   The trial's findings are real and get stored, so those 3 articles count as checked.
6. **Load the job by name**, after backing up what's defined. `toolforge jobs load` can replace jobs that aren't in the file:
   ```bash
   toolforge jobs dump -f jobs-backup.yaml
   toolforge jobs load citation-checker-script/service/jobs.yaml --job ruwiki-weekly
   toolforge jobs list
   ```

## When an email arrives

`emails: onfailure` mails the tool's maintainers whenever a run exits non-zero. Each run's own `run.log` says why. The job's `ruwiki-weekly.out` / `.err` in the tool home collect every run's output too, and they grow until rotated.

| Exit | Meaning | Look at |
|---|---|---|
| 1 | Pick or sweep failed outright: Wiki Replicas, ToolsDB or REST unreachable. **Also "nothing left to pick"**, which the record shows as `pick_failed` | `run.log` |
| 3 | The model returned an auth/billing error | `run.log`; the findings computed before the halt are kept |
| 4 | The model service kept failing | Same as 3 |
| 5 | The sweep finished, but a post-run check failed | `findings-checks.md`, then `findings-review.csv` |
| 6 | The previous run still holds the lock | Whether a run is overrunning the schedule, or hung |

## Reading runs over time

```bash
node service/run-trends.js --wiki ruwiki --series ruwiki-weekly            # from ToolsDB
node service/run-trends.js --wiki ruwiki --from-dir ~/sweeps --limit 20    # from the -run.json files
```

This shows one line per run: flag and NOT SUPPORTED shares of judged verdicts, SOURCE UNAVAILABLE and ERROR shares of rows, fetch failures (all causes and our own fetcher's), truncation, tokens per article, and duration.
It then compares the latest run with the median of up to five earlier runs that finished `ok` on the same model and prompt version. A rate 10 or more points away is reported as drift.
That threshold is a first guess. At 25 articles a run, rates move several points on noise alone, so recalibrate it once the series has a couple of months of runs.

Directly in ToolsDB:

```sql
-- the last ten runs, with the two rates most likely to move
SELECT run_id, status, started_at, articles, rows_total,
       ROUND((partially_supported + not_supported)
             / NULLIF(supported + partially_supported + not_supported, 0) * 100, 1) AS flag_pct,
       ROUND(fetch_failed / NULLIF(citations_with_url, 0) * 100, 1) AS fetch_fail_pct,
       tokens_in + tokens_out AS tokens, checks_status, checks_flagged
FROM sweep_runs WHERE wiki = 'ruwiki' ORDER BY started_at DESC LIMIT 10;

-- runs that never finished (killed by the job timeout or an OOM)
SELECT run_id, started_at FROM sweep_runs
WHERE status = 'running' AND started_at < NOW() - INTERVAL 1 DAY;

-- what one run found
SELECT verdict, COUNT(*) FROM citation_findings WHERE run_id = 'ruwiki-20261027T031700Z-3f9a' GROUP BY verdict;
```

Whole-CSV counts in `sweep_runs` come from the post-run checks, so a run made with `--skip-checks` has them empty.
Per-process numbers (the funnel, timing, retries, ToolsDB write failures) are in its `details` JSON.

## What this does not cover yet

- **Delivery and review.** Nothing sends a batch to reviewers or reads their verdicts back. Each run's `findings-clean.csv` is what to share; `check_id` and `run_id` identify a row.
- **Re-checking.** An article is never picked twice, and nothing acts on `expires_at`. Coverage only grows.
- **ruwiki-specific selection.** The event-title filter (`EVENT_TITLE_PATTERNS`) is English-only, and the BLP quota has no ruwiki category, so neither does anything on a ruwiki pick.
- **Alerting on drift.** Trends are a report, so nothing emails on drift until the thresholds have data behind them.
