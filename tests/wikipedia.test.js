import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveRestUrl, fetchArticleHtml, apiHostForWikiDb, langCodeForWikiDb, DEFAULT_USER_AGENT } from '../core/wikipedia.js';

test('langCodeForWikiDb derives the language code from the wiki database name', () => {
    assert.equal(langCodeForWikiDb('enwiki'), 'en');
    assert.equal(langCodeForWikiDb('ruwiki'), 'ru');
    assert.equal(langCodeForWikiDb('simplewiki'), 'simple');
});

test('langCodeForWikiDb rejects names that do not end in "wiki"', () => {
    assert.throws(() => langCodeForWikiDb('enwiktionary'), RangeError);
    assert.throws(() => langCodeForWikiDb(''), RangeError);
    assert.throws(() => langCodeForWikiDb(undefined), RangeError);
});

test('apiHostForWikiDb derives the REST host from the wiki database name', () => {
    assert.equal(apiHostForWikiDb('enwiki'), 'en.wikipedia.org');
    assert.equal(apiHostForWikiDb('ruwiki'), 'ru.wikipedia.org');
    assert.equal(apiHostForWikiDb('simplewiki'), 'simple.wikipedia.org');
});

test('apiHostForWikiDb rejects names that do not end in "wiki"', () => {
    assert.throws(() => apiHostForWikiDb('enwiktionary'), RangeError);
    assert.throws(() => apiHostForWikiDb(''), RangeError);
    assert.throws(() => apiHostForWikiDb(undefined), RangeError);
});

test('deriveRestUrl builds the REST path, pinning a revision when given', () => {
    assert.equal(
        deriveRestUrl({ title: 'Great Migration (African American)' }),
        'https://en.wikipedia.org/api/rest_v1/page/html/Great_Migration_(African_American)'
    );
    assert.equal(
        deriveRestUrl({ title: 'Foo', revisionId: 12345 }),
        'https://en.wikipedia.org/api/rest_v1/page/html/Foo/12345'
    );
});

test('deriveRestUrl encodes slashes but leaves parentheses readable', () => {
    // '/' must be encoded or it splits the path segment; '(' and ')' are legal
    // and encoding them would not match the canonical article URL.
    assert.match(deriveRestUrl({ title: 'AC/DC' }), /AC%2FDC$/);
    assert.match(deriveRestUrl({ title: 'Mercury (element)' }), /Mercury_\(element\)$/);
});

test('deriveRestUrl honours a non-default host', () => {
    assert.match(
        deriveRestUrl({ title: 'Foo' }, { host: 'fr.wikipedia.org' }),
        /^https:\/\/fr\.wikipedia\.org\//
    );
});

test('deriveRestUrl requires a title', () => {
    assert.throws(() => deriveRestUrl({}), TypeError);
    assert.throws(() => deriveRestUrl(), TypeError);
});

test('fetchArticleHtml returns html and status on success', async () => {
    const result = await fetchArticleHtml({ title: 'Foo', revisionId: 9 }, {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>hi</html>' }),
    });

    assert.deepEqual(result, { html: '<html>hi</html>', status: 200, error: null });
});

test('fetchArticleHtml sends a descriptive User-Agent', async () => {
    let seen;
    await fetchArticleHtml({ title: 'Foo' }, {
        fetchImpl: async (_url, init) => {
            seen = init.headers;
            return { ok: true, status: 200, text: async () => '' };
        },
    });

    assert.equal(seen['User-Agent'], DEFAULT_USER_AGENT);
    assert.match(seen['User-Agent'], /github\.com/, 'UA must carry a contact URL');
});

test('an HTTP error is reported with its status, not thrown', async () => {
    const result = await fetchArticleHtml({ title: 'Nope' }, {
        fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    });

    assert.equal(result.html, null);
    assert.equal(result.status, 404);
    assert.match(result.error, /404/);
});

test('a network failure reports a null status, distinguishing it from an HTTP error', async () => {
    const result = await fetchArticleHtml({ title: 'Foo' }, {
        fetchImpl: async () => { throw new Error('ETIMEDOUT'); },
    });

    assert.equal(result.html, null);
    assert.equal(result.status, null, 'no response means no status');
    assert.match(result.error, /ETIMEDOUT/);
});

test('fetchArticleHtml times out a stalled connection rather than hanging forever', async () => {
    const result = await fetchArticleHtml({ title: 'Foo' }, {
        timeoutMs: 5,
        fetchImpl: (_url, init) => new Promise((resolve, reject) => {
            // Simulate a stalled connection: never resolves on its own, only
            // reacts to the abort signal our timeout fires — matching how a
            // real fetch() behaves when told to abort mid-flight.
            init.signal.addEventListener('abort', () => {
                const err = new Error('This operation was aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }),
    });

    assert.equal(result.html, null);
    assert.equal(result.status, null);
    assert.match(result.error, /timed out after 5ms/);
});

test('a bad title is reported rather than thrown', async () => {
    const result = await fetchArticleHtml({}, { fetchImpl: async () => { throw new Error('unreachable'); } });

    assert.equal(result.html, null);
    assert.match(result.error, /title/);
});
