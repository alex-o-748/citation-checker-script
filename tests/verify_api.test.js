import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, createVerifyServer } from '../api/server.js';
import {
  MAX_BODY_BYTES, MAX_CLAIM_CHARS, MAX_SOURCE_CONTENT_CHARS, verifyRequest,
} from '../api/verify.js';
import { modelFor } from '../core/models.js';

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

test('verifyRequest fetches source_url when source_content is only whitespace', async () => {
  // Validation treats whitespace-only content as absent; the adapter must too,
  // or it skips the fetch and the model judges the claim against nothing.
  let fetched = false;
  let userContent;
  const result = await verifyRequest({
    claim: 'The bridge opened in 1998.', source_url: 'https://example.org/bridge', source_content: ' \n\t ',
  }, {
    fetchSource: async () => {
      fetched = true;
      return { content: 'Source Content:\nThe span opened to traffic in 1998.', status: 200 };
    },
    callProvider: async (_provider, options) => {
      userContent = options.userContent;
      return { text: JSON.stringify({ ...MODEL_RESPONSE, source_quote: '' }), usage: null };
    },
  });
  assert.equal(fetched, true);
  assert.match(userContent, /opened to traffic/);
  assert.equal(result.status, 200);
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

test('rate limiter is one fixed window shared by every caller', () => {
  // Toolforge's front proxy hides client addresses, so there is no per-client
  // key: a caller the limiter can't tell apart must draw on the same budget.
  let now = 1000;
  const limit = createRateLimiter({ limit: 2, windowMs: 5000, now: () => now });
  assert.deepEqual(limit(), { allowed: true, limit: 2, remaining: 1, resetSeconds: 5 });
  assert.equal(limit('ignored-key').allowed, true);
  assert.equal(limit('another-key').allowed, false);
  now = 6000;
  assert.equal(limit().allowed, true);
});

test('verifyRequest sends every model call to Lift Wing through tf-llm-router', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(MODEL_RESPONSE) } }] }),
    };
  };
  let result;
  try {
    result = await verifyRequest({ claim: 'The bridge opened in 1998.', source_content: 'The bridge opened in 1998.' });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://llm-router.toolforge.org/liftwing');
  assert.equal(calls[0].body.model, modelFor('liftwing'));
});

test('verifyRequest fetches source_url through tf-source-fetcher, not the Cloudflare worker', async () => {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('https://source-fetcher.toolforge.org/')) {
      return { ok: true, status: 200, json: async () => ({ content: `The bridge opened in 1998. ${'Filler. '.repeat(20)}`, status: 200 }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(MODEL_RESPONSE) } }] }),
    };
  };
  let result;
  try {
    result = await verifyRequest({ claim: 'The bridge opened in 1998.', source_url: 'https://example.org/bridge', page: 2 });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(result.status, 200);
  assert.deepEqual(urls, [
    `https://source-fetcher.toolforge.org/?fetch=${encodeURIComponent('https://example.org/bridge')}&page=2`,
    'https://llm-router.toolforge.org/liftwing',
  ]);
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

// Escapes every non-ASCII character as \uXXXX, as Python's json.dumps does by
// default: six bytes per UTF-16 unit, the most any JSON encoder spends.
function asciiOnlyJson(value) {
  return JSON.stringify(value)
    .replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

test('HTTP body limit admits the longest claim and source in any script and JSON encoding', async () => {
  // The documented limits are in characters. The byte cap must never undercut
  // them, e.g. by turning away a non-English source a Latin one would fit in.
  let received;
  await withServer({ verify: async body => { received = body; return { status: 200, body: {} }; } }, async base => {
    const request = {
      claim: 'ж'.repeat(MAX_CLAIM_CHARS),
      source_url: `https://example.org/${'a'.repeat(2000)}`,
      source_content: '中'.repeat(MAX_SOURCE_CONTENT_CHARS),
      page: 12,
    };
    const response = await fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: asciiOnlyJson(request),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, request);
  });

  // So the character limit is the one a caller actually meets.
  const tooLong = await verifyRequest({ claim: 'c', source_content: '中'.repeat(MAX_SOURCE_CONTENT_CHARS + 1) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /source_content must not exceed/);
});

test('HTTP endpoint returns 413 before verification and enforces rate limits', async () => {
  let calls = 0;
  await withServer({
    verify: async () => { calls += 1; return { status: 200, body: {} }; },
    rateLimit: createRateLimiter({ limit: 1 }),
  }, async base => {
    const oversized = await fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_content: 'x'.repeat(MAX_BODY_BYTES) }),
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
