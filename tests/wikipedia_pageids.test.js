import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildTitlesQueryUrl, resolvePageIds, resolveTitleInfo, DEFAULT_BATCH_SIZE,
} from '../service/wikipedia-pageids.js';

test('buildTitlesQueryUrl pipe-joins titles into one Action API request', () => {
    const url = buildTitlesQueryUrl(['Foo', 'Bar Baz']);
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'en.wikipedia.org');
    assert.equal(parsed.searchParams.get('action'), 'query');
    assert.equal(parsed.searchParams.get('titles'), 'Foo|Bar Baz');
    assert.equal(parsed.searchParams.get('formatversion'), '2');
});

// service/run-sweep.js's --titles-file branch needs the current revision, not
// just the page id: without it the run isn't pinned to a revision and the CSV
// has no permalink to offer.
test('buildTitlesQueryUrl asks for each page\'s current revision id', () => {
    const parsed = new URL(buildTitlesQueryUrl(['Foo']));
    assert.equal(parsed.searchParams.get('prop'), 'revisions');
    assert.equal(parsed.searchParams.get('rvprop'), 'ids');
    assert.equal(parsed.searchParams.get('rvlimit'), null, 'rvlimit is rejected for a multi-title query');
});

// A rerun of an earlier batch by its stored titles: an article renamed in
// between must resolve to the article, not to the leftover #REDIRECT stub.
test('buildTitlesQueryUrl asks MediaWiki to follow redirects', () => {
    const parsed = new URL(buildTitlesQueryUrl(['Foo']));
    assert.equal(parsed.searchParams.get('redirects'), '1');
});

test('buildTitlesQueryUrl rejects an empty title list', () => {
    assert.throws(() => buildTitlesQueryUrl([]), TypeError);
});

function fakeFetchJson(responses) {
    let call = 0;
    return async () => {
        const body = responses[call++];
        return { ok: true, json: async () => body };
    };
}

test('resolvePageIds maps titles to page ids, skipping missing pages', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            pages: [
                { pageid: 123, title: 'Foo' },
                { missing: true, title: 'Does Not Exist' },
            ],
        },
    }]);

    const result = await resolvePageIds(['Foo', 'Does Not Exist'], { fetchImpl });
    assert.equal(result.get('Foo'), 123);
    assert.equal(result.has('Does Not Exist'), false);
});

test('resolvePageIds also keys by the pre-normalization title MediaWiki was asked about', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            normalized: [{ from: 'foo_bar', to: 'Foo bar' }],
            pages: [{ pageid: 456, title: 'Foo bar' }],
        },
    }]);

    const result = await resolvePageIds(['foo_bar'], { fetchImpl });
    assert.equal(result.get('Foo bar'), 456, 'normalized form is keyed');
    assert.equal(result.get('foo_bar'), 456, 'original requested form is also keyed');
});

test('resolvePageIds batches requests and de-duplicates titles', async () => {
    const seenUrls = [];
    const fetchImpl = async (url) => {
        seenUrls.push(url);
        return { ok: true, json: async () => ({ query: { pages: [] } }) };
    };

    const titles = Array.from({ length: DEFAULT_BATCH_SIZE + 5 }, (_, i) => `Title ${i}`);
    titles.push('Title 0'); // duplicate

    await resolvePageIds(titles, { fetchImpl });
    assert.equal(seenUrls.length, 2, 'more than one batch worth of unique titles issues two requests');
});

test('resolvePageIds throws on a non-ok HTTP response', async () => {
    await assert.rejects(
        () => resolvePageIds(['Foo'], { fetchImpl: async () => ({ ok: false, status: 503 }) }),
        /HTTP 503/
    );
});

test('resolveTitleInfo returns the page id and its current revision', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            pages: [
                { pageid: 123, title: 'Foo', revisions: [{ revid: 98765, parentid: 98764 }] },
                { missing: true, title: 'Does Not Exist' },
            ],
        },
    }]);

    const result = await resolveTitleInfo(['Foo', 'Does Not Exist'], { fetchImpl });
    assert.deepEqual(result.get('Foo'), { pageId: 123, revisionId: 98765, title: 'Foo', redirectedFrom: null });
    assert.equal(result.has('Does Not Exist'), false);
});

// "The page exists" and "we know which revision to pin" are separable: a
// caller can still record the page id and read the article at latest.
test('resolveTitleInfo reports a null revision rather than dropping the page', async () => {
    const fetchImpl = fakeFetchJson([{ query: { pages: [{ pageid: 5, title: 'Foo' }] } }]);
    const result = await resolveTitleInfo(['Foo'], { fetchImpl });
    assert.deepEqual(result.get('Foo'), { pageId: 5, revisionId: null, title: 'Foo', redirectedFrom: null });
});

