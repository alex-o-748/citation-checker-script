import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchSourceContent,
    logVerification,
    isRetryableProxyResult,
    DEFAULT_SOURCE_FETCH_TIMEOUT_MS,
    DEFAULT_SOURCE_FETCH_RETRY,
} from '../core/worker.js';

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
    if (callCount === 2) {
      // Wayback availability API
      assert.ok(url.includes('archive.org/wayback/available'));
      return {
        ok: true, status: 200,
        json: async () => ({
          archived_snapshots: {
            closest: { available: true, timestamp: '20240101120000', url: 'http://web.archive.org/web/20240101120000/https://example.com/doc' }
          }
        }),
      };
    }
    // Wayback fetch via proxy
    return {
      ok: true, status: 200,
      json: async () => ({ content: 'b'.repeat(500), truncated: false }),
    };
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null);
    assert.ok(result.content);
    assert.ok(result.content.includes('Source URL: https://example.com/doc'));
    assert.equal(callCount, 3);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent skips Wayback fallback when no snapshot exists', async () => {
  let callCount = 0;
  const mock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({ error: 'upstream returned 404', status: 404 }),
      };
    }
    // Wayback says no snapshot
    return {
      ok: true, status: 200,
      json: async () => ({ archived_snapshots: {} }),
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

test('fetchSourceContent handles Wayback API failure gracefully', async () => {
  let callCount = 0;
  const mock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({ error: 'upstream returned 503', status: 503 }),
      };
    }
    // Wayback API itself fails
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

test('fetchSourceContent with archiveFirst never fetches the live URL', async () => {
  const mock = mockFetch(async (url) => {
    assert.ok(url.includes('archive.org/wayback/available') || url.includes('web.archive.org'),
      `should only contact archive.org, got: ${url}`);
    if (url.includes('wayback/available')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          archived_snapshots: {
            closest: { available: true, timestamp: '20240101120000', url: 'http://web.archive.org/web/20240101120000/https://example.com/doc' }
          }
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ content: 'c'.repeat(500), truncated: false }) };
  });
  try {
    const result = await fetchSourceContent('https://example.com/doc', null, { archiveFirst: true });
    assert.ok(result.content);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent with archiveFirst returns an error when no snapshot exists', async () => {
  const mock = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ archived_snapshots: {} }) }));
  try {
    const result = await fetchSourceContent('https://example.com/doc', null, { archiveFirst: true });
    assert.equal(result.content, null);
    assert.match(result.error, /no wayback snapshot/i);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent reports per-request telemetry via onRequest', async () => {
  const mock = mockFetch(async (url) => {
    if (url.includes('wayback/available')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          archived_snapshots: {
            closest: { available: true, timestamp: '20240101120000', url: 'http://web.archive.org/web/20240101120000/https://example.com/doc' }
          }
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ content: 'd'.repeat(500), truncated: false }) };
  });
  const records = [];
  try {
    await fetchSourceContent('https://example.com/doc', null, {
      archiveFirst: true,
      onRequest: (rec) => records.push(rec),
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].kind, 'wayback-availability');
    assert.equal(records[0].ok, true);
    assert.equal(records[1].kind, 'source-fetch');
    assert.equal(records[1].ok, true);
    assert.equal(records[1].bytes, 500);
    assert.ok(typeof records[0].latencyMs === 'number');
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent sends a descriptive User-Agent on the direct archive.org call', async () => {
  const mock = mockFetch(async (url) => {
    if (String(url).includes('wayback/available')) {
      return { ok: true, status: 200, json: async () => ({ archived_snapshots: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ error: 'upstream 404', status: 404 }) };
  });
  try {
    await fetchSourceContent('https://example.com/doc', null);
    const waybackCall = mock.calls.find(c => c.url.includes('wayback/available'));
    assert.ok(waybackCall, 'should have called the wayback availability API');
    assert.match(waybackCall.opts?.headers?.['User-Agent'] ?? '', /citation-checker-script/);
  } finally {
    mock.restore();
  }
});

