// ToolsDB findings store: writing verified citation results for later serving
// as Wikipedia "edit suggestions."
//
// Two layers, deliberately split: the SQL construction is a pure function,
// testable without a database. The I/O wrapper is a thin shim around it — it
// cannot be meaningfully tested here (ToolsDB is unreachable from outside
// Wikimedia Cloud infrastructure), so it stays small and every external call
// is injectable, matching the pattern in service/replicas.js.
//
// source_quote / quote_status (added in service/migrations/
// 002-add-quote-columns.sql — run by hand on the bastion before this module's
// upsert can succeed against the live table, same as the original schema) are
// written unconditionally, whatever the quote's status — mirroring
// core/worker.js's logVerification(), not the UI's display-time filtering.
// Per CLAUDE.md's "Source quotes are verified before they are shown": the
// log/store layer keeps a not-found quote because that is exactly the row
// worth inspecting later; only the UI hides one, to avoid implying a verdict
// is less trustworthy than measured.

import { claimHash, sourceUrlHash } from '../core/anchor.js';

/**
 * Builds the upsert query for one citation finding.
 *
 * Returns { sql, params } for a parameterized query — all values are bound,
 * never interpolated. Callers pass the result straight to the driver.
 *
 * Computes claim_hash and source_url_hash internally via core/anchor.js —
 * callers supply plain text and URLs, never precomputed hashes.
 */
export function buildUpsertQuery(finding) {
    // Compute hashes internally — do not make the caller compute these
    const claim_hash = claimHash(finding.claimText);
    const source_url_hash = sourceUrlHash(finding.sourceUrl);

    const sql = `
        INSERT INTO citation_findings (
            wiki, page_id, page_title, revision_id,
            claim_hash, claim_text, citation_number, ref_name,
            source_url, source_url_hash, fetched_at,
            group_id, is_collective,
            verdict, confidence, reason_type, rationale,
            source_quote, quote_status,
            provider, model, prompt_version,
            fetch_status, source_truncated, tokens_in, tokens_out,
            expires_at, published
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            page_title = VALUES(page_title),
            revision_id = VALUES(revision_id),
            claim_text = VALUES(claim_text),
            citation_number = VALUES(citation_number),
            ref_name = VALUES(ref_name),
            source_url = VALUES(source_url),
            fetched_at = VALUES(fetched_at),
            group_id = VALUES(group_id),
            is_collective = VALUES(is_collective),
            verdict = VALUES(verdict),
            confidence = VALUES(confidence),
            reason_type = VALUES(reason_type),
            rationale = VALUES(rationale),
            source_quote = VALUES(source_quote),
            quote_status = VALUES(quote_status),
            provider = VALUES(provider),
            model = VALUES(model),
            fetch_status = VALUES(fetch_status),
            source_truncated = VALUES(source_truncated),
            tokens_in = VALUES(tokens_in),
            tokens_out = VALUES(tokens_out),
            expires_at = VALUES(expires_at),
            published = VALUES(published)
    `.trim().replace(/\n {8}/g, '\n');

    const params = [
        finding.wiki,
        finding.pageId,
        finding.pageTitle,
        finding.revisionId,
        claim_hash,
        finding.claimText,
        finding.citationNumber,
        finding.refName,
        finding.sourceUrl,
        source_url_hash,
        finding.fetchedAt,
        finding.groupId,
        finding.isCollective ? 1 : 0,
        finding.verdict,
        finding.confidence,
        finding.reasonType,
        finding.rationale,
        finding.sourceQuote,
        finding.quoteStatus,
        finding.provider,
        finding.model,
        finding.promptVersion,
        finding.fetchStatus,
        finding.sourceTruncated ? 1 : 0,
        finding.tokensIn,
        finding.tokensOut,
        finding.expiresAt,
        finding.published ? 1 : 0,
    ];

    return { sql, params };
}

/**
 * Runs the upsert query against the database.
 *
 * `query` is injected — an async (sql, params) => result function — so this is
 * testable without a database and the caller owns connection lifecycle.
 */
export async function upsertFinding(query, finding) {
    const { sql, params } = buildUpsertQuery(finding);
    return await query(sql, params);
}