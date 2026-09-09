import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CRITERIA,
    NS_MAIN,
    NS_TEMPLATE,
    UnknownCriterionError,
    buildCandidateQuery,
    buildTopEditedQuery,
    formatRevTimestamp,
    normalizeRow,
    normalizeTopEditedRow,
    resolveCriterion,
    selectCandidates,
    selectTopEdited,
} from '../service/article-picker.js';

test('resolveCriterion returns known criteria and rejects unknown ones', () => {
    assert.equal(resolveCriterion('failed-verification').template, 'Failed_verification');
    assert.throws(() => resolveCriterion('nonsense'), UnknownCriterionError);
    assert.throws(() => resolveCriterion(undefined), UnknownCriterionError);
});

test('every criterion names a template with underscores, not spaces', () => {
    // lt_title stores the DB form; a space here would silently match nothing.
    for (const [name, { template }] of Object.entries(CRITERIA)) {
        assert.ok(!template.includes(' '), `${name} template must not contain spaces`);
        assert.equal(template, template.trim());
    }
});

test('the query joins templatelinks through linktarget, not the dropped columns', () => {
    const { sql } = buildCandidateQuery({ criterion: 'failed-verification' });

    // templatelinks was normalized (T299417): tl_namespace/tl_title no longer
    // exist. Guarding explicitly because a query using them fails at runtime
    // only, against a database this test suite cannot reach.
    assert.match(sql, /JOIN linktarget lt ON lt\.lt_id = tl\.tl_target_id/);
    assert.doesNotMatch(sql, /tl_namespace\b/);
    assert.doesNotMatch(sql, /tl_title\b/);
});

test('the query binds every value rather than interpolating', () => {
    const { sql, params } = buildCandidateQuery({
        criterion: 'citation-needed',
        limit: 100,
        afterPageId: 42,
    });

    assert.doesNotMatch(sql, /Citation_needed/, 'template title must be bound, not inlined');
    assert.equal((sql.match(/\?/g) || []).length, params.length);
    assert.deepEqual(params, [NS_TEMPLATE, 'Citation_needed', NS_MAIN, NS_MAIN, 42, 100]);
});

test('the query filters to non-redirect articles and pages by keyset', () => {
    const { sql } = buildCandidateQuery({});

    assert.match(sql, /p\.page_is_redirect = 0/);
    assert.match(sql, /p\.page_id > \?/, 'keyset pagination, not OFFSET');
    assert.doesNotMatch(sql, /OFFSET/i);
    assert.match(sql, /ORDER BY p\.page_id/);
});

test('buildCandidateQuery rejects out-of-range paging arguments', () => {
    assert.throws(() => buildCandidateQuery({ limit: 0 }), RangeError);
    assert.throws(() => buildCandidateQuery({ limit: 5001 }), RangeError);
    assert.throws(() => buildCandidateQuery({ limit: 1.5 }), RangeError);
    assert.throws(() => buildCandidateQuery({ afterPageId: -1 }), RangeError);
});

test('normalizeRow decodes VARBINARY titles and underscores', () => {
    const row = {
        pageId: 12345,
        pageTitle: Buffer.from('Great_Migration_(African_American)', 'utf8'),
        revisionId: 987654321,
    };

    assert.deepEqual(normalizeRow(row), {
        pageId: 12345,
        title: 'Great Migration (African American)',
        revisionId: 987654321,
    });
});

test('normalizeRow handles non-ASCII titles and plain strings', () => {
    assert.equal(normalizeRow({ pageTitle: Buffer.from('Ægir_(mythology)', 'utf8') }).title,
        'Ægir (mythology)');
    assert.equal(normalizeRow({ pageTitle: 'Already_a_string' }).title, 'Already a string');
});

// Builds a fake query function over a fixed row set, honouring the keyset
// pagination the real query does, and recording the calls made.
function fakeReplica(rows) {
    const calls = [];
    const query = async (sql, params) => {
        const afterPageId = params[4];
        const limit = params[5];
        calls.push({ afterPageId, limit });
        return rows.filter(r => r.pageId > afterPageId).slice(0, limit);
    };
    return { query, calls };
}

const row = n => ({ pageId: n, pageTitle: Buffer.from(`Article_${n}`), revisionId: n * 10 });