test('resolveTitleInfo keys the pre-normalization title too, like resolvePageIds', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            normalized: [{ from: 'foo_bar', to: 'Foo bar' }],
            pages: [{ pageid: 456, title: 'Foo bar', revisions: [{ revid: 7 }] }],
        },
    }]);

    const result = await resolveTitleInfo(['foo_bar'], { fetchImpl });
    assert.equal(result.get('foo_bar').revisionId, 7);
    assert.equal(result.get('Foo bar').revisionId, 7);
});

test('resolvePageIds is the page-id-only view of the same query', async () => {
    const fetchImpl = fakeFetchJson([{
        query: { pages: [{ pageid: 123, title: 'Foo', revisions: [{ revid: 98765 }] }] },
    }]);
    const result = await resolvePageIds(['Foo'], { fetchImpl });
    assert.equal(result.get('Foo'), 123, 'a bare number, not the {pageId, revisionId} record');
});

// The November 2026 ruwiki rerun: three of 1,023 titles had been renamed
// since they were stored, resolved to their redirect stubs, and were never
// checked. This is the API's shape for that (formatversion=2, redirects=1):
// the stub doesn't appear in `pages` at all, only in `redirects`.
test('resolveTitleInfo follows a redirect to the target article and says so', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            redirects: [{ from: 'Владимир (город, Россия)', to: 'Владимир' }],
            pages: [{ pageid: 31, title: 'Владимир', revisions: [{ revid: 555 }] }],
        },
    }]);

    const result = await resolveTitleInfo(['Владимир (город, Россия)'], { fetchImpl });
    assert.deepEqual(result.get('Владимир (город, Россия)'), {
        pageId: 31, revisionId: 555, title: 'Владимир', redirectedFrom: 'Владимир (город, Россия)',
    });
    assert.deepEqual(result.get('Владимир'),
        { pageId: 31, revisionId: 555, title: 'Владимир', redirectedFrom: null },
        'the target\'s own title is a direct entry, not a redirected one');
});

test('resolveTitleInfo follows normalization then a redirect, keying every hop', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            normalized: [{ from: 'warcraft_III:_Forsaken_Kingdom', to: 'Warcraft III: Forsaken Kingdom' }],
            redirects: [{ from: 'Warcraft III: Forsaken Kingdom', to: 'Warcraft III Reforged: Forsaken Kingdom' }],
            pages: [{ pageid: 8, title: 'Warcraft III Reforged: Forsaken Kingdom', revisions: [{ revid: 80 }] }],
        },
    }]);

    const requested = 'warcraft_III:_Forsaken_Kingdom';
    const result = await resolveTitleInfo([requested], { fetchImpl });
    const expected = {
        pageId: 8, revisionId: 80, title: 'Warcraft III Reforged: Forsaken Kingdom', redirectedFrom: requested,
    };
    assert.deepEqual(result.get(requested), expected, 'keyed under the title as requested');
    assert.deepEqual(result.get('Warcraft III: Forsaken Kingdom'), expected, 'and under the normalized form');
});

test('resolveTitleInfo walks a double redirect', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            redirects: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
            pages: [{ pageid: 3, title: 'C', revisions: [{ revid: 30 }] }],
        },
    }]);
    const result = await resolveTitleInfo(['A'], { fetchImpl });
    assert.equal(result.get('A').title, 'C');
    assert.equal(result.get('A').redirectedFrom, 'A');
});

test('normalization alone is not a redirect', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            normalized: [{ from: 'foo_bar', to: 'Foo bar' }],
            pages: [{ pageid: 456, title: 'Foo bar', revisions: [{ revid: 7 }] }],
        },
    }]);
    const result = await resolveTitleInfo(['foo_bar'], { fetchImpl });
    assert.equal(result.get('foo_bar').redirectedFrom, null);
    assert.equal(result.get('foo_bar').title, 'Foo bar');
});

test('a redirect to a missing page resolves to nothing', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            redirects: [{ from: 'Old', to: 'Gone' }],
            pages: [{ missing: true, title: 'Gone' }],
        },
    }]);
    const result = await resolveTitleInfo(['Old'], { fetchImpl });
    assert.equal(result.has('Old'), false);
    assert.equal(result.has('Gone'), false);
});

test('a redirect loop terminates and resolves to nothing', async () => {
    const fetchImpl = fakeFetchJson([{
        query: { redirects: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }], pages: [] },
    }]);
    const result = await resolveTitleInfo(['A'], { fetchImpl });
    assert.equal(result.has('A'), false);
});

test('resolvePageIds returns the target\'s page id for a redirected title', async () => {
    const fetchImpl = fakeFetchJson([{
        query: {
            redirects: [{ from: 'Old name', to: 'New name' }],
            pages: [{ pageid: 99, title: 'New name', revisions: [{ revid: 1 }] }],
        },
    }]);
    const result = await resolvePageIds(['Old name'], { fetchImpl });
    assert.equal(result.get('Old name'), 99);
});
