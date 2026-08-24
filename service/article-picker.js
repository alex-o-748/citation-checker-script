// Article selection: which pages the batch runner should check, and in what
// order. Pure query construction — no database connection lives here, so the
// SQL can be unit-tested and reviewed without a Wiki Replicas account.
//
// Selection runs against Wiki Replicas (the read-only production database
// replicas available from Toolforge), not the API. That matters: finding every
// article carrying {{Failed verification}} is one indexed query here, versus
// crawling category listings over HTTP.
//
// SCHEMA NOTE — templatelinks was normalized (T299417). The old tl_namespace /
// tl_title columns are gone; the target now lives in the `linktarget` table and
// is reached via tl_target_id -> lt_id. Queries written against the pre-2023
// schema fail outright rather than returning wrong rows, so this is a loud
// failure if it ever regresses.

export const NS_MAIN = 0;
export const NS_TEMPLATE = 10;

// Maintenance templates worth checking, most-specific first.
//
// `failed-verification` is the highest-signal criterion available: an editor has
// already read the source and asserted it does not support the claim, and the
// template is *inline*, so it marks a specific citation rather than the article
// as a whole. That makes it both the best pilot corpus (there is a human
// judgement to compare against) and the best early-precision bet.
//
// Note these select articles where a problem is already *suspected*. For the
// production feed the point is to surface problems nobody has flagged yet — a
// different criterion (high-traffic, recently-edited) with no such prior. Keep
// that distinction in mind when reading pilot precision numbers: they are
// measured on a population enriched for genuine problems.
export const CRITERIA = Object.freeze({
    'failed-verification': {
        template: 'Failed_verification',
        description: 'Inline {{failed verification}} — an editor has already disputed this citation',
    },
    'citation-needed': {
        template: 'Citation_needed',
        description: 'Inline {{citation needed}} — a claim flagged as unsourced',
    },
    'unreliable-source': {
        template: 'Unreliable_source?',
        description: 'Inline {{unreliable source?}} — the cited source itself is disputed',
    },
});

export class UnknownCriterionError extends Error {
    constructor(name) {
        super(`unknown selection criterion: ${name} (known: ${Object.keys(CRITERIA).join(', ')})`);
        this.name = 'UnknownCriterionError';
    }
}

export function resolveCriterion(name) {
    const criterion = CRITERIA[name];
    if (!criterion) throw new UnknownCriterionError(name);
    return criterion;
}

/**
 * Builds the candidate-article query for one criterion.
 *
 * Returns { sql, params } for a parameterized query — the template title is
 * bound, never interpolated. Callers pass the result straight to the driver.
 *
 * `afterPageId` drives keyset pagination rather than OFFSET: OFFSET makes the
 * database walk and discard every skipped row, which degrades badly across a
 * template with hundreds of thousands of transclusions. Paging on the last
 * page_id seen stays flat.
 */
export function buildCandidateQuery({
    criterion = 'failed-verification',
    limit = 500,
    afterPageId = 0,
} = {}) {
    const { template } = resolveCriterion(criterion);

    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
        throw new RangeError(`limit must be an integer in 1..5000 (got: ${limit})`);
    }
    if (!Number.isInteger(afterPageId) || afterPageId < 0) {
        throw new RangeError(`afterPageId must be a non-negative integer (got: ${afterPageId})`);
    }

    // tl_from_namespace is a denormalized column on templatelinks specifically
    // so this filter doesn't require joining page first. Filtering on it *and*
    // on page_namespace is redundant but cheap, and keeps the query correct if
    // the denormalized column is ever stale.
    const sql = `
        SELECT
            p.page_id      AS pageId,
            p.page_title   AS pageTitle,
            p.page_latest  AS revisionId
        FROM templatelinks tl
        JOIN linktarget lt ON lt.lt_id = tl.tl_target_id
        JOIN page p        ON p.page_id = tl.tl_from
        WHERE lt.lt_namespace = ?
          AND lt.lt_title = ?
          AND tl.tl_from_namespace = ?
          AND p.page_namespace = ?
          AND p.page_is_redirect = 0
          AND p.page_id > ?
        ORDER BY p.page_id
        LIMIT ?
    `.trim().replace(/\n {8}/g, '\n');

    return {
        sql,
        params: [NS_TEMPLATE, template, NS_MAIN, NS_MAIN, afterPageId, limit],
    };
}

// Wiki Replicas returns page_title as a Buffer (the columns are VARBINARY) with
// underscores for spaces. Normalize to the display form the REST API expects.
export function normalizeRow(row) {
    const title = Buffer.isBuffer(row.pageTitle)
        ? row.pageTitle.toString('utf8')
        : String(row.pageTitle);

    return {
        pageId: Number(row.pageId),
        title: title.replace(/_/g, ' '),
        revisionId: Number(row.revisionId),
    };
}

/**
 * Runs the candidate query, paging until `max` rows or the source is exhausted.
 *
 * `query` is injected — an async (sql, params) => rows function — so this is
 * testable without a database and the caller owns connection lifecycle.
 */
export async function selectCandidates(query, {
    criterion = 'failed-verification',
    max = 500,
    pageSize = 500,
} = {}) {
    const out = [];
    let afterPageId = 0;

    while (out.length < max) {
        const limit = Math.min(pageSize, max - out.length);
        const { sql, params } = buildCandidateQuery({ criterion, limit, afterPageId });
        const rows = await query(sql, params);
        if (!rows || rows.length === 0) break;

        for (const row of rows) out.push(normalizeRow(row));

        // A short page means the source is exhausted; without this the loop
        // would issue one redundant empty query per run.
        if (rows.length < limit) break;
        afterPageId = out[out.length - 1].pageId;
    }

    return out;
}
