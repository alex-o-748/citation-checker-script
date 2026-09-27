import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMetrics, describeSource, outcomeFor, OUTCOMES } from '../api/metrics.js';
import { createRateLimiter, createVerifyServer } from '../api/server.js';

test('outcomeFor maps every status the API returns onto one outcome', () => {
  assert.equal(outcomeFor(200), OUTCOMES.OK);
  assert.equal(outcomeFor(422), OUTCOMES.SOURCE_UNAVAILABLE);
  assert.equal(outcomeFor(429), OUTCOMES.RATE_LIMITED);
  assert.equal(outcomeFor(502), OUTCOMES.UPSTREAM_ERROR);
  assert.equal(outcomeFor(500), OUTCOMES.UPSTREAM_ERROR);
  for (const status of [400, 413, 415]) assert.equal(outcomeFor(status), OUTCOMES.REJECTED);
});

test('describeSource keeps only the kind of source and a URL hostname, never content', () => {
  assert.deepEqual(describeSource({ claim: 'c', source_url: 'https://news.example.org/a?secret=1' }),
    { source: 'url', sourceHost: 'news.example.org' });
  // source_content wins when both are present, matching verifyRequest().
  assert.deepEqual(describeSource({ source_url: 'https://x.org', source_content: 'text' }),
    { source: 'content', sourceHost: null });
  assert.deepEqual(describeSource({ source_url: 'not a url' }), { source: 'url', sourceHost: null });
  assert.deepEqual(describeSource(null), { source: null, sourceHost: null });
});

test('snapshot windows, latency and health reflect recorded requests', () => {
  let time = Date.UTC(2026, 8, 27, 12, 0, 0);
  const metrics = createMetrics({ now: () => time });

  metrics.record({ status: 200, body: { verdict: 'SUPPORTED' }, durationMs: 1000, source: 'content' });
  metrics.record({ status: 200, body: { verdict: 'NOT SUPPORTED' }, durationMs: 3000, source: 'url', sourceHost: 'a.org' });
  metrics.record({ status: 422, body: { error: 'dead', stage: 'source' }, durationMs: 500, source: 'url', sourceHost: 'b.org' });
  // Refusals never reach the pipeline, so they must not drag latency down.
  metrics.record({ status: 429, body: { error: 'Rate limit exceeded' }, durationMs: 0 });
  metrics.record({ status: 400, body: { error: 'claim must be a non-empty string' }, durationMs: 0 });

  const snap = metrics.snapshot({ service: { provider: 'huggingface', model: 'm' } });
  const hour = snap.windows['1h'];
  assert.equal(hour.requests, 5);
  assert.deepEqual(hour.outcomes, { ok: 2, source_unavailable: 1, upstream_error: 0, rate_limited: 1, rejected: 1 });
  assert.deepEqual(hour.verdicts, { SUPPORTED: 1, 'NOT SUPPORTED': 1 });
  assert.deepEqual(hour.failed_stages, { source: 1 });
  assert.deepEqual(hour.sources, { content: 1, url: 2 });
  assert.deepEqual(hour.latency_ms, { n: 3, p50: 1000, p95: 3000, max: 3000 });
  assert.equal(snap.health.state, 'ok');
  assert.equal(snap.series.per_minute_1h.length, 60);
  assert.equal(snap.series.per_minute_1h.at(-1).requests, 5);
  assert.equal(snap.series.per_minute_1h.at(-1).avg_latency_ms, 1500);
  assert.equal(snap.series.per_15_minutes_24h.length, 96);
  assert.equal(snap.recent[0].status, 400);
  assert.equal(snap.last_failure.stage, 'source');

  // Upstream errors above a quarter of attempted calls mark the service degraded.
  metrics.record({ status: 502, body: { error: 'HTTP 503', stage: 'provider' }, durationMs: 200 });
  metrics.record({ status: 502, body: { error: 'HTTP 503', stage: 'provider' }, durationMs: 200 });
  assert.equal(metrics.snapshot().health.state, 'degraded');

  // Two hours later the hour window is empty, the day window still counts.
  time += 2 * 60 * 60_000;
  const later = metrics.snapshot();
  assert.equal(later.windows['1h'].requests, 0);
  assert.equal(later.windows['24h'].requests, 7);
  assert.equal(later.windows.since_start.requests, 7);
  assert.equal(later.health.state, 'idle');

  // Past a day, buckets age out of every window but the since-start total.
  time += 24 * 60 * 60_000;
  metrics.record({ status: 200, body: { verdict: 'SUPPORTED' }, durationMs: 10 });
  const dayLater = metrics.snapshot();
  assert.equal(dayLater.windows['24h'].requests, 1);
  assert.equal(dayLater.windows.since_start.requests, 8);
});

test('recent events are capped and carry no claim or source text', () => {
  const metrics = createMetrics({ recentLimit: 3 });
  for (let i = 0; i < 5; i++) metrics.record({ status: 200, body: { verdict: 'SUPPORTED', comments: 'secret' }, durationMs: i });
  const { recent } = metrics.snapshot();
  assert.equal(recent.length, 3);
  assert.deepEqual(Object.keys(recent[0]).sort(),
    ['at', 'duration_ms', 'outcome', 'source', 'source_host', 'stage', 'status', 'verdict']);
});

test('rate limiter peek reads the window without spending from it', () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => time });
  assert.equal(limiter.peek().remaining, 2);
  limiter();
  assert.equal(limiter.peek().remaining, 1);
  assert.equal(limiter.peek().remaining, 1);
  time = 61_000;
  assert.equal(limiter.peek().remaining, 2);
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

test('server records /v1/verify traffic and serves it at /metrics.json and /status', async () => {
  const verify = async body => body.claim === 'dead'
    ? { status: 422, body: { error: 'Source unavailable', stage: 'source' } }
    : { status: 200, body: { verdict: 'SUPPORTED' } };
  await withServer({ verify, rateLimit: createRateLimiter({ limit: 3 }) }, async base => {
    const post = (body, type = 'application/json') => fetch(`${base}/v1/verify`, {
      method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body),
    });
    await post({ claim: 'c', source_content: 's' });
    await post({ claim: 'dead', source_url: 'https://gone.example.org/x' });
    await post({ claim: 'c' }, 'text/plain');
    await post({ claim: 'c', source_content: 's' });
    await post({ claim: 'c', source_content: 's' }); // over the limit of 3

    // Reading the board spends nothing from the verify budget and isn't counted.
    const response = await fetch(`${base}/metrics.json`);
    assert.equal(response.status, 200);
    const snap = await response.json();
    assert.equal(snap.service.provider, 'huggingface');
    assert.equal(typeof snap.service.model, 'string');
    assert.deepEqual(snap.windows['1h'].outcomes,
      { ok: 2, source_unavailable: 1, upstream_error: 0, rate_limited: 1, rejected: 1 });
    assert.deepEqual(snap.rate_limit, { limit: 3, remaining: 0, reset_seconds: snap.rate_limit.reset_seconds, window_seconds: 60 });
    const dead = snap.recent.find(r => r.status === 422);
    assert.equal(dead.source_host, 'gone.example.org');
    assert.equal(JSON.stringify(snap).includes('/x'), false);

    const page = await fetch(`${base}/status`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    const html = await page.text();
    assert.match(html, /fetch\('metrics\.json'/);
    // Toolforge forbids third-party resources; the page must load nothing external.
    assert.equal(/(src|href)=["']https?:/i.test(html), false);
  });
});
