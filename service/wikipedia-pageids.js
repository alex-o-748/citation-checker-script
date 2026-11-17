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
        // Follow #REDIRECTs to the article they point at. Without this a
        // title renamed since it was written down (a rerun of an earlier
        // batch by its stored titles) resolves to the leftover redirect stub,
        // which has no citations — the article is silently never checked.
        redirects: '1',
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
 * Resolves a list of article titles to
 * `{ pageId, revisionId, title, redirectedFrom }`.
 *
 * Returns a Map<title, info>, keyed by the title as requested and by every
 * form MediaWiki passed through on the way to the page (normalized —
 * underscores to spaces, first-letter case — and redirect source), so a
 * caller can look up with whatever string it started with. A title MediaWiki
 * reports missing (deleted, typo, a redirect to a missing page) is simply
 * absent from the map rather than throwing — callers skip or degrade rows
 * they can't resolve, the same "survive one bad row" pattern
 * service/claim-extractor.js uses for a single article's fetch failure.
 *
 * `title` is the page's own title as MediaWiki names it. `revisionId` is null
 * (rather than absent) for a page whose revision the API didn't report, which
 * keeps "this title exists" and "we know which revision to pin" separable: a
 * caller can still record the page id.
 *
 * Redirects ARE followed (`redirects=1`): a title that has become a
 * #REDIRECT resolves to the target article's id, revision and title, and
 * `redirectedFrom` is set to the title as requested. It is null when no
 * redirect was followed — normalization alone does not count, since the page
 * is the same one. Redirect and normalization can chain (`foo_bar` →
 * `Foo bar` → `Foo baz`), and MediaWiki resolves double redirects in one
 * query, so the hops are walked rather than looked up once. This used to be
 * the other way round ("Redirects are not followed"), and the November 2026
 * ruwiki rerun — re-checking 1,023 articles by the titles stored weeks
 * earlier — lost three renamed articles to it: each resolved to its redirect
 * stub, which has no citations, and was logged as `no_citations`.
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
        const normalized = new Map((data.query?.normalized ?? []).map(n => [n.from, n.to]));
        const redirects = new Map((data.query?.redirects ?? []).map(r => [r.from, r.to]));

        const pages = new Map();
        for (const page of data.query?.pages ?? []) {
            if (page.missing || page.invalid || !page.pageid) continue;
            const info = {
                pageId: page.pageid,
                revisionId: page.revisions?.[0]?.revid ?? null,
                title: page.title,
                redirectedFrom: null,
            };
            pages.set(page.title, info);
            result.set(page.title, info);
        }

        for (const requested of batch) {
            // requested -> normalized -> redirect target (-> next target …).
            // `seen` guards a redirect loop, which MediaWiki can report.
            const hops = [requested];
            let current = requested;
            let redirected = false;
            const seen = new Set([current]);
            while (true) {
                const next = normalized.get(current) ?? redirects.get(current);
                if (next === undefined || seen.has(next)) break;
                if (!normalized.has(current)) redirected = true;
                seen.add(next);
                hops.push(next);
                current = next;
            }
            const page = pages.get(current);
            if (!page) continue;
            const info = redirected ? { ...page, redirectedFrom: requested } : page;
            // Every hop but the page's own title: the page's own key stays
            // the direct (redirectedFrom: null) entry set above.
            for (const hop of hops) {
                if (hop !== page.title) result.set(hop, info);
            }
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
