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

// Matches both the "HTTP <status>" shape (e.g. main.js's CORS-proxy fetch
// errors) and the "[<Label> ]API request failed (<status>): ..." shape thrown
// by every provider call in core/providers.js. The two families used to
// diverge silently: this regex only ever matched the former, so 429/5xx from
// a real LLM call (the actual withRetry-wrapped call path) never retried at
// all — see the 2026-08-16 keyless-HF-benchmark investigation.
//
// Both alternatives are anchored, and the optional label is `[^:()]*` rather
// than `.*` on purpose. The status must come from the message *we* format, not
// from the upstream response body interpolated after "): " — a permanent 400
// whose body happens to mention a 5xx ("...failed (400): upstream failed
// (503)") must stay non-retryable. `[^:()]*` cannot cross the first "(" or
// ":", so only the real status can satisfy the group. Labels are caller-side
// constants and may contain spaces ('Lift Wing'), hence not `\S+`.
const RETRYABLE_STATUS = /^(?:HTTP |[^:()]*API request failed \()(429|500|502|503|504)\b/;
const RETRYABLE_NETWORK = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

// Two distinct failure modes, same practical consequence — "this citation's
// source cannot be sent to this model/provider as-is, and never will be no
// matter how many times we try":
//   - vLLM (Lift Wing's backend for open-weight models) reports a genuine
//     input-validation failure — the prompt exceeds the model's context
//     window — as an HTTP 500, which would otherwise match RETRYABLE_STATUS
//     above. Real incident, 2026-08-24: exactly this on a live sweep against
//     tf-llm-router.
//   - core/providers.js's own 413 handler ("the source is too large to
//     send"): a proxy-level request-body byte cap rejects the request
//     before the model ever sees it — a transport limit, not a model one,
//     but exactly as permanent for this one source. Real incident,
//     2026-08-31: this one halted a whole ruwiki sweep after 202 findings,
//     because — unlike the vLLM case — nothing recognized its message shape,
//     so it fell through to the same treatment as a genuinely unknown,
//     run-halting error.
// Retrying either buys nothing: the same oversized prompt/source produces
// the identical error on every attempt, so retrying just burns up to ~30s of
// backoff before failing anyway. Exported (not just used inline below) so
// service/verifier.js can recognize this after withRetry gives up and
// record it as a per-citation result instead of treating it as a
// run-halting error the way a genuinely unrecognized failure is.
const CONTEXT_LENGTH_EXCEEDED = /maximum context length|VLLMValidationError|too large to send/i;

export function isContextLengthError(error) {
    return CONTEXT_LENGTH_EXCEEDED.test(error?.message ?? '');
}

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRetryableError(error) {
    const msg = error?.message ?? '';

    if (isContextLengthError(error)) return false;

    // Node's fetch (undici) always throws this exact generic message for a
    // network/transport-layer failure — DNS, connection reset, refused, TLS
    // — never for an HTTP-level 4xx/5xx response (those resolve normally
    // and are turned into the "API request failed (<status>)" shape by our
    // own provider code, matched below). The actual reason lives one level
    // down in `error.cause` (e.g. `{ code: 'ENOTFOUND' }` or `ECONNRESET`),
    // which this function never inspected — so this entire category of
    // real transient failures skipped retry and went straight to a hard
    // failure. Real incident, 2026-08-24: a live sweep against
    // tf-llm-router halted immediately on "fetch failed" with zero retry
    // attempts. Matched by exact equality, not substring, so this can't
    // accidentally widen retry to some other error that merely mentions
    // "fetch failed" in a longer message.
    if (msg === 'fetch failed') return true;

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
