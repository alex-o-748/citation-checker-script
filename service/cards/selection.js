// Which findings can become Fact Hunt cards, before any network call.
//
// The same rule is written twice, on purpose: once as SQL for ToolsDB
// (buildCandidateQuery) and once as a predicate for batch CSVs
// (candidateRejection), because a build can start from either. Both are pinned
// by tests/cards-selection.test.js so they can't drift apart. See
// docs/design-plans/2026-11-23-fact-hunt-app.md, "Where cards come from".

import { createHash } from 'node:crypto';
import { claimHash, sourceUrlHash } from '../../core/anchor.js';

export const CARD_VERDICT = 'NOT SUPPORTED';
export const CARD_REASON = 'contradiction';
export const CARD_QUOTE_STATUSES = Object.freeze(['exact', 'normalized']);

/**
 * The ToolsDB query for candidate findings on one wiki. Parameterized; the
 * caller passes { sql, params } straight to mysql2.
 */
export function buildCandidateQuery({ wiki, limit = null } = {}) {
    if (!wiki) throw new TypeError('buildCandidateQuery requires a wiki, e.g. "enwiki"');
    const placeholders = CARD_QUOTE_STATUSES.map(() => '?').join(', ');
    let sql = `
        SELECT wiki, page_id, page_title, revision_id, claim_text, source_url,
               verdict, reason_type, source_quote, quote_status, source_truncated,
               is_collective, check_kind, lead_demoted, provider, prompt_version
        FROM citation_findings
        WHERE wiki = ?
          AND check_kind = 'citation'
          AND verdict = ? AND reason_type = ?
          AND quote_status IN (${placeholders})
          AND source_truncated = 0
          AND is_collective = 0
          AND lead_demoted = 0
        ORDER BY page_id, created_at`;
    const params = [wiki, CARD_VERDICT, CARD_REASON, ...CARD_QUOTE_STATUSES];
    if (limit) {
        sql += '\n        LIMIT ?';
        params.push(Number(limit));
    }
    return { sql, params };
}

const asText = value => (Buffer.isBuffer(value) ? value.toString('utf8') : value == null ? '' : String(value));
const asFlag = raw => {
    const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    if (value === '' || value == null) return null;
    return value === true || value === 1 || value === '1' || value === 'true';
};
const asInt = value => {
    const n = Number(asText(value));
    return Number.isFinite(n) && asText(value) !== '' ? n : null;
};

/**
 * One finding, from either a ToolsDB row or a batch CSV row (an object keyed
 * by csv-report.js's column names). Values arrive as strings, numbers or
 * Buffers (VARBINARY columns) and leave as plain JS values.
 */
export function normalizeFinding(row, { wiki: defaultWiki = null } = {}) {
    return {
        wiki: asText(row.wiki) || defaultWiki,
        pageId: asInt(row.page_id),
        pageTitle: asText(row.page_title),
        revisionId: asInt(row.revision_id),
        claimText: asText(row.claim_text).trim(),
        sourceUrl: asText(row.source_url).trim(),
        verdict: asText(row.verdict).trim(),
        reasonType: asText(row.reason_type).trim(),
        sourceQuote: asText(row.source_quote).trim(),
        quoteStatus: asText(row.quote_status).trim(),
        sourceTruncated: asFlag(row.source_truncated),
        isCollective: asFlag(row.is_collective),
        checkKind: asText(row.check_kind).trim() || 'citation',
        leadDemoted: asFlag(row.lead_demoted),
        // CSV only; ToolsDB has no column. null = not known.
        isBlp: asFlag(row.is_blp),
        provider: asText(row.provider),
        promptVersion: asText(row.prompt_version),
    };
}

/**
 * Why a finding can't be a card, or null when it can. The JS twin of
 * buildCandidateQuery()'s WHERE clause, plus the checks only text allows.
 */
export function candidateRejection(f) {
    if (!f.pageId || !f.pageTitle) return 'no_page';
    if (f.checkKind !== 'citation') return 'not_a_citation_check';
    if (f.verdict !== CARD_VERDICT) return 'not_not_supported';
    if (f.reasonType !== CARD_REASON) return 'not_a_contradiction';
    if (!CARD_QUOTE_STATUSES.includes(f.quoteStatus)) return 'quote_not_verified';
    if (f.sourceTruncated) return 'source_truncated';
    if (f.isCollective) return 'group_finding';
    if (f.leadDemoted) return 'lead_demoted';
    if (f.isBlp === true) return 'blp';
    if (!f.claimText || !f.sourceQuote || !f.sourceUrl) return 'missing_text';
    if (isTimeVarying(f.claimText)) return 'time_varying';
    return null;
}

// Claims about a moving figure: "As of December 2024, the company operates
// six locations". Left out at launch, whatever the model says (design doc:
// "Claims with 'as of' or 'currently' are left out at launch"). English
// only; another wiki needs its own words before it launches.
const TIME_VARYING = /\b(as of|currently|at present|presently|to date|so far|as at)\b/i;

export function isTimeVarying(claim) {
    return TIME_VARYING.test(String(claim ?? ''));
}

/**
 * Stable across rebuilds: the same finding on the same page always gets the
 * same id, so answers and fixes recorded against a card survive the daily
 * rebuild. Same identity as the findings table's unique key, minus the
 * provider and prompt version (a re-check of the same citation is the same
 * card).
 */
export function cardIdFor(f) {
    const key = [f.wiki, f.pageId, claimHash(f.claimText).toString('hex'), sourceUrlHash(f.sourceUrl).toString('hex')].join('|');
    return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

export function findingHashes(f) {
    return {
        claimHash: claimHash(f.claimText).toString('hex'),
        sourceUrlHash: sourceUrlHash(f.sourceUrl).toString('hex'),
    };
}
