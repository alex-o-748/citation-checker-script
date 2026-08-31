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
 * Derives the language code from a wiki database name, following the
 * MediaWiki convention that a Wikipedia language edition's wikiDb is
 * `<language-code>wiki` (enwiki, ruwiki, simplewiki, ...). Note this is a
 * *project* code, not always a real BCP-47 language tag (simplewiki -> the
 * non-standard "simple") — fine for the two things callers use it for
 * (an REST API subdomain, or core/prompts.js's localizeSystemPrompt(), which
 * only special-cases a handful of curated codes and otherwise falls back to
 * a generic "match the source" directive for anything that isn't 'en').
 */
export function langCodeForWikiDb(wikiDb) {
    const match = /^(.+)wiki$/.exec(String(wikiDb ?? ''));
    if (!match) {
        throw new RangeError(`cannot derive a language code from wiki database name: "${wikiDb}"`);
    }
    return match[1];
}

/**
 * Derives the Wikipedia REST API host from a wiki database name (ruwiki ->
 * ru.wikipedia.org).
 *
 * Callers that select candidates via --wiki (service/run-pick.js,
 * service/run-extract.js) must feed this into fetchArticleHtml's `host`
 * option — otherwise the REST fetch silently stays on DEFAULT_WIKI_HOST
 * regardless of which wiki the candidates came from, and titles selected from
 * e.g. ruwiki 404 against en.wikipedia.org instead of fetching the intended
 * article.
 */
export function apiHostForWikiDb(wikiDb) {
    return `${langCodeForWikiDb(wikiDb)}.wikipedia.org`;
}

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
