import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    ARTICLE_OUTCOMES,
    processArticle,
    runBatch,
    sourceCacheKey,
} from '../service/claim-extractor.js';

const parseHtml = html => new JSDOM(html).window.document;

// Parsoid-shaped article HTML: anchors carry a "./Title#..." href and there is
// no #mw-content-text wrapper.
function article(prose, footnotes) {
    const body = prose.replace(/@@(\S+?)@@/g, (_, id) =>
        `<sup id="cite_ref-${id}" class="reference"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`
    );
    const list = Object.entries(footnotes)
        .map(([id, html]) => `<li id="cite_note-${id}">${html}</li>`)
        .join('');
    return `<!DOCTYPE html><body>${body}<ol class="references">${list}</ol></body>`;
}

const link = url => `<a rel="nofollow" class="external text" href="${url}">source</a>`;

const okArticle = article(
    '<p>The bridge opened to traffic in 1998.@@1@@ It cost 40 million.@@2@@</p>',
    { 1: link('https://example.com/a'), 2: link('https://example.com/b') }
);

const candidate = { pageId: 7, title: 'Test Article', revisionId: 123 };

const fetchArticleOk = async () => ({ html: okArticle, status: 200, error: null });
const fetchSourceOk = async url => ({ content: `text of ${url}`, status: 200, error: null });

test('processArticle extracts citations and attaches fetched sources', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        fetchArticle: fetchArticleOk,
    });

    assert.equal(result.outcome, ARTICLE_OUTCOMES.OK);
    assert.equal(result.pageId, 7);
    assert.equal(result.revisionId, 123, 'the pinned revision rides along with the result');
    assert.equal(result.citations.length, 2);

    const [first] = result.citations;
    assert.equal(first.claimText, 'The bridge opened to traffic in 1998.');
    assert.equal(first.url, 'https://example.com/a');
    assert.equal(first.source.content, 'text of https://example.com/a');
    assert.equal(first.source.unavailableReason, null);
    assert.equal(first.refName, null, 'an unnamed ref has no name to recover');
});

test('processArticle carries a named ref\'s recovered name through to its citation', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        fetchArticle: async () => ({
            html: article('<p>The bridge opened to traffic in 1998.@@smith2001-1@@</p>',
                { 'smith2001-1': link('https://example.com/a') }),
            status: 200, error: null,
        }),
    });

    assert.equal(result.citations[0].refName, 'smith2001');
});

test('processArticle pins the revision it was asked for', async () => {
    const seen = [];
    await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        fetchArticle: async args => { seen.push(args); return fetchArticleOk(); },
    });

    assert.deepEqual(seen, [{ title: 'Test Article', revisionId: 123 }]);
});

test('a failed article fetch is reported, not thrown', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        fetchArticle: async () => ({ html: null, status: 404, error: 'not found' }),
    });

    assert.equal(result.outcome, ARTICLE_OUTCOMES.FETCH_FAILED);
    assert.equal(result.fetchStatus, 404);
    assert.deepEqual(result.citations, []);
});

test('an article with no citations is distinguished from a fetch failure', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        fetchArticle: async () => ({ html: article('<p>Nothing cited here.</p>', {}), status: 200, error: null }),
    });

    assert.equal(result.outcome, ARTICLE_OUTCOMES.NO_CITATIONS);
});

test('a citation with no URL records why, without calling the fetcher', async () => {
    let calls = 0;
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: async (...a) => { calls++; return fetchSourceOk(...a); },
        fetchArticle: async () => ({
            html: article('<p>The bridge opened to traffic in 1998.@@1@@</p>',
                { 1: 'Smith, J. <i>Bridges</i>, 2001.' }),
            status: 200, error: null,
        }),
    });

    assert.equal(result.citations[0].source.unavailableReason, 'no_url');
    assert.equal(result.citations[0].source.content, null);
    assert.equal(calls, 0, 'no URL means nothing to fetch');
});

test('a failed source fetch keeps its upstream status for retry classification', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: async () => ({ content: null, status: 403, error: 'forbidden' }),
    });

    const [first] = result.citations;
    assert.equal(first.source.unavailableReason, 'fetch_failed');
    assert.equal(first.source.status, 403, '403 must stay distinguishable from a dead link');
});

