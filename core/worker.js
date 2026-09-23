// Calls to the Cloudflare Worker proxy: source fetching and verification logging.

import { isGoogleBooksUrl, parseArchiveOrgUrl } from './urls.js';
import { withRetry } from './retry.js';

// Identifies this codebase's direct calls to archive.org (the Wayback
// availability lookup below) — without it, that request carries no
// distinguishing UA at all. fetchViaProxy's calls go through workerBase (our
// own proxy/sidecar infra), which brands its own outbound requests
// separately (see tf-source-fetcher's src/config.js), so this only needs to
// cover the one call this module makes to a third party directly.
//
// Duplicated from core/wikipedia.js's DEFAULT_USER_AGENT rather than
// imported: this module is inlined into main.js by scripts/sync-main.js,
// which strips `import` lines outright rather than resolving them — an
// import here would silently vanish from the userscript build and throw a
// ReferenceError in the browser.
const DEFAULT_USER_AGENT =
    'citation-checker-script (https://github.com/alex-o-748/citation-checker-script)';

// Without a bound here, a single stalled connection hangs forever.
//
// core/wikipedia.js already carries this exact fix for *article* fetches,
// added after a batch of 30 sequential fetches took roughly an hour on
// Toolforge's shared egress. Source fetching had no equivalent, and it is the
// worse place to lack one: service/run-sweep.js fetches sources serially, so
// one hung connection stops the whole sweep rather than slowing it — observed
// in practice on a 100-article run, frozen at article 13 for sixteen hours
// with the job still nominally alive and the CSV not growing.
//
// Larger than core/wikipedia.js's 20s because this request is two hops: the
// client waits on tf-source-fetcher, which is itself waiting on a
// third-party publisher under its own FETCH_TIMEOUT_MS. Cutting the client
// off first would abandon work the fetcher was about to return. Measured
// per-citation fetch cost is ~2.6s, so 30 seconds leaves ample headroom while
// preventing one genuinely stalled connection from occupying a fetch-pool
// slot for a full minute.
export const DEFAULT_SOURCE_FETCH_TIMEOUT_MS = 30000;

// AbortController is available in every target: browsers (the userscript) and
// Node 16+ (CLI, benchmark, batch pipeline).
function withTimeout(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function timeoutMessage(error, timeoutMs, what) {
    return error?.name === 'AbortError'
        ? `${what} timed out after ${timeoutMs}ms`
        : (error?.message || String(error));
}

// `onRequest`, when supplied, is called once per outbound HTTP call this
// function makes — `{ kind: 'source-fetch', url, status, ok, error, latencyMs,
// bytes }` — regardless of success or failure. It exists for the Internet
// Archive load-test runner (service/ia-load-test.js), which needs per-request
// telemetry that the returned `{content, error, status}` summary can't carry;
// no caller in this repo passed it before that runner, so omitting it is a
// silent no-op and default behavior is unchanged.
async function fetchViaProxy(fetchUrl, pageNum, workerBase, sourceUrl, onRequest, timeoutMs) {
    const startedAt = Date.now();
    const report = (status, ok, error, bytes = null) => {
        onRequest?.({ kind: 'source-fetch', url: fetchUrl, status, ok, error, latencyMs: Date.now() - startedAt, bytes });
    };
    try {
        let proxyUrl = `${workerBase}/?fetch=${encodeURIComponent(fetchUrl)}`;
        if (pageNum) {
            proxyUrl += `&page=${pageNum}`;
        }
        const { signal, done } = withTimeout(timeoutMs);
        let response;
        try {
            response = await fetch(proxyUrl, { signal });
        } finally {
            done();
        }
        const proxyStatus = response.status;
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            report(proxyStatus, false, `non-JSON response (HTTP ${proxyStatus})`);
            // proxyFailure: the proxy did not answer in its own protocol at
            // all — a front-proxy error page rather than a verdict about the
            // source. See isRetryableProxyResult().
            return { content: null, error: `Proxy returned non-JSON response (HTTP ${proxyStatus})`, status: proxyStatus, proxyFailure: true };
        }

        const status = (data && typeof data.status === 'number') ? data.status : proxyStatus;

        if (data.error) {
            console.warn('[CitationVerifier] Proxy error:', data.error);
            report(status, false, data.error);
            return { content: null, error: data.error, status };
        }

        if (data.content && data.content.length > 100) {
            const isTruncated = data.truncated === true || data.content.length >= 12000;
            let meta = `Source URL: ${sourceUrl}`;
            if (data.pdf) {
                meta += `\nPDF: ${data.totalPages} pages`;
                if (data.page) {
                    meta += ` (extracted page ${data.page})`;
                }
            }
            if (isTruncated) {
                meta += `\nTruncated: true`;
            }
            report(status, true, null, data.content.length);
            return { content: `${meta}\n\nSource Content:\n${data.content}`, error: null, status };
        }

        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
        report(status, false, 'empty or too-short content');
        return { content: null, error: 'Source content was empty or too short to verify', status };
    } catch (error) {
        const message = timeoutMessage(error, timeoutMs, 'Source fetch');
        report(null, false, message);
        console.error('Proxy fetch failed:', message);
        return { content: null, error: message, status: null, proxyFailure: true };
    }
}

