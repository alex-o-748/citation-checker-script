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
    'current-event': {
        template: 'Current',
        description: '{{current}} — the article documents a developing event',
    },
});

// Templates an editor puts on an article that is actively in the news.
//
// Measured on enwiki 2026-09-09: {{current}} alone was on **6 articles**. It
// is applied during the first hours of a breaking story and removed within
// days, so as a *selection* signal it is far too rare to fill a 100-article
// pilot — which is why service/pilot-selection.js treats the tag as a bonus
// on top of two signals that don't depend on anyone tagging anything
// (recent creation, and a burst of edits). Kept, and widened to the sibling
// tags, because when a tag *is* present it is unambiguous.
export const CURRENT_EVENT_TEMPLATES = Object.freeze([
    'Current',
    'Current_related_event',
    'Current_sport',
    'Current_sport_event',
    'Current_person',
    'Recent_death',
    'Recent_related_death',
    'Ongoing_election',
]);

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

// --- Top-edited articles ---
//
// The criteria above are all "every page transcluding template X" — a bounded,
// indexed lookup that keyset-pages until exhausted. "Most edited in the last N
// days" is a different shape: rank the whole revision table by activity and
// take the top N. There is no "every row" case to page through here, only
// "give me the top N", so this deliberately does not reuse
// buildCandidateQuery()/selectCandidates()'s pagination.
//
// This is the base population service/pilot-selection.js scores and filters
// from for the 100-article pilot mix: recent edit velocity is a cheap proxy
// for "this article is a current event" (elections, disasters, deaths,
// ongoing tournaments all spike edit counts) that catches articles the
// {{current}} tag misses — not every developing story gets self-tagged, and
// the tag is commonly removed within days of the event settling down while
// the edit spike (and the citation backlog it leaves) is still there.

/**
 * Formats a Date as MediaWiki's rev_timestamp form: BINARY(14), UTC,
 * "YYYYMMDDHHMMSS" — the MW_TS format used throughout the MediaWiki schema.
 */
export function formatRevTimestamp(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new TypeError('formatRevTimestamp requires a valid Date');
    }
    return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Parses a rev_timestamp (Buffer or string, MW_TS) back into a Date. */
