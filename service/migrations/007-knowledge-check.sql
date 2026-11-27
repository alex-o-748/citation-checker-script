-- Adds the knowledge check's columns to citation_findings (2026-11). Apply by
-- hand on the bastion, like 001-006:
--
--   mariadb --defaults-file=$HOME/replica.my.cnf -h tools.db.svc.wikimedia.cloud \
--       s57953__source_verifier < service/migrations/007-knowledge-check.sql
--
-- before the first sweep or import that ran --knowledge-check, and before
-- `run-build-cards.js --from-toolsdb --knowledge-check`, which reads them.
-- Unlike 006, buildUpsertQuery() names these columns only on a row the check
-- ran on, so a sweep without --knowledge-check works with or without them.
--
-- The knowledge check (core/knowledge-check.js) is the uncited-text check's
-- prompt applied to a flagged citation finding: does the model, without the
-- source, have a specific reason to believe the claim is wrong?
--
-- 1. knowledge_check: 'doubted', 'not_doubted' or 'error'; NULL when the check
--    didn't run on the row. 'not_doubted' covers "probably true" and "no idea"
--    together, and is never to be read as "true".
-- 2. knowledge_confidence: 'high' or 'medium' on a doubted row, else NULL.
-- 3. knowledge_prompt_version: UNCITED_PROMPT_VERSION at the time (u2 on),
--    so the card builder knows whether a stored result is still current.
--
-- The model's comment is CSV-only (knowledge_comment), as the uncited
-- check's confidence is: it is never an edit, and nothing reads it from here.

ALTER TABLE citation_findings
  ADD COLUMN knowledge_check VARBINARY(16) NULL DEFAULT NULL,
  ADD COLUMN knowledge_confidence VARBINARY(8) NULL DEFAULT NULL,
  ADD COLUMN knowledge_prompt_version VARBINARY(16) NULL DEFAULT NULL;