test('fetchSourceContent onRequest reports failures too', async () => {
  // Live fetch fails, so the default (non-archiveFirst) path also probes
  // Wayback availability — both calls should report through onRequest.
  const mock = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ error: 'upstream 404', status: 404 }) }));
  const records = [];
  try {
    await fetchSourceContent('https://example.com/doc', null, { onRequest: (rec) => records.push(rec) });
    assert.equal(records.length, 2);
    assert.equal(records[0].kind, 'source-fetch');
    assert.equal(records[0].ok, false);
    assert.equal(records[0].status, 404);
    assert.equal(records[0].error, 'upstream 404');
    assert.equal(records[1].kind, 'wayback-availability');
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

// --- Fetch timeouts ---
//
// The bug these pin: core/wikipedia.js bounded its article fetches after hung
// connections stalled a batch, but source fetching had no timeout at all. It
// is the worse place to lack one, because service/run-sweep.js fetches
// serially — one hung connection stopped a 100-article sweep dead at article
// 13 for sixteen hours, with the job still alive and no error anywhere.

test('fetchSourceContent aborts a hung proxy fetch instead of waiting forever', async () => {
    let sawSignal = null;
    global.fetch = (url, options) => {
        sawSignal = options?.signal;
        // Never resolves on its own: only the abort can end this.
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
    };

    const result = await fetchSourceContent('https://slow.example/x', null, { timeoutMs: 10 });

    assert.ok(sawSignal, 'an AbortSignal is passed to fetch');
    assert.equal(result.content, null);
    assert.match(result.error, /timed out after 10ms/);
    assert.equal(result.status, null);
});

test('a timeout is reported as a timeout, not as a generic network error', async () => {
    global.fetch = (url, options) => new Promise((_r, reject) => {
        options.signal.addEventListener('abort',
            () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    });

    const events = [];
    const result = await fetchSourceContent('https://slow.example/x', null, {
        timeoutMs: 10,
        onRequest: e => events.push(e),
    });

    // "aborted" alone would read as a cancelled request rather than a stall;
    // the whole point is that an operator can see which URL hung and for how
    // long.
    assert.match(result.error, /timed out/);
    assert.match(events[0].error, /timed out/);
    assert.equal(events[0].ok, false);
});

test('the timer is cleared on a fast response, so the process can exit', async () => {
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: 'x'.repeat(200), status: 200 }),
    });

    const result = await fetchSourceContent('https://fast.example/x', null, { timeoutMs: 50_000 });

    assert.ok(result.content, 'a normal fetch is unaffected by the timeout');
    // An uncleared 50s timer would keep the event loop alive; node --test
    // hanging after this file is the symptom if this regresses.
});

test('the default timeout is generous enough for the two-hop fetch path', async () => {
    // Client -> tf-source-fetcher -> publisher. Cutting the client off before
    // the fetcher's own timeout would abandon work it was about to return.
    assert.equal(DEFAULT_SOURCE_FETCH_TIMEOUT_MS, 30_000);
});

// --- Source-fetch retry (2026-09-17) ---
//
// source-fetcher was found crash-looping on a JS heap OOM; every request
// landing inside a restart window came back 502 from the front proxy, and with
// no retry each one became a permanent SOURCE UNAVAILABLE row. Two batches lost
// 689 sources that way.

test('isRetryableProxyResult retries the proxy failing, not the source failing', () => {
    for (const status of [429, 500, 502, 503, 504]) {
        assert.equal(isRetryableProxyResult({ content: null, status, proxyFailure: true }), true, `HTTP ${status}`);
    }
    // These are properties of the URL and reproduce identically on a retry.
    for (const status of [400, 403, 404, 405, 410, 451]) {
        assert.equal(isRetryableProxyResult({ content: null, status, proxyFailure: true }), false, `HTTP ${status}`);
    }
    assert.equal(
        isRetryableProxyResult({ content: null, status: 200, error: 'Blocked by robots.txt' }), false);
    assert.equal(
        isRetryableProxyResult({ content: null, status: 200, error: 'Source content was empty or too short to verify' }),
        false);
});

// The distinction the pre-existing Wayback test forced: `status` carries the
// upstream code when the proxy reports one, so these two look identical by
// status and are opposites in meaning.
test('a 503 the proxy REPORTS about a source is not retried; a 503 FROM the proxy is', () => {
    assert.equal(
        isRetryableProxyResult({ content: null, status: 503, error: 'upstream returned 503' }), false,
        'the publisher is down — retrying hammers them and cannot succeed');
    assert.equal(
        isRetryableProxyResult({ content: null, status: 503, error: 'Proxy returned non-JSON response (HTTP 503)', proxyFailure: true }),
        true, 'our gateway is down — exactly what retry is for');
});

test('isRetryableProxyResult retries a proxy that never answered at all', () => {
    assert.equal(
        isRetryableProxyResult({ content: null, status: null, error: 'fetch failed', proxyFailure: true }), true);
    assert.equal(
        isRetryableProxyResult({ content: null, status: null, error: 'Source fetch timed out after 60000ms', proxyFailure: true }),
        true);
    assert.equal(
        isRetryableProxyResult({ content: null, status: null, error: 'x is not a function', proxyFailure: true }), false,
        'a client bug must not be retried four times');
});

