import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVerifyServer } from '../api/server.js';
import { createSearchBudget, searchRequest, SEARCH_EXCLUDE_DOMAINS } from '../api/search.js';
import { MAX_SOURCE_CONTENT_CHARS } from '../api/verify.js';

function fakeTavily(results, { status = 200, emptyFirst = 0 } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const answer = calls.length <= emptyFirst ? [] : results;
    return new Response(JSON.stringify({ results: answer }), { status });
  };
  return { doFetch, calls };
}

test('searchRequest sends one basic Tavily search and returns verify-ready text', async () => {
  const { doFetch, calls } = fakeTavily([
    { url: 'https://example.org/a', title: 'A', score: 0.9, content: 'excerpt', raw_content: 'the whole page' },
    { url: 'https://example.org/b', title: '', score: 0.5, content: 'only an excerpt' },
    { url: 'javascript:alert(1)', title: 'bad', content: 'x' },
    { url: 'https://example.org/empty', title: 'E', content: '  ' },
  ]);
  const result = await searchRequest({ query: ' KCC Malls: KCC started in 1947 ' }, { fetch: doFetch, apiKey: 'tvly-test' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results, [
    { url: 'https://example.org/a', title: 'A', score: 0.9, text: 'excerpt\n\nthe whole page' },
    { url: 'https://example.org/b', title: 'https://example.org/b', score: 0.5, text: 'only an excerpt' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tvly-test');
  assert.equal(calls[0].body.query, 'KCC Malls: KCC started in 1947');
  assert.equal(calls[0].body.search_depth, 'basic');
  assert.ok(calls[0].body.exclude_domains.includes('wikipedia.org'));
});

test('searchRequest uses keyless mode without a key, and callers can only add exclusions', async () => {
  const { doFetch, calls } = fakeTavily([]);
  await searchRequest({ query: 'q', exclude_domains: ['Example.COM'] }, { fetch: doFetch, apiKey: '' });
  assert.equal(calls[0].init.headers['X-Tavily-Access-Mode'], 'keyless');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  for (const d of SEARCH_EXCLUDE_DOMAINS) assert.ok(calls[0].body.exclude_domains.includes(d));
  assert.ok(calls[0].body.exclude_domains.includes('example.com'));
});

test('searchRequest retries once when the provider answers with no results', async () => {
  const hit = [{ url: 'https://example.org/a', title: 'A', content: 'excerpt' }];
  const flaky = fakeTavily(hit, { emptyFirst: 1 });
  const retried = await searchRequest({ query: 'q' }, { fetch: flaky.doFetch, apiKey: 'k' });
  assert.equal(flaky.calls.length, 2);
  assert.equal(retried.body.results.length, 1);

  const none = fakeTavily(hit, { emptyFirst: 5 });
  const empty = await searchRequest({ query: 'q' }, { fetch: none.doFetch, apiKey: 'k' });
  assert.equal(none.calls.length, 2);
  assert.deepEqual(empty, { status: 200, body: { results: [] } });

  const found = fakeTavily(hit);
  await searchRequest({ query: 'q' }, { fetch: found.doFetch, apiKey: 'k' });
  assert.equal(found.calls.length, 1);
});

test('searchRequest cuts text to what /v1/verify accepts', async () => {
  const { doFetch } = fakeTavily([{ url: 'https://example.org/long', title: 'L', content: 'e', raw_content: 'x'.repeat(MAX_SOURCE_CONTENT_CHARS * 2) }]);
  const result = await searchRequest({ query: 'q' }, { fetch: doFetch, apiKey: 'k' });
  assert.equal(result.body.results[0].text.length, MAX_SOURCE_CONTENT_CHARS);
});

test('searchRequest validates the request before spending a call', async () => {
  const doFetch = async () => assert.fail('an invalid request must not reach the provider');
  for (const [body, error] of [
    [{}, 'query is required'],
    [{ query: '   ' }, 'query is required'],
    [{ query: 'x'.repeat(401) }, 'query exceeds 400 characters'],
    [{ query: 'q', max_results: 50 }, 'Unknown field: max_results'],
    [{ query: 'q', exclude_domains: ['not a domain'] }, 'exclude_domains must contain domain names'],
  ]) {
    assert.deepEqual(await searchRequest(body, { fetch: doFetch }), { status: 400, body: { error } });
  }
});

test('searchRequest maps provider failures to 429 and 502', async () => {
  assert.equal((await searchRequest({ query: 'q' }, { fetch: fakeTavily([], { status: 429 }).doFetch })).status, 429);
  assert.equal((await searchRequest({ query: 'q' }, { fetch: fakeTavily([], { status: 500 }).doFetch })).status, 502);
  const unreachable = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await searchRequest({ query: 'q' }, { fetch: unreachable })).status, 502);
});

test('the daily search budget stops calls and resets the next UTC day', async () => {
  let time = Date.parse('2026-10-04T23:00:00Z');
  const budget = createSearchBudget({ limit: 2, now: () => time });
  const { doFetch, calls } = fakeTavily([{ url: 'https://example.org/a', title: 'A', content: 'x' }]);
  assert.equal((await searchRequest({ query: 'q' }, { fetch: doFetch, budget })).status, 200);
  assert.equal((await searchRequest({ query: 'q' }, { fetch: doFetch, budget })).status, 200);
  const spent = await searchRequest({ query: 'q' }, { fetch: doFetch, budget });
  assert.equal(spent.status, 429);
  assert.equal(calls.length, 2);
  assert.equal(budget.peek().remaining, 0);
  time = Date.parse('2026-10-05T00:30:00Z');
  assert.equal(budget.peek().remaining, 2);
  assert.equal((await searchRequest({ query: 'q' }, { fetch: doFetch, budget })).status, 200);
});

async function withServer(options, fn) {
  const server = createVerifyServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('POST /v1/search is served with Wikipedia CORS, a JSON type and its own rate limit', async () => {
  let calls = 0;
  const search = async (body, { budget }) => {
    calls += 1;
    assert.equal(typeof budget, 'function');
    return { status: 200, body: { results: [{ url: 'https://example.org', title: 't', score: 1, text: body.query }] } };
  };
  await withServer({ search }, async base => {
    const preflight = await fetch(`${base}/v1/search`, { method: 'OPTIONS', headers: { Origin: 'https://fr.wikipedia.org' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://fr.wikipedia.org');

    const ok = await fetch(`${base}/v1/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://en.wikipedia.org' },
      body: JSON.stringify({ query: 'hello' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://en.wikipedia.org');
    assert.equal((await ok.json()).results[0].text, 'hello');

    const untyped = await fetch(`${base}/v1/search`, { method: 'POST', body: '{}' });
    assert.equal(untyped.status, 415);
    assert.equal(calls, 1);

    const index = await (await fetch(`${base}/`)).json();
    assert.equal(index.search, '/v1/search');
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.ok(spec.paths['/v1/search'].post);
  });

  await withServer({ search, searchRateLimit: Object.assign(() => ({ allowed: false, resetSeconds: 7 }), { peek: () => null }) }, async base => {
    const limited = await fetch(`${base}/v1/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '7');
  });
});
