import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSourceContent, logVerification } from '../core/worker.js';

function mockFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('fetchSourceContent returns null for Google Books URLs without hitting the network', async () => {
  const mock = mockFetch(async () => { throw new Error('should not be called'); });
  try {
    const result = await fetchSourceContent('https://books.google.com/books?id=abc', null);
    assert.equal(result, null);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent returns formatted source text on success', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: 'a'.repeat(500), truncated: false }),
  }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null, { augment: false });
    assert.ok(result.includes('Source URL: https://example.com/doc'));
    assert.ok(result.includes('Source Content:'));
    assert.ok(mock.calls[0].url.includes('?fetch=https%3A%2F%2Fexample.com%2Fdoc'));
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent prepends Citoid metadata header when Citoid returns data', async () => {
  const mock = mockFetch(async (url) => {
    if (url.includes('/api/rest_v1/data/citation/')) {
      return {
        ok: true,
        json: async () => ([{
          publicationTitle: 'Example Publication',
          date: '2026-05-08',
          title: 'Example Article',
        }]),
      };
    }
    return {
      ok: true,
      json: async () => ({ content: 'body content padded above the SHORT_BODY_FLOOR so the classifier passes it through. '.repeat(5), truncated: false }),
    };
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.ok(result.includes('"source_citation_metadata"'));
    assert.ok(result.includes('"publication": "Example Publication"'));
    assert.ok(result.includes('"published": "2026-05-08"'));
    assert.ok(result.includes('"title": "Example Article"'));
    assert.ok(result.includes('---'));
    assert.ok(result.includes('body content'));
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent leaves source unchanged when Citoid fails', async () => {
  const mock = mockFetch(async (url) => {
    if (url.includes('/api/rest_v1/data/citation/')) {
      return { ok: false, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({ content: 'untouched body padded above the SHORT_BODY_FLOOR so the classifier passes it through. '.repeat(5), truncated: false }),
    };
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.ok(!result.includes('source_citation_metadata'));
    assert.ok(result.includes('untouched body'));
  } finally {
    mock.restore();
  }
});

test('logVerification posts payload and swallows failures', async () => {
  const mock = mockFetch(async () => ({ ok: true, json: async () => ({}) }));
  try {
    assert.doesNotThrow(() => logVerification({
      article_url: 'https://en.wikipedia.org/wiki/Foo',
      article_title: 'Foo',
      citation_number: '3',
      source_url: 'https://example.com',
      provider: 'publicai',
      verdict: 'SUPPORTED',
      confidence: 'High',
    }));
    assert.equal(mock.calls[0].url, 'https://publicai-proxy.alaexis.workers.dev/log');
    assert.equal(mock.calls[0].opts.method, 'POST');
  } finally {
    mock.restore();
  }
});
