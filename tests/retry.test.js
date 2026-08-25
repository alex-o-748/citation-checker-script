import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isRetryableError, isContextLengthError } from '../core/retry.js';

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

// ---- isRetryableError: the actual shape thrown by core/providers.js --------
// Regression guard: every real provider call (callOpenAICompatibleChat,
// callClaudeAPI, callGeminiAPI) throws "[<Label> ]API request failed
// (<status>): <detail>", never "HTTP <status>". The regex used to only
// recognize the latter, so withRetry — which wraps every one of these calls
// in both run_benchmark.js and main.js's batch-verify path — never retried a
// real 429/5xx; it just failed on the first attempt. Found investigating
// unretried 429s from the keyless HF benchmark path, 2026-08-16.

test('isRetryableError: true for the labeled "API request failed (<status>)" shape', () => {
    assert.equal(isRetryableError(new Error('HuggingFace API request failed (429): Too many requests')), true);
    assert.equal(isRetryableError(new Error('PublicAI API request failed (500): internal error')), true);
    assert.equal(isRetryableError(new Error('OpenAI API request failed (503): unavailable')), true);
});

test('isRetryableError: true for the unlabeled "API request failed (<status>)" shape (Claude/Gemini)', () => {
    assert.equal(isRetryableError(new Error('API request failed (429): rate limited')), true);
    assert.equal(isRetryableError(new Error('API request failed (502): bad gateway')), true);
});

test('isRetryableError: false for a non-retryable status in the labeled shape', () => {
    assert.equal(isRetryableError(new Error('HuggingFace API request failed (400): Model not allowed: deepseek-ai/DeepSeek-V3')), false);
    assert.equal(isRetryableError(new Error('PublicAI API request failed (402): Insufficient wallet balance')), false);
});

test('isRetryableError: multi-word labels are recognized (Lift Wing)', () => {
    // Labels are caller-side constants and can contain spaces, so the optional
    // label part must not be \S+.
    assert.equal(isRetryableError(new Error('Lift Wing API request failed (503): unavailable')), true);
});

// The status must be read from the message *we* format, never from the
// upstream response body interpolated after "): ". A permanent 4xx whose body
// happens to quote a 5xx must stay non-retryable — otherwise a hard failure
// burns the full backoff budget (up to ~35s per citation in main.js's batch
// path) before surfacing.
test('isRetryableError: a permanent status is not overridden by a 5xx in the response body', () => {
    assert.equal(isRetryableError(new Error('HuggingFace API request failed (400): upstream failed (503) while routing')), false);
    assert.equal(isRetryableError(new Error('OpenRouter API request failed (404): no endpoints; provider returned HTTP 429')), false);
    assert.equal(isRetryableError(new Error('API request failed (403): denied (500 from origin)')), false);
});

// Guard against the fix widening retries into unrelated call paths: these
// shapes did not retry before it and must not start now.
test('isRetryableError: non-provider error shapes are unchanged by the provider-shape fix', () => {
    assert.equal(isRetryableError(new Error('Feedback failed: HTTP 429')), false);
    assert.equal(isRetryableError(new Error('Proxy returned non-JSON response (HTTP 503)')), false);
});

// ---- isRetryableError: undici's generic "fetch failed" wrapper -------------
// Node's fetch throws this exact top-level message for every network/
// transport-layer failure (DNS, connection reset, refused, TLS); the real
// reason (e.g. `{ code: 'ENOTFOUND' }`) lives one level down in `.cause`,
// which isRetryableError never inspected. Real incident, 2026-08-24: a live
// sweep against tf-llm-router halted immediately on "fetch failed" with zero
// retry attempts — a transient DNS/connection hiccup got treated as
// permanently fatal instead of retried like any other network error.

test('isRetryableError: true for undici\'s generic "fetch failed", regardless of the cause', () => {
    const dnsFailure = new TypeError('fetch failed');
    dnsFailure.cause = Object.assign(new Error('getaddrinfo ENOTFOUND llm-router.toolforge.org'), { code: 'ENOTFOUND' });
    assert.equal(isRetryableError(dnsFailure), true);

    // Even with no .cause at all (defensive — every real occurrence has one)
    // or a cause that names nothing recognizable, it's still a transport
    // failure by fetch's own semantics, not an application error.
    assert.equal(isRetryableError(new TypeError('fetch failed')), true);
    const opaqueCause = new TypeError('fetch failed');
    opaqueCause.cause = new Error('something unrecognizable');
    assert.equal(isRetryableError(opaqueCause), true);
});

test('isRetryableError: only the exact "fetch failed" message triggers this, not a longer message containing it', () => {
    assert.equal(isRetryableError(new Error('proxy: fetch failed for https://example.com')), false);
});

test('withRetry: retries on undici\'s "fetch failed" and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 2) {
            const err = new TypeError('fetch failed');
            err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
            throw err;
        }
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

// ---- isContextLengthError / the vLLM context-length carve-out --------------
// vLLM (Lift Wing's open-weight-model backend) reports "the prompt is too
// big for this model" as an HTTP 500 — which RETRYABLE_STATUS would
// otherwise treat as transient. It isn't: the same oversized prompt fails
// identically on every attempt, so retrying just burns backoff time before
// failing anyway. Real incident, 2026-08-24: exactly this on a live sweep
// against tf-llm-router — service/verifier.js now catches this specific
// shape and returns a per-citation ERROR result instead of letting it
// propagate, but that only works if it's excluded from retry first.

test('isContextLengthError: recognizes vLLM\'s validation error regardless of the surrounding status/label', () => {
    assert.equal(isContextLengthError(new Error(
        'Lift Wing API request failed (500): {"error":"VLLMValidationError : This model\'s maximum context length is 32768 tokens."}'
    )), true);
    assert.equal(isContextLengthError(new Error('some backend: VLLMValidationError happened')), true);
    assert.equal(isContextLengthError(new Error('API request failed (500): internal error')), false);
    assert.equal(isContextLengthError(null), false);
});

test('isRetryableError: false for a context-length-exceeded 500, even though 500 is normally retryable', () => {
    const err = new Error(
        'Lift Wing API request failed (500): {"error":"VLLMValidationError : This model\'s maximum context length is 32768 tokens."}'
    );
    assert.equal(isRetryableError(err), false);
    // Sanity check the premise: an *ordinary* 500 from the same provider is
    // still retryable — only the context-length shape is carved out.
    assert.equal(isRetryableError(new Error('Lift Wing API request failed (500): internal error')), true);
});

test('withRetry: does NOT retry a context-length-exceeded failure', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('Lift Wing API request failed (500): VLLMValidationError: maximum context length is 32768 tokens');
        }, { sleepFn: noSleep }),
        /maximum context length/
    );
    assert.equal(calls, 1);
});
