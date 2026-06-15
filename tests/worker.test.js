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

test('fetchSourceContent skips Google Books URLs without hitting the network', async () => {
  const mock = mockFetch(async () => { throw new Error('should not be called'); });
  try {
    const result = await fetchSourceContent('https://books.google.com/books?id=abc', null);
    assert.equal(result.content, null);
    assert.match(result.error, /google books/i);
    assert.equal(result.status, null);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent returns formatted source text on success', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: 'a'.repeat(500), truncated: false }),
  }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.ok(result.content.includes('Source URL: https://example.com/doc'));
    assert.ok(result.content.includes('Source Content:'));
    assert.equal(result.error, null);
    assert.equal(result.status, 200);
    assert.ok(mock.calls[0].url.includes('?fetch=https%3A%2F%2Fexample.com%2Fdoc'));
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent surfaces proxy error messages and the upstream status', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: 'upstream returned 503', status: 503 }),
  }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.equal(result.error, 'upstream returned 503');
    assert.equal(result.status, 503);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent falls back to the proxy status when the body has none', async () => {
  const mock = mockFetch(async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: 'bad gateway' }),
  }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.equal(result.error, 'bad gateway');
    assert.equal(result.status, 502);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent reports non-JSON proxy responses', async () => {
  const mock = mockFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => { throw new SyntaxError('Unexpected token'); },
  }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.match(result.error, /non-JSON/);
    assert.equal(result.status, 500);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent reports too-short content', async () => {
  const mock = mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: 'tiny' }),
  }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.match(result.error, /empty|short/i);
    assert.equal(result.status, 200);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent reports network failures with a null status', async () => {
  const mock = mockFetch(async () => { throw new Error('ECONNRESET'); });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.equal(result.error, 'ECONNRESET');
    assert.equal(result.status, null);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent converts archive.org URLs to raw id_ endpoint', async () => {
  const mock = mockFetch(async (url) => {
    assert.ok(url.includes(encodeURIComponent('https://web.archive.org/web/20250515id_/https://example.com/page')),
      'should fetch via id_ raw endpoint');
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: 'a'.repeat(500), truncated: false }),
    };
  });
  try {
    const result = await fetchSourceContent(
      'https://web.archive.org/web/20250515/https://example.com/page', null);
    assert.ok(result.content);
    assert.ok(result.content.includes('Source URL: https://web.archive.org/web/20250515/https://example.com/page'),
      'metadata should show the original archive URL');
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent tries Wayback fallback when live fetch fails', async () => {
  let callCount = 0;
  const mock = mockFetch(async (url) => {
    callCount++;
    if (callCount === 1) {
      // Live fetch fails
      return {
        ok: true, status: 200,
        json: async () => ({ error: 'upstream returned 404', status: 404 }),
      };
    }
    // Wayback raw fetch via proxy succeeds
    assert.ok(url.includes(encodeURIComponent('web.archive.org/web/2id_/')),
      'should fetch via Wayback raw URL through proxy');
    return {
      ok: true, status: 200,
      json: async () => ({ content: 'b'.repeat(500), truncated: false }),
    };
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.ok(result.content);
    assert.ok(result.content.includes('Source URL: https://example.com/doc'));
    assert.equal(callCount, 2);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent returns original error when Wayback fallback also fails', async () => {
  let callCount = 0;
  const mock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({ error: 'upstream returned 404', status: 404 }),
      };
    }
    // Wayback also fails
    return {
      ok: true, status: 200,
      json: async () => ({ error: 'upstream returned 404', status: 404 }),
    };
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.equal(result.error, 'upstream returned 404');
    assert.equal(callCount, 2);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent handles Wayback fetch network failure gracefully', async () => {
  let callCount = 0;
  const mock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({ error: 'upstream returned 503', status: 503 }),
      };
    }
    // Wayback proxy fetch itself fails
    throw new Error('network error');
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.equal(result.content, null);
    assert.equal(result.error, 'upstream returned 503');
    assert.equal(callCount, 2);
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