test('isRetryableProxyResult never retries a success', () => {
    assert.equal(isRetryableProxyResult({ content: 'Source Content:\nreal text', status: 200 }), false);
    assert.equal(isRetryableProxyResult(null), false);
});

test('a 502 that clears on the second attempt returns the content', async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
        calls++;
        // A crash-looping backend yields the front proxy's HTML error page.
        if (calls === 1) return { status: 502, json: async () => { throw new Error('Unexpected token <'); } };
        return { status: 200, json: async () => ({ content: 'x'.repeat(200), status: 200 }) };
    };
    try {
        const result = await fetchSourceContent('https://example.com/a', null, {
            retry: { minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0 },
        });
        assert.equal(calls, 2, 'retried exactly once');
        assert.ok(result.content.includes('x'.repeat(200)));
        assert.equal(result.error, null);
    } finally {
        global.fetch = originalFetch;
    }
});

test('a 403 is not retried — one attempt, then the real status is preserved', async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
        calls++;
        return { status: 200, json: async () => ({ error: 'Source returned HTTP 403', status: 403 }) };
    };
    try {
        const result = await fetchSourceContent('https://example.com/a', null, {
            retry: { minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0 },
        });
        // One live attempt; the Wayback fallback then looks for a snapshot.
        assert.ok(calls <= 2, `expected no retry of the 403, got ${calls} calls`);
        assert.equal(result.status, 403);
    } finally {
        global.fetch = originalFetch;
    }
});

// The CSV's fetch_status column is what made the outage diagnosable at all, so
// exhausting the retries must not flatten it into a generic error.
test('exhausting every attempt still reports the proxy status it last saw', async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async url => {
        calls++;
        if (String(url).includes('archive.org/wayback')) return { ok: false, status: 404, json: async () => ({}) };
        return { status: 503, json: async () => { throw new Error('Unexpected token <'); } };
    };
    try {
        const result = await fetchSourceContent('https://example.com/a', null, {
            retry: { maxRetries: 3, minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0 },
        });
        assert.equal(calls >= 3, true, 'all attempts spent');
        assert.equal(result.status, 503, 'the last real status survives');
        assert.equal(result.content, null);
    } finally {
        global.fetch = originalFetch;
    }
});

// The shape that defeated the first version of the gate. Measured on a
// 100-article run, 2026-09-18: 2,201 of 2,742 failing rows arrived as valid
// JSON carrying a 5xx status and the fetcher's own transport message, and none
// of them was retried.
test('the fetcher reporting its OWN transport failure as JSON is retried', () => {
    assert.equal(isRetryableProxyResult({ content: null, status: 502, error: 'fetch failed' }), true);
    assert.equal(isRetryableProxyResult({ content: null, status: 503, error: 'fetch failed' }), true);
    assert.equal(isRetryableProxyResult({ content: null, status: 502, error: 'terminated' }), true);
});

test('the fetcher reporting what a source SAID is still not retried', () => {
    // "Source returned HTTP <n>" is the fetcher's wording for a publisher that
    // answered. Those reproduce, and retrying hammers a site that is already
    // struggling.
    for (const error of ['Source returned HTTP 502', 'Source returned HTTP 403',
                         'Source returned HTTP 405', 'Blocked by robots.txt',
                         'Source content was empty or too short to verify',
                         'Invalid page number. PDF has 10 pages.']) {
        assert.equal(isRetryableProxyResult({ content: null, status: 502, error }), false, error);
    }
});

// Four attempts against a 60s timeout is punitive for a publisher that is
// merely slow, and it will time out again.
test('a slow source is not retried, though an unreachable proxy is', () => {
    assert.equal(
        isRetryableProxyResult({ content: null, status: 504, error: 'Request to source timed out' }), false);
    assert.equal(
        isRetryableProxyResult({ content: null, status: null, error: 'Source fetch timed out after 60000ms', proxyFailure: true }),
        true);
});

test('a JSON-reported transport failure survives a round trip through fetchSourceContent', async () => {
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async url => {
        if (String(url).includes('archive.org/wayback')) return { ok: false, status: 404, json: async () => ({}) };
        calls++;
        if (calls === 1) return { status: 200, json: async () => ({ error: 'fetch failed', status: 502 }) };
        return { status: 200, json: async () => ({ content: 'y'.repeat(200), status: 200 }) };
    };
    try {
        const result = await fetchSourceContent('https://example.com/a', null, {
            retry: { minBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0 },
        });
        assert.equal(calls, 2, 'retried the fetcher-side failure exactly once');
        assert.ok(result.content.includes('y'.repeat(200)));
    } finally {
        global.fetch = originalFetch;
    }
});
