// Retry-with-backoff helper shared by the benchmark runner and the
// userscript's batch verify-all-citations path. Pre-consolidation, the
// benchmark used `withRetry` (5 attempts, exponential backoff, retries
// on 429 / 500 / 502 / 503 / 504 / network errors) while main.js's batch
// path had its own inline loop (3 attempts, fixed linear backoff,
// retries only on 429). The userscript's narrower trigger meant a single
// 503 during a batch run errored out the whole citation; the benchmark
// would have recovered. Sharing the impl widens the userscript to the
// benchmark's retry set.
//
// Defaults match the benchmark (1s base, exponential, ≤30s cap, 5
// attempts) — callers tune via options.

const RETRYABLE_STATUS = /^HTTP (429|500|502|503|504)\b/;
const RETRYABLE_NETWORK = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRetryableError(error) {
    const msg = error?.message ?? '';
    return RETRYABLE_STATUS.test(msg) || RETRYABLE_NETWORK.test(msg);
}

/**
 * Retry `fn` on transient failures (429, 5xx, network) with exponential
 * backoff + jitter.
 *
 * Options:
 *   maxRetries       Total attempt budget incl. the initial call (default 5).
 *   minBackoffMs     Base for the exponential curve (default 1000).
 *   maxBackoffMs     Cap on a single sleep (default 30000).
 *   jitterMs         Upper bound of additive random jitter (default 500).
 *   sleepFn          Injectable sleep — tests pass a no-op so they run instantly.
 *   shouldAbort      Optional callback; truthy return short-circuits the loop
 *                    (e.g. user cancellation in the userscript's batch path).
 *   onAttemptFailed  Optional callback invoked after each failed attempt with
 *                    { error, attempt, backoff, willRetry } — for progress UI.
 *                    `backoff` is the sleep duration about to elapse (0 if no retry).
 *
 * Throws the last error if every attempt fails or the failure isn't retryable.
 */
export async function withRetry(fn, {
    maxRetries = 5,
    minBackoffMs = 1000,
    maxBackoffMs = 30000,
    jitterMs = 500,
    sleepFn = defaultSleep,
    shouldAbort,
    onAttemptFailed,
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (shouldAbort && shouldAbort()) break;
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const retryable = isRetryableError(error);
            const willRetry = retryable && attempt < maxRetries - 1
                && !(shouldAbort && shouldAbort());
            const backoff = willRetry
                ? Math.min(maxBackoffMs, minBackoffMs * Math.pow(2, attempt))
                  + Math.random() * jitterMs
                : 0;
            if (onAttemptFailed) onAttemptFailed({ error, attempt, backoff, willRetry });
            if (!willRetry) break;
            await sleepFn(backoff);
        }
    }
    throw lastError;
}
