// Resolving article titles to page IDs via the MediaWiki Action API.
//
// service/article-picker.js's Wiki Replicas rows carry page_id directly; this
// module exists for the one caller that doesn't — service/run-replay.js, whose
// input is benchmark/dataset.json, a standalone JSON file with a title and
// an oldid but no page_id (see docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md §3, "Wrinkle 1").
// citation_findings.page_id is NOT NULL, so a replay run needs a real value
// from somewhere.
//
// A plain REST GET, not a Wiki Replicas query, so this works from anywhere
// with internet access — a laptop or the Toolforge bastion alike — matching
// core/wikipedia.js's fetchArticleHtml() pattern rather than
// service/replicas.js's.

export const DEFAULT_API_HOST = 'en.wikipedia.org';
export const DEFAULT_USER_AGENT =
    'citation-checker-script (https://github.com/alex-o-748/citation-checker-script)';

// The Action API accepts multiple titles per request (pipe-separated); kept
// well under the 500-title approved-bot ceiling since this runs
// interactively, not as an approved bot — docs/design-plans/
// 2026-08-07-batch-source-checks-for-edit-suggestions.md's "Constraints that
// bite" already warns against assuming bot-tier limits apply here.
export const DEFAULT_BATCH_SIZE = 50;

export function buildTitlesQueryUrl(titles, { host = DEFAULT_API_HOST } = {}) {
    if (!titles || titles.length === 0) {
        throw new TypeError('buildTitlesQueryUrl requires at least one title');
    }
    const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        titles: titles.join('|'),
    });
    return `https://${host}/w/api.php?${params.toString()}`;
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

/**
 * Resolves a list of article titles to their current page IDs.
 *
 * Returns a Map<title, pageId>, keyed by both the title as requested and (if
 * MediaWiki normalized it — underscores to spaces, first-letter case) the
 * normalized form, so a caller can look up with whatever string it started
 * with. A title MediaWiki reports missing (deleted, moved, typo) is simply
 * absent from the map rather than throwing — callers skip rows they can't
 * resolve, the same "survive one bad row" pattern service/claim-extractor.js uses
 * for a single article's fetch failure.
 *
 * Redirects are not followed: a genuine #REDIRECT page resolves to the
 * redirect page's own id, not the target's. None of benchmark/dataset.json's
 * titles are known redirects as of this writing; a future dataset refresh
 * should re-check this if resolution rates drop unexpectedly.
 */
export async function resolvePageIds(titles, {
    host = DEFAULT_API_HOST,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
    batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
    const unique = [...new Set(titles)];
    const result = new Map();

    for (const batch of chunk(unique, batchSize)) {
        const url = buildTitlesQueryUrl(batch, { host });
        const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
        if (!response.ok) {
            throw new Error(`Wikipedia API returned HTTP ${response.status} resolving page IDs`);
        }
        const data = await response.json();
        const normalizedFrom = new Map((data.query?.normalized ?? []).map(n => [n.to, n.from]));

        for (const page of data.query?.pages ?? []) {
            if (page.missing || !page.pageid) continue;
            result.set(page.title, page.pageid);
            const original = normalizedFrom.get(page.title);
            if (original && original !== page.title) result.set(original, page.pageid);
        }
    }

    return result;
}

/**
 * Resolves one article title to { pageId, title, revisionId } — the shape
 * service/article-picker.js's selectCandidates() rows already have, needed
 * by anything that wants to run the pipeline against one named article
 * without a Wiki Replicas query (service/run-sweep.js's --title).
 *
 * Unlike resolvePageIds() (page ID only, batched, many titles), this needs
 * the *current* revision id too — a batch runner records which revision a
 * finding was computed against, same reason core/wikipedia.js's
 * deriveRestUrl() always pins one. One extra query param (`rvprop=ids`) on
 * the same Action API call gets both in one round trip rather than two.
 *
 * Returns null if the title doesn't resolve (missing, deleted, typo'd) —
 * same "let the caller decide, don't throw" contract as resolvePageIds().
 */
export async function resolveArticleRef(title, {
    host = DEFAULT_API_HOST,
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = fetch,
} = {}) {
    const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        titles: title,
        prop: 'revisions',
        rvprop: 'ids',
        rvlimit: '1',
    });
    const url = `https://${host}/w/api.php?${params.toString()}`;

    const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
    if (!response.ok) {
        throw new Error(`Wikipedia API returned HTTP ${response.status} resolving "${title}"`);
    }
    const data = await response.json();
    const page = data.query?.pages?.[0];
    if (!page || page.missing || !page.pageid || !page.revisions?.[0]?.revid) return null;

    return {
        pageId: page.pageid,
        title: page.title,
        revisionId: page.revisions[0].revid,
    };
}
