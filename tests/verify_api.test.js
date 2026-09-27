import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, createVerifyServer } from '../api/server.js';
import { verifyRequest } from '../api/verify.js';

const MODEL_RESPONSE = {
  verdict: 'SUPPORTED', support_score: 98,
  comments: 'The source says this directly.',
  source_quote: 'The bridge opened in 1998.',
};

test('verifyRequest delegates to the shared pipeline and preserves its public verdict shape', async () => {
  let fetched = null;
  const result = await verifyRequest({
    claim: 'The bridge opened in 1998.', source_url: 'https://example.org/bridge', page: 3,
  }, {
    provider: 'huggingface', model: 'the-deployed-model',
    fetchSource: async (url, page) => {
      fetched = { url, page };
      return { content: 'Source Content:\nThe bridge opened in 1998.', status: 200 };
    },
    callProvider: async () => ({ text: JSON.stringify(MODEL_RESPONSE), usage: null }),
  });
  assert.deepEqual(fetched, { url: 'https://example.org/bridge', page: 3 });
  assert.deepEqual(result, { status: 200, body: {
    verdict: 'SUPPORTED', support_score: 98,
    comments: 'The source says this directly.', reason_type: null,
    source_quote: 'The bridge opened in 1998.', quote_status: 'exact',
    verified_text: 'The bridge opened in 1998.',
  } });
});

test('verifyRequest accepts source text without fetching a URL', async () => {
  const result = await verifyRequest({ claim: 'The bridge opened in 1998.', source_content: 'The bridge opened in 1998.' }, {
    fetchSource: async () => assert.fail('source_content must skip fetching'),
    callProvider: async () => ({ text: JSON.stringify(MODEL_RESPONSE), usage: null }),
  });
  assert.equal(result.status, 200);
});

test('verifyRequest preserves source content exactly and rejects unknown fields', async () => {
  let userContent;
  const source = '  The bridge opened in 1998.\n';
  const result = await verifyRequest({ claim: 'Claim', source_content: source }, {
    callProvider: async (_provider, options) => {
      userContent = options.userContent;
      return { text: JSON.stringify({ ...MODEL_RESPONSE, source_quote: '' }), usage: null };
    },
  });
  assert.equal(result.status, 200);
  assert.ok(userContent.endsWith(source));

  const unknown = await verifyRequest({ claim: 'Claim', source_content: source, provider: 'openai' });
  assert.deepEqual(unknown, { status: 400, body: { error: 'Unknown field: provider' } });
});

test('verifyRequest rejects malformed requests before inference', async () => {
  let called = false;
  const result = await verifyRequest({ claim: '', source_url: 'file:///etc/passwd' }, {
    callProvider: async () => { called = true; },
  });
  assert.deepEqual(result, { status: 400, body: { error: 'claim must be a non-empty string' } });
  assert.equal(called, false);
  const badUrl = await verifyRequest({ claim: 'claim', source_url: 'file:///etc/passwd' });
  assert.equal(badUrl.status, 400);
  assert.match(badUrl.body.error, /http or https/);
});

test('rate limiter has a fixed window per client address', () => {
  let now = 1000;
  const limit = createRateLimiter({ limit: 2, windowMs: 5000, now: () => now });
  assert.deepEqual(limit('a'), { allowed: true, limit: 2, remaining: 1, resetSeconds: 5 });
  assert.equal(limit('a').allowed, true);
  assert.equal(limit('a').allowed, false);
  assert.equal(limit('b').allowed, true);
  now = 6000;
  assert.equal(limit('a').allowed, true);
});

async function withServer(options, fn) {
  const server = createVerifyServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('HTTP endpoint supports JSON POST and Wikipedia-scoped CORS', async () => {
  await withServer({ verify: async () => ({ status: 200, body: { verdict: 'SUPPORTED' } }) }, async base => {
    const response = await fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://en.wikipedia.org' },
      body: JSON.stringify({ claim: 'c', source_content: 's' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://en.wikipedia.org');
    assert.equal(response.headers.get('ratelimit-limit'), '10');
    assert.deepEqual(await response.json(), { verdict: 'SUPPORTED' });
    const foreign = await fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.org' }, body: '{}',
    });
    assert.equal(foreign.headers.has('access-control-allow-origin'), false);
  });
});

test('HTTP endpoint serves discoverable OpenAPI documentation', async () => {
  await withServer({}, async base => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.equal((await index.json()).documentation, '/openapi.json');

    const response = await fetch(`${base}/openapi.json`);
    const spec = await response.json();
    assert.equal(response.status, 200);
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/v1/verify'].post);
  });
});

test('HTTP endpoint requires a JSON content type', async () => {
  let calls = 0;
  await withServer({ verify: async () => { calls += 1; return { status: 200, body: {} }; } }, async base => {
    const response = await fetch(`${base}/v1/verify`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: 'Content-Type must be application/json' });
    assert.equal(calls, 0);
  });
});

test('HTTP endpoint returns 413 before verification and enforces rate limits', async () => {
  let calls = 0;
  await withServer({
    verify: async () => { calls += 1; return { status: 200, body: {} }; },
    rateLimit: createRateLimiter({ limit: 1 }),
  }, async base => {
    const oversized = await fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_content: 'x'.repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
    const limited = await fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});
