// Resolving article titles to page IDs and current revision IDs via the
// MediaWiki Action API.
//
// service/article-picker.js's Wiki Replicas rows carry page_id and rev_id
// directly; this module exists for the callers that don't have a Replicas row
// to read them off:
//
//   - service/run-replay.js, whose input is benchmark/dataset.json, a
//     standalone JSON file with a title and an oldid but no page_id (see
//     docs/design-plans/2026-08-22-batch-verification-and-persistence.md §3,
//     "Wrinkle 1"). citation_findings.page_id is NOT NULL, so a replay run
//     needs a real value from somewhere.
//   - service/run-sweep.js's --titles-file branch, whose input is a bare list
//     of strings. Without this it had neither id: every row it wrote carried
//     an empty page_id, revision_id and permalink, which is most of what a
//     shareable CSV is for (see service/csv-report.js's permalink()).
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

// prop=revisions + rvprop=ids returns each page's *latest* revision alongside
// its id — one revision per page, which is what the API gives for a
// multi-title query (rvlimit is only accepted for a single page, and is
// deliberately not sent). One query shape for both exports below, so a caller
// wanting only page ids can't end up issuing a different request than one
// wanting both.
export function buildTitlesQueryUrl(titles, { host = DEFAULT_API_HOST } = {}) {
    if (!titles || titles.length === 0) {
        throw new TypeError('buildTitlesQueryUrl requires at least one title');
    }
    const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'revisions',
        rvprop: 'ids',
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
 * Resolves a list of article titles to `{ pageId, revisionId }`.
 *
 * Returns a Map<title, {pageId, revisionId}>, keyed by both the title as
 * requested and (if MediaWiki normalized it — underscores to spaces,
 * first-letter case) the normalized form, so a caller can look up with
 * whatever string it started with. A title MediaWiki reports missing
 * (deleted, moved, typo) is simply absent from the map rather than throwing —
 * callers skip or degrade rows they can't resolve, the same "survive one bad
 * row" pattern service/claim-extractor.js uses for a single article's fetch
 * failure.
 *
 * `revisionId` is null (rather than absent) for a page whose revision the API
 * didn't report, which keeps "this title exists" and "we know which revision
 * to pin" separable: a caller can still record the page id.
 *
 * Redirects are not followed: a genuine #REDIRECT page resolves to the
 * redirect page's own id, not the target's. None of benchmark/dataset.json's
 * titles are known redirects as of this writing; a future dataset refresh
 * should re-check this if resolution rates drop unexpectedly.
 */
export async function resolveTitleInfo(titles, {
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
            const info = { pageId: page.pageid, revisionId: page.revisions?.[0]?.revid ?? null };
            result.set(page.title, info);
            const original = normalizedFrom.get(page.title);
            if (original && original !== page.title) result.set(original, info);
        }
    }

    return result;
}

/**
 * Resolves a list of article titles to their current page IDs.
 *
 * The page-id-only view of resolveTitleInfo(), for run-replay.js, which gets
 * its revision from the dataset row's own oldid and has no use for the
 * current one. Same Map keying and same missing-title behaviour.
 */
export async function resolvePageIds(titles, options = {}) {
    const info = await resolveTitleInfo(titles, options);
    return new Map([...info].map(([title, { pageId }]) => [title, pageId]));
}
