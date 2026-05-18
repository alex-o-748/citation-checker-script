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
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.ok(result.includes('Source URL: https://example.com/doc'));
    assert.ok(result.includes('Source Content:'));
    assert.ok(mock.calls[0].url.includes('?fetch=https%3A%2F%2Fexample.com%2Fdoc'));
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent forwards claim as URL-encoded &query=', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: 'a'.repeat(500), truncated: false }),
  }));
  try {
    await fetchSourceContent('https://example.com/doc', null, {
      claim: 'foo & bar = baz?',
    });
    const url = mock.calls[0].url;
    assert.ok(url.includes('&query=foo%20%26%20bar%20%3D%20baz%3F'),
      `expected URL-encoded &query=, got: ${url}`);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent omits &query= when no claim is supplied', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: 'a'.repeat(500), truncated: false }),
  }));
  try {
    await fetchSourceContent('https://example.com/doc', null);
    assert.ok(!mock.calls[0].url.includes('query='),
      `did not expect &query=, got: ${mock.calls[0].url}`);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent combines &page= and &query= when both supplied', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: 'a'.repeat(500), truncated: false }),
  }));
  try {
    await fetchSourceContent('https://example.com/doc', 7, { claim: 'hello' });
    const url = mock.calls[0].url;
    assert.ok(url.includes('&page=7'), `missing &page=7: ${url}`);
    assert.ok(url.includes('&query=hello'), `missing &query=hello: ${url}`);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent omits &query= for empty-string claim', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    json: async () => ({ content: 'a'.repeat(500), truncated: false }),
  }));
  try {
    await fetchSourceContent('https://example.com/doc', null, { claim: '' });
    assert.ok(!mock.calls[0].url.includes('query='),
      `expected empty claim to be skipped: ${mock.calls[0].url}`);
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
