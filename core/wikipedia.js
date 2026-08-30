// Fetching rendered article HTML from the Wikipedia REST API.
//
// Node-only, and deliberately NOT listed in scripts/sync-main.js's CORE_ORDER:
// the userscript already runs inside the article it is checking and never needs
// to fetch one. The CLI and the Toolforge batch runner both do.
//
// Returns { html, status, error } rather than throwing, matching
// core/worker.js's fetch contract — callers map that onto their own error
// handling (exit codes for the CLI, a queue outcome for the batch runner).

export const DEFAULT_WIKI_HOST = 'en.wikipedia.org';

export const DEFAULT_USER_AGENT =
    'citation-checker-script (https://github.com/alex-o-748/citation-checker-script)';

/**
 * Builds the REST URL for an article's rendered HTML.
 *
 * `revisionId` pins a specific revision, which the batch runner always supplies:
 * a finding has to record which revision it was computed against, and fetching
 * "latest" leaves a race between selection and fetch where the article changes
 * underneath the run.
 */
export function deriveRestUrl({ title, revisionId } = {}, { host = DEFAULT_WIKI_HOST } = {}) {
    if (!title) throw new TypeError('deriveRestUrl requires a title');

    // encodeURIComponent percent-encodes '/' but leaves '(' and ')' alone —
    // both desirable for this path segment.
    const encoded = encodeURIComponent(String(title).replace(/ /g, '_'));
    const base = `https://${host}/api/rest_v1/page/html/${encoded}`;
    return revisionId ? `${base}/${revisionId}` : base;
}

// Matches tf-source-fetcher's FETCH_TIMEOUT_MS default (src/config.js) —
// without a bound here, a single stalled connection hangs indefinitely
// (observed in practice on Toolforge's shared egress, which is intermittently
// slow: a batch of 30 sequential article fetches that should take under a
// minute took roughly an hour, almost certainly a handful of hung connections
// with no timeout to cut them off).
export const DEFAULT_FETCH_TIMEOUT_MS = 20000;

export async function fetchArticleHtml({ title, revisionId }, {
    host = DEFAULT_WIKI_HOST,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
    let url;
    try {
        url = deriveRestUrl({ title, revisionId }, { host });
    } catch (error) {
        return { html: null, status: null, error: error.message };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, {
            headers: { 'User-Agent': userAgent, 'Accept': 'text/html' },
            signal: controller.signal,
        });

        if (!response.ok) {
            return {
                html: null,
                status: response.status,
                error: `Wikipedia returned HTTP ${response.status} for ${title}`,
            };
        }

        return { html: await response.text(), status: response.status, error: null };
    } catch (error) {
        // Network-level failure: no status at all, which callers distinguish
        // from a real HTTP error the way core/worker.js does. An abort from
        // our own timer is reported distinctly rather than as a generic
        // network error, so a stalled connection is distinguishable from one
        // that was actually refused.
        const message = error?.name === 'AbortError'
            ? `Request to Wikipedia timed out after ${timeoutMs}ms`
            : (error?.message || String(error));
        return { html: null, status: null, error: message };
    } finally {
        clearTimeout(timer);
    }
}
