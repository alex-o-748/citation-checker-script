-- Adds the lead check's columns to citation_findings (2026-10). Apply by hand
-- on the bastion, like 001-005:
--
--   mariadb --defaults-file=$HOME/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--       s57953__source_verifier < service/migrations/006-lead-check.sql
--
-- before the first sweep or import that writes either column; buildUpsertQuery()
-- writes both on every row.
--
-- 1. check_kind: what the row checked. 'citation' (solo or collective, told
--    apart by is_collective as before) or 'lead_body': a lead sentence against
--    the article body (core/lead-check.js). A lead row's source_url is the
--    article itself (index.php?curid=<page_id>), so its source_url_hash never
--    matches a citation row's and uniq_finding needs no change; its
--    prompt_version is LEAD_PROMPT_VERSION.
-- 2. lead_demoted: a lead citation's PARTIALLY SUPPORTED or omission verdict
--    in an article that got a lead check (core/lead.js's
--    isLeadDemotedVerdict()). Kept, never published.
--
-- Every existing row is a citation check, none demoted, which the defaults say.

ALTER TABLE citation_findings
  ADD COLUMN check_kind VARBINARY(16) NOT NULL DEFAULT 'citation',
  ADD COLUMN lead_demoted TINYINT(1) NOT NULL DEFAULT 0;