// --- Retrying a failed proxy fetch ---
//
// fetchViaProxy() returns rather than throws, so a transient failure used to
// become a permanent `SOURCE UNAVAILABLE` row with nothing in between. That is
// not theoretical: on 2026-09-17 `source-fetcher` was found crash-looping (27
// restarts in two days, JS heap OOM), and every request that landed inside a
// restart window came back 502 from the front proxy. Across two 100-article
// batches that silently destroyed 689 sources; a third run lost 27% of its
// fetches the same way. Each of those windows lasts seconds. A single retry
// would have ridden out most of them.
//
// WHAT IS RETRIED, AND WHAT DELIBERATELY IS NOT. Only failures of the *proxy
// itself* — a 429/5xx from the gateway, or no response at all (timeout or
// transport error reaching it). A failure the proxy reports *about the source*
// is a property of that URL and will reproduce identically: 403, 404, 405,
// robots.txt exclusions, "empty or too short", a bad PDF page number. Retrying
// those buys nothing and adds load to a service that is already the
// bottleneck.
const RETRYABLE_PROXY_STATUS = new Set([429, 500, 502, 503, 504]);

// Messages the fetcher uses when IT could not complete a request at all, as
// opposed to reporting what a source said back. This is the load-bearing
// distinction, and the first version of this module got it wrong.
//
// That version keyed on whether the proxy had answered in its own protocol at
// all, reasoning that a JSON body always describes a source. It does not: when
// `source-fetcher` cannot reach a publisher it reports its own transport
// failure *as JSON*, carrying a 5xx status — `{"error": "fetch failed",
// "status": 502}`. Measured on a 100-article run, 2026-09-18: of 2,742 failing
// rows, **2,201 were exactly that shape** and the gate declined to retry every
// one. Only 526 were the non-JSON front-proxy error the gate did catch.
//
// What separates the two is the wording, which is stable: the fetcher says
// "Source returned HTTP 403" when the publisher answered, and "fetch failed"
// or "terminated" when it never got that far.
//
// `Request to source timed out` is deliberately absent. That one *is* about
// the publisher — it is slow, not unreachable — and four attempts against the
// 60s source-fetch timeout is punitive for something that will time out again.
const PROXY_TRANSPORT_FAILURE = /^(?:fetch failed|terminated)$|^Source fetch timed out/i;

export function isRetryableProxyResult(result) {
    if (!result || result.content) return false;

    // The fetcher's own transport failure, however it was reported — in JSON
    // with a 5xx status, or from fetchViaProxy's catch with no status at all.
    if (PROXY_TRANSPORT_FAILURE.test((result.error ?? '').trim())) return true;

    // Otherwise the proxy answered about the source, and `status` carries the
    // *upstream* code — so a 503 from the publisher and a 503 from our gateway
    // look identical by status and are opposites in meaning. Only the gateway's
    // own failure (a front-proxy error page, never valid JSON) is ours to
    // retry; the publisher's is a property of that URL and reproduces.
    if (!result.proxyFailure) return false;
    return typeof result.status === 'number' && RETRYABLE_PROXY_STATUS.has(result.status);
}

// Fewer attempts and a tighter backoff than the model-call path: a sweep makes
// one of these per citation and mature articles carry hundreds, so the 5-try /
// 30s-cap defaults in core/retry.js would add hours. 1s + 2s + 4s spans a pod
// restart while costing at most ~7s on a source that is genuinely gone.
export const DEFAULT_SOURCE_FETCH_RETRY = Object.freeze({
    maxRetries: 4,
    minBackoffMs: 1000,
    maxBackoffMs: 8000,
    jitterMs: 250,
});

// Translates fetchViaProxy's returned failure into the thrown form withRetry
// expects, then translates it back. The thrown messages are shaped to match
// core/retry.js's isRetryableError() — "HTTP <status>" and the exact string
// "fetch failed" — so the retry decision stays in one place rather than being
// re-implemented here.
async function fetchViaProxyWithRetry(fetchUrl, pageNum, workerBase, sourceUrl, onRequest, timeoutMs, retry) {
    let lastResult = null;
    try {
        return await withRetry(async () => {
            const result = await fetchViaProxy(fetchUrl, pageNum, workerBase, sourceUrl, onRequest, timeoutMs);
            lastResult = result;
            if (isRetryableProxyResult(result)) {
                throw new Error(typeof result.status === 'number' ? `HTTP ${result.status}` : 'fetch failed');
            }
            return result;
        }, { ...DEFAULT_SOURCE_FETCH_RETRY, ...(retry ?? {}) });
    } catch (_) {
        // Every attempt failed. Return the last real result so the caller still
        // gets the proxy's own status and message — the CSV's fetch_status
        // column is what makes an outage diagnosable after the fact.
        return lastResult ?? { content: null, error: 'Source fetch failed', status: null };
    }
}

