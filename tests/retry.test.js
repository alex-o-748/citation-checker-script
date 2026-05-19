import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isRetryableError } from '../core/retry.js';

const noSleep = () => Promise.resolve();

// ---- withRetry --------------------------------------------------------------

test('withRetry: returns the value on first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; }, { sleepFn: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
});

test('withRetry: retries on HTTP 429 and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 3) throw new Error('HTTP 429: rate limited');
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('withRetry: retries on HTTP 503', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 2) throw new Error('HTTP 503: backend unavailable');
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(calls, 2);
    assert.equal(result, 'ok');
});

test('withRetry: retries on network timeout', async () => {
    let calls = 0;
    await withRetry(async () => {
        calls++;
        if (calls < 2) throw new Error('Request timeout');
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(calls, 2);
});

test('withRetry: does NOT retry on HTTP 400', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('HTTP 400: bad request');
        }, { sleepFn: noSleep }),
        /HTTP 400/
    );
    assert.equal(calls, 1);
});

test('withRetry: does NOT retry on parse errors', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('Parse error: unexpected token');
        }, { sleepFn: noSleep }),
        /Parse error/
    );
    assert.equal(calls, 1);
});

test('withRetry: gives up after maxRetries and throws the last error', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error(`HTTP 429: try ${calls}`);
        }, { sleepFn: noSleep, maxRetries: 3 }),
        /HTTP 429: try 3/
    );
    assert.equal(calls, 3);
});

test('withRetry: default backoff schedule is exponential and uses sleepFn', async () => {
    const delays = [];
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('HTTP 429');
        }, { maxRetries: 4, sleepFn: async (ms) => { delays.push(ms); } })
    );
    // 4 attempts → 3 sleeps between them. Base values: 1000, 2000, 4000 (+ up to 500 jitter).
    assert.equal(delays.length, 3);
    assert.ok(delays[0] >= 1000 && delays[0] < 1500, `attempt 0 sleep was ${delays[0]}`);
    assert.ok(delays[1] >= 2000 && delays[1] < 2500, `attempt 1 sleep was ${delays[1]}`);
    assert.ok(delays[2] >= 4000 && delays[2] < 4500, `attempt 2 sleep was ${delays[2]}`);
});

test('withRetry: custom minBackoffMs / jitterMs match the userscript schedule', async () => {
    // main.js's batch retry historically used a fixed [5s, 10s, 20s] curve with
    // no jitter. The shared withRetry preserves this when called with
    // minBackoffMs=5000 / jitterMs=0 / maxRetries=4 (1 initial + 3 retries).
    const delays = [];
    await assert.rejects(
        withRetry(async () => { throw new Error('HTTP 429'); }, {
            maxRetries: 4,
            minBackoffMs: 5000,
            jitterMs: 0,
            sleepFn: async (ms) => { delays.push(ms); },
        })
    );
    assert.deepEqual(delays, [5000, 10000, 20000]);
});

test('withRetry: maxBackoffMs caps a single sleep', async () => {
    const delays = [];
    await assert.rejects(
        withRetry(async () => { throw new Error('HTTP 429'); }, {
            maxRetries: 5,
            minBackoffMs: 10000,
            jitterMs: 0,
            maxBackoffMs: 15000,
            sleepFn: async (ms) => { delays.push(ms); },
        })
    );
    // attempts: 0=10000, 1=20000 (capped to 15000), 2=40000 (capped), 3=80000 (capped)
    assert.deepEqual(delays, [10000, 15000, 15000, 15000]);
});

test('withRetry: shouldAbort short-circuits the loop before the next attempt', async () => {
    let calls = 0;
    let abort = false;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            if (calls === 2) abort = true;
            throw new Error('HTTP 429');
        }, {
            sleepFn: noSleep,
            shouldAbort: () => abort,
        })
    );
    // Initial + one retry, then shouldAbort returns true and breaks before the third call.
    assert.equal(calls, 2);
});

test('withRetry: onAttemptFailed receives error, attempt, backoff, and willRetry', async () => {
    const events = [];
    await assert.rejects(
        withRetry(async () => { throw new Error('HTTP 429'); }, {
            maxRetries: 3,
            minBackoffMs: 1000,
            jitterMs: 0,
            sleepFn: noSleep,
            onAttemptFailed: (info) => {
                events.push({
                    attempt: info.attempt,
                    backoff: info.backoff,
                    willRetry: info.willRetry,
                    message: info.error.message,
                });
            },
        })
    );
    assert.deepEqual(events, [
        { attempt: 0, backoff: 1000, willRetry: true,  message: 'HTTP 429' },
        { attempt: 1, backoff: 2000, willRetry: true,  message: 'HTTP 429' },
        { attempt: 2, backoff: 0,    willRetry: false, message: 'HTTP 429' },
    ]);
});

test('withRetry: onAttemptFailed reports willRetry=false for non-retryable errors', async () => {
    const events = [];
    await assert.rejects(
        withRetry(async () => { throw new Error('HTTP 400: bad'); }, {
            sleepFn: noSleep,
            onAttemptFailed: (info) => { events.push(info.willRetry); },
        })
    );
    assert.deepEqual(events, [false]);
});

// ---- isRetryableError -------------------------------------------------------

test('isRetryableError: true for 429 / 5xx / network families', () => {
    assert.equal(isRetryableError(new Error('HTTP 429: rate limited')),     true);
    assert.equal(isRetryableError(new Error('HTTP 500: internal')),         true);
    assert.equal(isRetryableError(new Error('HTTP 502: bad gateway')),      true);
    assert.equal(isRetryableError(new Error('HTTP 503: unavailable')),      true);
    assert.equal(isRetryableError(new Error('HTTP 504: timeout')),          true);
    assert.equal(isRetryableError(new Error('Request timeout')),            true);
    assert.equal(isRetryableError(new Error('socket hang up')),             true);
    assert.equal(isRetryableError(new Error('ECONNRESET')),                 true);
});

test('isRetryableError: false for 4xx (except 429) and parse errors', () => {
    assert.equal(isRetryableError(new Error('HTTP 400: bad request')), false);
    assert.equal(isRetryableError(new Error('HTTP 401: unauthorized')), false);
    assert.equal(isRetryableError(new Error('HTTP 404: not found')),    false);
    assert.equal(isRetryableError(new Error('Invalid API response format')), false);
});

test('isRetryableError: tolerates null/undefined errors', () => {
    assert.equal(isRetryableError(null), false);
    assert.equal(isRetryableError(undefined), false);
    assert.equal(isRetryableError({}), false);
});
