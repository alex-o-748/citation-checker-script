-- Prepares citation_findings for run-sweep.js storing every finding by
-- default (2026-10). Apply by hand on the bastion, like 001-003:
--
--   mariadb --defaults-file=$HOME/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--       s57953__source_verifier < service/migrations/004-store-by-default.sql
--
-- before the first sweep or import that writes to this table.
--
-- 1. reason_type was VARBINARY(16); the batch pipeline writes
--    output_budget_exhausted (23 bytes), empty_model_response (20) and
--    retries_exhausted (17). Strict mode rejects those rows outright.
-- 2. group_id was VARBINARY(64); a group id is the first marker's HTML id,
--    which carries the ref name — ruwiki names are Cyrillic (two bytes per
--    letter), e.g. cite_ref-автоссылка2_231-0, and run out of 64 bytes.
-- 3. provider is part of uniq_finding but was NULL whenever no model ran
--    (SOURCE UNAVAILABLE, SKIPPED). MariaDB never treats two NULLs as equal
--    in a unique key, so every re-store of such a row (a --resume, a re-import
--    of a CSV) inserted a duplicate instead of updating. findings-store.js
--    now writes '' for "no model ran"; existing NULLs are converted first.

ALTER TABLE citation_findings
  MODIFY COLUMN reason_type VARBINARY(32) NULL,
  MODIFY COLUMN group_id VARBINARY(255) NULL;

UPDATE citation_findings SET provider = '' WHERE provider IS NULL;

ALTER TABLE citation_findings
  MODIFY COLUMN provider VARBINARY(32) NOT NULL DEFAULT '';