async function findWaybackSnapshot(url, onRequest, timeoutMs) {
    const startedAt = Date.now();
    try {
        const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
        const { signal, done } = withTimeout(timeoutMs);
        let response;
        try {
            response = await fetch(apiUrl, { headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal });
        } finally {
            done();
        }
        const data = await response.json();
        onRequest?.({ kind: 'wayback-availability', url, status: response.status, ok: response.ok, error: null, latencyMs: Date.now() - startedAt, bytes: null });
        const snapshot = data?.archived_snapshots?.closest;
        if (snapshot?.available && snapshot.timestamp) {
            return `https://web.archive.org/web/${snapshot.timestamp}id_/${url}`;
        }
    } catch (e) {
        const message = timeoutMessage(e, timeoutMs, 'Wayback availability check');
        onRequest?.({ kind: 'wayback-availability', url, status: null, ok: false, error: message, latencyMs: Date.now() - startedAt, bytes: null });
        console.warn('[CitationVerifier] Wayback availability check failed:', message);
    }
    return null;
}

// Always returns { content, error, status }. `content` is the formatted source
// text on success and null on any failure; `error` is a short human-readable
// reason when content is null; `status` is the upstream HTTP status code if the
// proxy reports one (`data.status`), otherwise the proxy's own response status,
// or null if we never got a response at all.
//
// `archiveFirst` skips the live-publisher fetch entirely and goes straight to
// the Wayback snapshot lookup — for the Internet Archive load-test runner,
// which must never send traffic to a third-party publisher (see
// service/ia-load-test.js). Default behavior (live-first, Wayback as a
// fallback) is unchanged for the userscript, CLI, and batch pipeline.
export async function fetchSourceContent(url, pageNum, { workerBase = 'https://publicai-proxy.alaexis.workers.dev', archiveFirst = false, onRequest, timeoutMs = DEFAULT_SOURCE_FETCH_TIMEOUT_MS, retry } = {}) {
    if (isGoogleBooksUrl(url)) {
        console.log('[CitationVerifier] Skipping Google Books URL:', url);
        return { content: null, error: 'Google Books URL skipped (no fetchable content)', status: null };
    }

    const archiveInfo = parseArchiveOrgUrl(url);
    if (archiveInfo) {
        const rawUrl = `https://web.archive.org/web/${archiveInfo.timestamp}id_/${archiveInfo.originalUrl}`;
        console.log('[CitationVerifier] Fetching via Wayback raw endpoint');
        return fetchViaProxyWithRetry(rawUrl, pageNum, workerBase, url, onRequest, timeoutMs, retry);
    }

    if (archiveFirst) {
        const waybackUrl = await findWaybackSnapshot(url, onRequest, timeoutMs);
        if (!waybackUrl) {
            return { content: null, error: 'No Wayback snapshot available for this URL', status: null };
        }
        return fetchViaProxyWithRetry(waybackUrl, pageNum, workerBase, url, onRequest, timeoutMs, retry);
    }

    // Retried before the Wayback fallback on purpose: a 502 from our own proxy
    // says nothing about whether the publisher is reachable, so falling back to
    // an archive snapshot on that basis would substitute a worse source for a
    // live one that was never actually tried.
    const result = await fetchViaProxyWithRetry(url, pageNum, workerBase, url, onRequest, timeoutMs, retry);

    if (!result.content) {
        const waybackUrl = await findWaybackSnapshot(url, onRequest, timeoutMs);
        if (waybackUrl) {
            console.log('[CitationVerifier] Live fetch failed, trying Wayback snapshot');
            return fetchViaProxyWithRetry(waybackUrl, pageNum, workerBase, url, onRequest, timeoutMs, retry);
        }
    }

    return result;
}

export function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    // Caller supplies the payload object; build it with buildLogPayload()
    // from core/feedback.js so the keys line up with the Neon columns.
    try {
        fetch(`${workerBase}/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).catch(() => {});
    } catch (e) {
        // logging should never break the main flow
    }
}

// Ratings and talk-page pointers. Unlike logVerification this resolves, so the
// UI can tell the user whether their rating actually landed — a silent no-op
// on a button the user deliberately pressed would be worse than an error.
export function postFeedback(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    return fetch(`${workerBase}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).then(res => {
        if (!res.ok) throw new Error(`Feedback failed: HTTP ${res.status}`);
        return true;
    });
}
