import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTitlesQueryUrl, resolvePageIds, DEFAULT_BATCH_SIZE } from '../service/wikipedia-pageids.js';

test('buildTitlesQueryUrl pipe-joins titles into one Action API request', () => {
    const url = buildTitlesQueryUrl(['Foo', 'Bar Baz']);
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'en.wikipedia.org');
    assert.equal(parsed.searchParams.get('action'), 'query');
    assert.equal(parsed.searchParams.get('titles'), 'Foo|Bar Baz');
    assert.equal(parsed.searchParams.get('formatversion'), '2');
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