test('a throwing source fetcher does not abort the article', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: async () => { throw new Error('socket hang up'); },
    });

    assert.equal(result.outcome, ARTICLE_OUTCOMES.OK);
    assert.equal(result.citations.length, 2, 'both citations still reported');
    assert.equal(result.citations[0].source.unavailableReason, 'fetch_failed');
    assert.equal(result.citations[0].source.status, null, 'no response means no status');
    assert.match(result.citations[0].source.error, /socket hang up/);
});

test('the same source is fetched once per article and reported as cached', async () => {
    let calls = 0;
    const result = await processArticle(candidate, {
        parseHtml,
        fetchArticle: async () => ({
            html: article(
                '<p>First claim about the bridge.@@1@@ Second claim about the bridge.@@2@@</p>',
                { 1: link('https://example.com/same'), 2: link('https://example.com/same') }
            ),
            status: 200, error: null,
        }),
        fetchSource: async (...a) => { calls++; return fetchSourceOk(...a); },
    });

    assert.equal(calls, 1, 'one fetch for two citations of the same URL');
    assert.equal(result.citations[0].source.cached, false);
    assert.equal(result.citations[1].source.cached, true);
    assert.equal(result.citations[1].source.content, 'text of https://example.com/same');
});

test('sourceCacheKey separates pages of the same PDF', () => {
    assert.equal(sourceCacheKey('https://e.com/a.pdf', null), 'https://e.com/a.pdf');
    assert.notEqual(
        sourceCacheKey('https://e.com/a.pdf', 12),
        sourceCacheKey('https://e.com/a.pdf', 40)
    );
});

test('adjacent-citation group metadata survives into the result', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchArticle: async () => ({
            html: article('<p>The treaty was signed in Paris in 1990.@@1@@@@2@@</p>',
                { 1: link('https://example.com/a'), 2: link('https://example.com/b') }),
            status: 200, error: null,
        }),
        fetchSource: fetchSourceOk,
    });

    const [a, b] = result.citations;
    assert.equal(a.groupSize, 2);
    assert.equal(a.groupId, b.groupId);
    assert.deepEqual(a.groupCitationNumbers, ['1', '2']);
});

test('runBatch shares one source cache across articles', async () => {
    let calls = 0;
    const candidates = [
        { pageId: 1, title: 'A', revisionId: 10 },
        { pageId: 2, title: 'B', revisionId: 20 },
    ];

    const results = [];
    for await (const r of runBatch(candidates, {
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: async (...a) => { calls++; return fetchSourceOk(...a); },
    })) {
        results.push(r);
    }

    assert.equal(results.length, 2);
    assert.equal(calls, 2, 'both articles cite the same two URLs — fetched once in total');
    assert.equal(results[1].citations[0].source.cached, true);
});

test('runBatch stops when the signal aborts', async () => {
    const controller = new AbortController();
    const candidates = [
        { pageId: 1, title: 'A', revisionId: 10 },
        { pageId: 2, title: 'B', revisionId: 20 },
    ];

    const seen = [];
    for await (const r of runBatch(candidates, {
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: fetchSourceOk,
        signal: controller.signal,
    })) {
        seen.push(r);
        controller.abort();
    }

    assert.equal(seen.length, 1, 'aborting stops the sweep after the current article');
});

test('processArticle defaults to sentence-scope claims — a leading unsupported sentence does not bleed into the flagged claim', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        fetchArticle: async () => ({
            html: article(
                '<p>Elvis is still alive today. The bridge opened to traffic in 1998.@@1@@</p>',
                { 1: link('https://example.com/a') }
            ),
            status: 200, error: null,
        }),
    });

    assert.equal(result.citations[0].claimText, 'The bridge opened to traffic in 1998.');
});

test('processArticle can be told to use paragraph-scope claims instead', async () => {
    const result = await processArticle(candidate, {
        parseHtml,
        fetchSource: fetchSourceOk,
        claimScope: 'paragraph',
        fetchArticle: async () => ({
            html: article(
                '<p>Elvis is still alive today. The bridge opened to traffic in 1998.@@1@@</p>',
                { 1: link('https://example.com/a') }
            ),
            status: 200, error: null,
        }),
    });

    assert.equal(result.citations[0].claimText, 'Elvis is still alive today. The bridge opened to traffic in 1998.');
});

test('processArticle rejects missing collaborators loudly', async () => {
    await assert.rejects(
        () => processArticle(candidate, { fetchSource: fetchSourceOk }),
        TypeError
    );
    await assert.rejects(
        () => processArticle(candidate, { parseHtml }),
        TypeError
    );
});
