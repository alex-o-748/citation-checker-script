-- citation_number holds every member's number on a collective row, joined
-- with ", " (service/finding-builder.js's assembleGroupFinding), so a long
-- adjacent-citation group overflows any fixed width. 003 widened INT to
-- VARCHAR(64); the en-evergreen-500 backfill (2026-10) still rejected 9 rows
-- with "Data too long for column 'citation_number'". The column is display
-- only and not part of uniq_finding, so it can be TEXT.
--
-- Apply by hand on the bastion after 003 and 004:
--
--   mariadb --defaults-file=$HOME/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--       s57953__source_verifier < service/migrations/005-citation-number-text.sql

ALTER TABLE citation_findings
  MODIFY COLUMN citation_number TEXT NULL;
