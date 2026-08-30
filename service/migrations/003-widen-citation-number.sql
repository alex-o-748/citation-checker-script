-- Widens citation_number to hold a collective finding's joined member list
-- ("5, 6"), not just a single citation number.
--
-- 001 typed citation_number INT because at the time every row was a solo
-- citation. is_collective existed from the start but nothing ever wrote a
-- collective row until docs/design-plans/
-- 2026-08-24-csv-deliverable-and-component-names.md's G1 (the sweep runner):
-- service/finding-builder.js's assembleGroupFinding() sets citationNumber to
-- the group's member numbers joined by ", " (matching main.js's
-- verifyGroupCollective(), "citationNumber: groupCitationNumbers.join(', ')"),
-- which does not fit an INT column. Caught before any collective row was
-- ever written against the real table, so no backfill is needed here.
--
-- citation_number stays "display only; NOT an identifier" (001's comment) --
-- widening its type doesn't change that.
--
-- Run by hand on the bastion, same process as 001/002 (see 001's header):
--   mariadb --defaults-file=~/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--     s57953__source_verifier < service/migrations/003-widen-citation-number.sql
-- Then confirm with SHOW CREATE TABLE citation_findings before trusting it.

ALTER TABLE citation_findings
  MODIFY COLUMN citation_number VARCHAR(64) NULL;
