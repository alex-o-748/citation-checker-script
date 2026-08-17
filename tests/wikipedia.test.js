import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveRestUrl, fetchArticleHtml, DEFAULT_USER_AGENT } from '../core/wikipedia.js';

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

test('a bad title is reported rather than thrown', async () => {
    const result = await fetchArticleHtml({}, { fetchImpl: async () => { throw new Error('unreachable'); } });

    assert.equal(result.html, null);
    assert.match(result.error, /title/);
});
