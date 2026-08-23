-- Adds source_quote / quote_status to citation_findings.
--
-- The original schema (001) predates the quote-verification work in
-- core/quote.js being wired through, so citation_findings had less
-- provenance than the fire-and-forget verification_logs table it's meant to
-- eventually replace for this purpose. Per CLAUDE.md's "Source quotes are
-- verified before they are shown": logVerification() already records
-- source_quote and quote_status on every row regardless of outcome, because
-- a not-found quote is exactly the row worth inspecting later. This module
-- (service/findings.js) now does the same.
--
-- quote_status values come from core/quote.js's QUOTE_STATUS_LIST
-- ('exact' | 'normalized' | 'partial' | 'not-found' | 'too-short' | 'empty' |
-- 'no-source') — tests/quote.test.js pins that list. VARBINARY(16) is sized
-- for the longest value ('normalized', 10 bytes) with headroom, matching
-- reason_type's sizing convention in 001.
--
-- Run by hand on the bastion, same process as 001 (see that file's header):
--   mariadb --defaults-file=~/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--     s57953__source_verifier < service/migrations/002-add-quote-columns.sql
-- Then confirm with SHOW CREATE TABLE citation_findings before trusting it.

ALTER TABLE citation_findings
  ADD COLUMN source_quote TEXT NULL AFTER rationale,
  ADD COLUMN quote_status VARBINARY(16) NULL AFTER source_quote;
