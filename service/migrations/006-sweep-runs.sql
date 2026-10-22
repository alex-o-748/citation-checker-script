-- One row per sweep, so runs can be compared over time, plus the run id on
-- every finding, so a finding can be traced back to the run that wrote it.
--
-- Before this, a run's numbers lived only in its job log and in the
-- -checks.json beside its CSV, and nothing in citation_findings said which
-- run a row came from: "what did last Monday's batch produce" could only be
-- pieced together from created_at. service/run-sweep.js writes a sweep_runs
-- row when a run starts (status 'running') and fills it in when the run ends.
-- A row still 'running' long after started_at is a run that was killed (job
-- timeout, OOM) before it could finish its record.
--
-- Apply by hand on the bastion after 003-005, BEFORE deploying the code that
-- writes run_id. Unlike 003-005, a sweep refuses to start against a table
-- without these columns rather than failing every write:
--
--   mariadb --defaults-file=$HOME/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--       s57953__source_verifier < service/migrations/006-sweep-runs.sql
--
-- Most columns are copied from the post-run checks' metrics, which count the
-- whole CSV (so a --resume'd run is counted once, not per process). The
-- funnel, timing, retry and ToolsDB-write counters are for the last process
-- only; they are kept in `details` (JSON) rather than as columns, since they
-- are for reading one run, not for comparing many. See service/sweep-runs.js.
--
-- started_at / finished_at are declared NULL explicitly: a first TIMESTAMP
-- column without it gets ON UPDATE CURRENT_TIMESTAMP when
-- explicit_defaults_for_timestamp is off, which would rewrite started_at on
-- the finishing UPDATE.

CREATE TABLE sweep_runs (
  run_id              VARBINARY(64)   NOT NULL PRIMARY KEY,
  series              VARBINARY(64)   NULL,      -- scheduled job name, e.g. 'ruwiki-weekly'; NULL for a hand-started run
  wiki                VARBINARY(32)   NOT NULL,
  status              VARBINARY(16)   NOT NULL,  -- running | ok | checks_failed | halted | failed | pick_failed
  exit_code           TINYINT         NULL,
  started_at          TIMESTAMP       NULL,
  finished_at         TIMESTAMP       NULL,
  provider            VARBINARY(32)   NULL,
  model               VARBINARY(128)  NULL,
  prompt_version      VARBINARY(32)   NULL,
  code_version        VARBINARY(40)   NULL,      -- git commit the run's code was at
  selection           TEXT            NULL,      -- the titles file, or the Wiki Replicas criterion
  out_path            TEXT            NULL,
  articles_planned    INT             NULL,
  articles            INT             NULL,      -- articles with at least one row
  rows_total          INT             NULL,
  model_rows          INT             NULL,
  supported           INT             NULL,
  partially_supported INT             NULL,
  not_supported       INT             NULL,
  source_unavailable  INT             NULL,
  error_rows          INT             NULL,
  skipped_rows        INT             NULL,
  citations_with_url  INT             NULL,
  fetched             INT             NULL,
  fetch_failed        INT             NULL,
  our_fetch_failed    INT             NULL,      -- failures of our own fetcher, not the publisher
  truncated           INT             NULL,
  tokens_in           BIGINT          NULL,
  tokens_out          BIGINT          NULL,
  checks_status       VARBINARY(8)    NULL,      -- pass | warn | fail; NULL when checks didn't run
  checks_flagged      TEXT            NULL,      -- ids of checks that warned or failed, e.g. 'fail:coverage warn:errors'
  details             MEDIUMTEXT      NULL,      -- JSON: funnel, timing, retries, store stats, every check
  KEY idx_wiki_started (wiki, started_at),
  KEY idx_series_started (series, started_at)
);

ALTER TABLE citation_findings
  ADD COLUMN run_id VARBINARY(64) NULL,
  ADD KEY idx_run (run_id);
