// ToolsDB findings store: writing verified citation results for later serving
// as Wikipedia "edit suggestions."
//
// Two layers, deliberately split: the SQL construction is a pure function,
// testable without a database. The I/O wrapper is a thin shim around it — it
// cannot be meaningfully tested here (ToolsDB is unreachable from outside
// Wikimedia Cloud infrastructure), so it stays small and every external call
// is injectable, matching the pattern in service/replicas.js.

import { claimHash, sourceUrlHash, groupSourceUrlHash } from '../core/anchor.js';

// Single source of truth for the column list and param order — shared by
// buildUpsertQuery (one row) and buildBulkUpsertQuery (many rows in one
// statement) so the two can never drift apart. A hand-copied second column
// list is exactly how a future edit shifts one builder's values one column
// left of the other's, silently — see
// docs/design-plans/2026-08-21-findings-write-path-wiring.md §4.
const COLUMNS = [
    'wiki', 'page_id', 'page_title', 'revision_id',
    'claim_hash', 'claim_text', 'citation_number', 'ref_name',
    'source_url', 'source_url_hash', 'fetched_at',
    'group_id', 'is_collective',
    'verdict', 'confidence', 'reason_type', 'rationale',
    'provider', 'model', 'prompt_version',
    'fetch_status', 'source_truncated', 'tokens_in', 'tokens_out',
    'expires_at', 'published',
];

// Columns left out of ON DUPLICATE KEY UPDATE on purpose: the four other
// unique-key columns (wiki, page_id, claim_hash, source_url_hash) can't
// change on a row that matched the key, and prompt_version is itself part of
// that key — a different prompt version can't match the same row, so it
// inserts a new one instead of updating (that's the mechanism, not a gap).
// created_at is absent from COLUMNS entirely: MariaDB's DEFAULT
// CURRENT_TIMESTAMP sets it once, and no column not mentioned in the UPDATE
// clause is touched by a duplicate-key hit — which is what keeps a
// re-crawled finding's first-seen timestamp intact.
const UPDATE_ONLY_COLUMNS = new Set(['wiki', 'page_id', 'claim_hash', 'source_url_hash', 'prompt_version']);
const UPDATE_COLUMNS = COLUMNS.filter(c => !UPDATE_ONLY_COLUMNS.has(c));

const UPDATE_CLAUSE = UPDATE_COLUMNS.map(c => `${c} = VALUES(${c})`).join(',\n            ');

// Computes claim_hash and source_url_hash for one finding — internal, never
// supplied by the caller (see buildUpsertQuery's doc comment on why). Shared
// by both builders so the hashing rule can't diverge between them either.
function computeHashes(finding) {
    return {
        claim_hash: claimHash(finding.claimText),
        // A collective (adjacent-citation-group) finding is anchored to
        // several URLs at once rather than one — see
        // docs/design-plans/2026-08-21-findings-write-path-wiring.md §2b.
        // finding.sourceUrl stays a human-readable, denormalized string for
        // display (e.g. the member URLs joined) and is never itself hashed
        // for a collective row; finding.sourceUrls (the raw list) is.
        source_url_hash: finding.isCollective
            ? groupSourceUrlHash(finding.sourceUrls || [])
            : sourceUrlHash(finding.sourceUrl),
    };
}

// provider is part of the unique key (wiki, page_id, claim_hash,
// source_url_hash, provider, prompt_version). MariaDB's unique index treats
// NULL as never equal to NULL — even to itself — so a null provider silently
// defeats ON DUPLICATE KEY UPDATE: two otherwise-identical findings both
// insert instead of the second updating the first. Confirmed against real
// ToolsDB on 2026-08-22 (every SOURCE UNAVAILABLE finding, provider left
// null, duplicated on every re-run). Every other unique-key column is
// NOT NULL in the schema or always computed (the two hashes); provider was
// the one gap, closed here rather than only at the caller
// (service/finding-record.js's NO_PROVIDER) so this can't regress no matter
// what constructs the finding object.
function assertNoNullProvider(finding) {
    if (finding.provider == null) {
        throw new TypeError(
            'finding.provider must not be null/undefined — it is part of the unique key, and MariaDB never ' +
            'treats two NULLs as equal, which silently defeats ON DUPLICATE KEY UPDATE and duplicates the row ' +
            'on every re-run. Use a sentinel (e.g. service/finding-record.js\'s NO_PROVIDER) for "no provider".'
        );
    }
}

function computeParams(finding, { claim_hash, source_url_hash }) {
    assertNoNullProvider(finding);
    return [
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
}

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
    const hashes = computeHashes(finding);

    const sql = `
        INSERT INTO citation_findings (
            ${COLUMNS.join(', ')}
        ) VALUES (${COLUMNS.map(() => '?').join(', ')})
        ON DUPLICATE KEY UPDATE
            ${UPDATE_CLAUSE}
    `.trim().replace(/\n {8}/g, '\n');

    return { sql, params: computeParams(finding, hashes) };
}

export const DEFAULT_BULK_CHUNK_SIZE = 500;

/**
 * Builds one or more upsert queries covering many findings, chunked so a
 * single prepared statement never approaches MariaDB's 65535 placeholder
 * ceiling (26 columns × 500 rows = 13000, comfortably under it — 26 × 2520
 * would already exceed it, so 500 leaves real headroom for max_allowed_packet
 * too). Returns an array of { sql, params }, one per chunk, in input order —
 * a caller runs each inside the same transaction so an article's rows land
 * all-or-nothing (see the runner design in
 * docs/design-plans/2026-08-21-findings-write-path-wiring.md §4).
 *
 * Each row uses the exact same column order and hashing rule as
 * buildUpsertQuery — both are derived from the same COLUMNS list and
 * computeParams()/computeHashes() helpers above, so they cannot drift apart.
 */
export function buildBulkUpsertQuery(findings, { chunkSize = DEFAULT_BULK_CHUNK_SIZE } = {}) {
    if (!Array.isArray(findings) || findings.length === 0) {
        throw new TypeError('buildBulkUpsertQuery requires a non-empty array of findings');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new RangeError(`chunkSize must be a positive integer (got: ${chunkSize})`);
    }

    const chunks = [];
    for (let i = 0; i < findings.length; i += chunkSize) {
        chunks.push(buildChunk(findings.slice(i, i + chunkSize)));
    }
    return chunks;
}

function buildChunk(findings) {
    const rowPlaceholder = `(${COLUMNS.map(() => '?').join(', ')})`;
    const params = [];
    for (const finding of findings) {
        params.push(...computeParams(finding, computeHashes(finding)));
    }

    const sql = `
        INSERT INTO citation_findings (
            ${COLUMNS.join(', ')}
        ) VALUES ${findings.map(() => rowPlaceholder).join(', ')}
        ON DUPLICATE KEY UPDATE
            ${UPDATE_CLAUSE}
    `.trim().replace(/\n {8}/g, '\n');

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