-- Original schema, created by hand on the Toolforge bastion 2026-08-20.
-- Recorded here so the migration history is complete in the repo — this file
-- is NOT meant to be (re-)run; the table already exists as
-- s57953__source_verifier.citation_findings. See
-- docs/design-plans/2026-08-17-toolsdb-findings-store.md for the full story,
-- including the source_hash -> source_url_hash correction baked in below.
--
-- This repo has no migration runner. Every file in this directory is applied
-- by hand via the mariadb CLI on the bastion, in filename order, and hand-
-- verified before anything depending on it is trusted — same process the
-- original CREATE TABLE went through.

CREATE TABLE citation_findings (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  wiki             VARBINARY(32)  NOT NULL,
  page_id          INT UNSIGNED   NOT NULL,
  page_title       VARBINARY(255) NOT NULL,
  revision_id      BIGINT UNSIGNED NOT NULL,
  claim_hash       BINARY(32)     NOT NULL,
  claim_text       TEXT           NOT NULL,
  citation_number  INT,
  ref_name         VARBINARY(255),
  source_url       TEXT,
  source_url_hash  BINARY(32)     NOT NULL,
  fetched_at       TIMESTAMP      NULL,
  group_id         VARBINARY(64),
  is_collective    TINYINT(1)     NOT NULL DEFAULT 0,
  verdict          VARBINARY(32)  NOT NULL,
  confidence       TINYINT UNSIGNED,
  reason_type      VARBINARY(16),
  rationale        TEXT,
  provider         VARBINARY(32),
  model            VARBINARY(128),
  prompt_version   VARBINARY(32)  NOT NULL,
  fetch_status     SMALLINT,
  source_truncated TINYINT(1)     NOT NULL DEFAULT 0,
  tokens_in        INT,
  tokens_out       INT,
  created_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at       TIMESTAMP      NULL,
  published        TINYINT(1)     NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_finding (wiki, page_id, claim_hash, source_url_hash, provider, prompt_version),
  KEY idx_lookup (wiki, page_id, published),
  KEY idx_expiry (expires_at)
);