export function parseRevTimestamp(value) {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

/**
 * Builds the "most-edited in the window since `sinceDate`" query.
 *
 * Also counts the subset of those edits falling inside a shorter *burst*
 * window (`burstSinceDate`), via conditional aggregation over the same scan.
 * The ratio of the two is what distinguishes a breaking story (nearly all of
 * its edits landed in the last few days) from a perennially busy page like a
 * head of state's biography (edits spread evenly across the window) — see
 * service/pilot-selection.js's burstFactor().
 *
 * Returns { sql, params } like buildCandidateQuery(): every value is bound,
 * never interpolated.
 */
export function buildTopEditedQuery({ sinceDate, burstSinceDate, limit = 500 } = {}) {
    if (!(sinceDate instanceof Date) || Number.isNaN(sinceDate.getTime())) {
        throw new TypeError('buildTopEditedQuery requires a valid sinceDate');
    }
    const burstSince = burstSinceDate ?? sinceDate;
    if (!(burstSince instanceof Date) || Number.isNaN(burstSince.getTime())) {
        throw new TypeError('buildTopEditedQuery requires a valid burstSinceDate');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
        throw new RangeError(`limit must be an integer in 1..5000 (got: ${limit})`);
    }

    const sql = `
        SELECT
            p.page_id      AS pageId,
            p.page_title   AS pageTitle,
            p.page_latest  AS revisionId,
            COUNT(*)       AS editCount,
            SUM(CASE WHEN r.rev_timestamp >= ? THEN 1 ELSE 0 END) AS recentEditCount
        FROM revision r
        JOIN page p ON p.page_id = r.rev_page
        WHERE r.rev_timestamp >= ?
          AND p.page_namespace = ?
          AND p.page_is_redirect = 0
        GROUP BY p.page_id
        ORDER BY editCount DESC
        LIMIT ?
    `.trim().replace(/\n {8}/g, '\n');

    // Textual order, not logical: the CASE's bound value appears in the
    // SELECT list, ahead of the WHERE clause's.
    return {
        sql,
        params: [formatRevTimestamp(burstSince), formatRevTimestamp(sinceDate), NS_MAIN, limit],
    };
}

export function normalizeTopEditedRow(row) {
    return {
        ...normalizeRow(row),
        editCount: Number(row.editCount),
        recentEditCount: row.recentEditCount == null ? null : Number(row.recentEditCount),
    };
}

/**
 * Runs the top-edited query and normalizes the rows. Single-shot — no
 * pagination loop, since callers want exactly "the top `limit`", not
 * exhaustion of a source. `query` has the same (sql, params) => rows shape
 * selectCandidates() takes.
 */
export async function selectTopEdited(query, { sinceDate, burstSinceDate, limit = 500 } = {}) {
    const { sql, params } = buildTopEditedQuery({ sinceDate, burstSinceDate, limit });
    const rows = await query(sql, params);
    return (rows || []).map(normalizeTopEditedRow);
}

// --- Per-candidate lookups ---
//
// Both queries below answer a question about a *known* set of page ids rather
// than enumerating a whole population. That distinction matters: the first
// version of the pilot picker pulled every page transcluding
// {{failed verification}} with a 5000-row cap and tested membership against
// that. On enwiki the real set is larger than the cap, and because
// selectCandidates() pages by ascending page_id, the rows dropped were the
// highest ids — the newest articles, which is exactly the current-events
// population the pilot is trying to over-sample. Asking about the base pool's
// own ids instead is both exact and cheaper.

const ID_CHUNK_SIZE = 500;

function chunkIds(pageIds) {
    const unique = [...new Set(pageIds)].filter(id => Number.isInteger(id) && id > 0);
    const out = [];
    for (let i = 0; i < unique.length; i += ID_CHUNK_SIZE) {
        out.push(unique.slice(i, i + ID_CHUNK_SIZE));
    }
    return out;
}

/** Which of `pageIds` transclude any of `templates`. */
export function buildTagMembershipQuery({ templates, pageIds }) {
    if (!templates?.length) throw new TypeError('buildTagMembershipQuery requires at least one template');
    if (!pageIds?.length) throw new TypeError('buildTagMembershipQuery requires at least one page id');

    const sql = `
        SELECT DISTINCT tl.tl_from AS pageId
        FROM templatelinks tl
        JOIN linktarget lt ON lt.lt_id = tl.tl_target_id
        WHERE lt.lt_namespace = ?
          AND lt.lt_title IN (${templates.map(() => '?').join(', ')})
          AND tl.tl_from_namespace = ?
          AND tl.tl_from IN (${pageIds.map(() => '?').join(', ')})
    `.trim().replace(/\n {8}/g, '\n');

    return { sql, params: [NS_TEMPLATE, ...templates, NS_MAIN, ...pageIds] };
}

export async function selectTagMembership(query, { templates, pageIds }) {
    const found = new Set();
    for (const chunk of chunkIds(pageIds)) {
        const { sql, params } = buildTagMembershipQuery({ templates, pageIds: chunk });
        for (const row of (await query(sql, params)) || []) found.add(Number(row.pageId));
    }
    return found;
}

/**
 * Each page's creation time, as MIN(rev_timestamp) over its whole history.
 *
 * Runs against the (rev_page, rev_timestamp) index, so this is an index-range
 * minimum per page rather than a scan. page_id ordering would be a cheaper
 * proxy for "created recently", but only a monotonic one — it cannot say
 * *how* recently without a reference point, and the recency boost is graded,
 * not binary.
 */
export function buildCreationDateQuery({ pageIds }) {
    if (!pageIds?.length) throw new TypeError('buildCreationDateQuery requires at least one page id');

    const sql = `
        SELECT rev_page AS pageId, MIN(rev_timestamp) AS createdAt
        FROM revision
        WHERE rev_page IN (${pageIds.map(() => '?').join(', ')})
        GROUP BY rev_page
    `.trim().replace(/\n {8}/g, '\n');

    return { sql, params: [...pageIds] };
}

export async function selectCreationDates(query, { pageIds }) {
    const dates = new Map();
    for (const chunk of chunkIds(pageIds)) {
        const { sql, params } = buildCreationDateQuery({ pageIds: chunk });
        for (const row of (await query(sql, params)) || []) {
            const created = parseRevTimestamp(row.createdAt);
            if (created) dates.set(Number(row.pageId), created);
        }
    }
    return dates;
}
