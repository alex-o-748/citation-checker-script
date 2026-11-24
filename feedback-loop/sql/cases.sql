-- Rated checks, one JSON object per check, as a single JSON array.
--
-- Run with psql, which substitutes :'since' (an ISO timestamp):
--
--   psql "$NEON_LOOP_DATABASE_URL" -X -q -At -v since=2026-08-01 \
--        -f feedback-loop/sql/cases.sql > cases.json
--
-- Output is consumed by feedback-loop/cases.js (normalizeCase). Every column
-- here is read there; rename one and that function's tests break, not a
-- nightly run.
--
-- A check can have several feedback rows: a thumbs-down, then a corrected
-- verdict (docs/worker-logging-reference.md, "Feedback endpoint"). They are
-- collapsed to the latest rating and the latest correction.
--
-- client_id is used only inside this query, to count how much one browser
-- rated (rater_checks_on_article, rater_checks_total) and how fast
-- (rating_gap_s). It is deliberately not selected: the field set these cases
-- feed is committed to a public repository, and a stable per-browser token
-- would let anyone link one person's ratings across articles.

WITH fb AS (
  SELECT f.check_id, f.ts, f.rating, f.corrected_verdict, f.wiki_section, f.client_id,
         -- Seconds since the same browser's previous feedback row. A rating
         -- given seconds after the last one is usually a sweep through a
         -- Verify All report, not a reading of the source.
         EXTRACT(EPOCH FROM f.ts - lag(f.ts) OVER (PARTITION BY f.client_id ORDER BY f.ts)) AS gap_s
  FROM feedback f
  WHERE f.check_id IS NOT NULL
),
per_check AS (
  SELECT check_id,
         (array_agg(rating ORDER BY ts DESC) FILTER (WHERE rating IS NOT NULL))[1]                       AS rating,
         (array_agg(corrected_verdict ORDER BY ts DESC) FILTER (WHERE corrected_verdict IS NOT NULL))[1] AS corrected_verdict,
         (array_agg(wiki_section ORDER BY ts DESC) FILTER (WHERE wiki_section IS NOT NULL))[1]           AS wiki_section,
         (array_agg(gap_s ORDER BY ts) FILTER (WHERE rating IS NOT NULL))[1]                             AS rating_gap_s,
         (array_agg(client_id ORDER BY ts) FILTER (WHERE rating IS NOT NULL))[1]                         AS rater,
         min(ts)                   AS first_feedback_at,
         max(ts)                   AS last_feedback_at,
         count(*)                  AS feedback_rows,
         count(DISTINCT client_id) AS raters
  FROM fb
  GROUP BY check_id
),
joined AS (
  -- Counted over all feedback, before the :'since' filter below, so an
  -- incremental run sees the same rater totals as a full one.
  SELECT p.check_id, p.rating, p.corrected_verdict, p.wiki_section,
         round(p.rating_gap_s::numeric, 1) AS rating_gap_s,
         p.first_feedback_at, p.last_feedback_at, p.feedback_rows, p.raters,
         CASE WHEN p.rater IS NULL THEN NULL
              ELSE count(*) OVER (PARTITION BY p.rater, l.article_url) END AS rater_checks_on_article,
         CASE WHEN p.rater IS NULL THEN NULL
              ELSE count(*) OVER (PARTITION BY p.rater) END                AS rater_checks_total,
         l.ts AS checked_at, l.kind, l.article_url, l.article_title, l.revision_id,
         l.citation_number, l.source_url, l.provider, l.model, l.verdict, l.confidence,
         l.reason_type, l.claim_text, l.llm_comments, l.source_quote, l.quote_status
  FROM per_check p
  JOIN verification_logs l USING (check_id)
)
SELECT coalesce(json_agg(j ORDER BY j.last_feedback_at, j.check_id), '[]'::json)
FROM joined j
WHERE j.last_feedback_at >= :'since'::timestamptz;