test('selectCandidates pages through results and normalizes them', async () => {
    const { query, calls } = fakeReplica([row(1), row(2), row(3), row(4), row(5)]);

    const got = await selectCandidates(query, { max: 5, pageSize: 2 });

    assert.deepEqual(got.map(c => c.pageId), [1, 2, 3, 4, 5]);
    assert.equal(got[0].title, 'Article 1');
    assert.deepEqual(
        calls.map(c => c.afterPageId), [0, 2, 4],
        'each page resumes after the last id seen'
    );
});

test('selectCandidates stops at max even when more rows exist', async () => {
    const { query } = fakeReplica(Array.from({ length: 20 }, (_, i) => row(i + 1)));

    const got = await selectCandidates(query, { max: 3, pageSize: 10 });

    assert.equal(got.length, 3);
    assert.deepEqual(got.map(c => c.pageId), [1, 2, 3]);
});

test('selectCandidates stops on a short page without a redundant final query', async () => {
    const { query, calls } = fakeReplica([row(1), row(2)]);

    const got = await selectCandidates(query, { max: 100, pageSize: 50 });

    assert.equal(got.length, 2);
    assert.equal(calls.length, 1, 'a short page means exhausted — do not query again');
});

test('selectCandidates returns nothing when the criterion matches no pages', async () => {
    const { query, calls } = fakeReplica([]);

    assert.deepEqual(await selectCandidates(query, { max: 10 }), []);
    assert.equal(calls.length, 1);
});

test('selectCandidates propagates an unknown criterion rather than querying', async () => {
    const { query, calls } = fakeReplica([row(1)]);

    await assert.rejects(
        () => selectCandidates(query, { criterion: 'nope' }),
        UnknownCriterionError
    );
    assert.equal(calls.length, 0);
});

test('current-event criterion is registered and resolves like the others', () => {
    assert.equal(resolveCriterion('current-event').template, 'Current');
    assert.ok(CRITERIA['current-event'].description.length > 0);
});

// --- Top-edited query ---

test('formatRevTimestamp produces MediaWiki\'s MW_TS form', () => {
    assert.equal(formatRevTimestamp(new Date('2026-09-09T14:03:07.000Z')), '20260909140307');
});

test('formatRevTimestamp rejects an invalid date', () => {
    assert.throws(() => formatRevTimestamp(new Date('not a date')), TypeError);
    assert.throws(() => formatRevTimestamp('2026-09-09'), TypeError);
});

test('buildTopEditedQuery groups by page and orders by edit count, not page id', () => {
    const { sql, params } = buildTopEditedQuery({ sinceDate: new Date('2026-09-01T00:00:00Z'), limit: 250 });

    assert.match(sql, /GROUP BY p\.page_id/);
    assert.match(sql, /ORDER BY editCount DESC/);
    assert.match(sql, /p\.page_is_redirect = 0/);
    assert.doesNotMatch(sql, /OFFSET/i);
    assert.equal((sql.match(/\?/g) || []).length, params.length);
    assert.deepEqual(params, ['20260901000000', NS_MAIN, 250]);
});

test('buildTopEditedQuery validates sinceDate and limit', () => {
    assert.throws(() => buildTopEditedQuery({ sinceDate: new Date('bad') }), TypeError);
    assert.throws(() => buildTopEditedQuery({ sinceDate: new Date(), limit: 0 }), RangeError);
    assert.throws(() => buildTopEditedQuery({ sinceDate: new Date(), limit: 5001 }), RangeError);
});

test('normalizeTopEditedRow decodes the title and carries editCount as a number', () => {
    const row = normalizeTopEditedRow({
        pageId: 7, pageTitle: Buffer.from('2026_Some_Election'), revisionId: 99, editCount: '42',
    });
    assert.deepEqual(row, { pageId: 7, title: '2026 Some Election', revisionId: 99, editCount: 42 });
});

test('selectTopEdited runs one bounded query and normalizes the rows, unpaginated', async () => {
    const calls = [];
    const query = async (sql, params) => {
        calls.push({ sql, params });
        return [
            { pageId: 3, pageTitle: 'Busy_Page', revisionId: 30, editCount: 9 },
            { pageId: 1, pageTitle: 'Busier_Page', revisionId: 10, editCount: 20 },
        ];
    };

    const got = await selectTopEdited(query, { sinceDate: new Date('2026-09-01T00:00:00Z'), limit: 500 });

    assert.equal(calls.length, 1, 'top-edited is a single bounded query, not keyset-paginated');
    assert.deepEqual(got.map(r => r.title), ['Busy Page', 'Busier Page']);
    assert.deepEqual(got.map(r => r.editCount), [9, 20]);
});
