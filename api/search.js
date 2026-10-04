// POST /v1/search: one web search, for callers that cannot reach a search API
// themselves. A Wikipedia user script can call *.toolforge.org but not a
// commercial search host (the page's CSP is an allowlist), so CNfirmed
// (alex-o-748/source-finder) searches through here and then checks each
// result against its claim with POST /v1/verify.
//
// The search is Tavily's (https://docs.tavily.com). It runs on the tool's own
// key (TAVILY_API_KEY, a Toolforge envvar), or on Tavily's keyless mode when
// no key is set. Either way the tool pays in credits or rate limit, so a daily
// budget caps the calls (SEARCH_DAILY_LIMIT; the free plan is 1,000 credits a
// month and a basic search costs one).
//
// Measured on CNfirmed's 100-claim evaluation set (October 2026): with each
// result checked by /v1/verify, 9 claims got a citable source and 5 more a
// weak one (source-finder's eval/README.md, "Plain web search").

import { MAX_SOURCE_CONTENT_CHARS } from './verify.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export const MAX_QUERY_CHARS = 400;
export const MAX_RESULTS = 10;
const DEFAULT_DAILY_LIMIT = 30;

// Never worth returning as a source for a Wikipedia claim: Wikipedia and the
// sites that copy it (a copy "supports" the claim by repeating it), user-
// generated and social sites, and the WP:RSP deprecated seed list CNfirmed
// filters on. Callers may add to this, not remove from it.
export const SEARCH_EXCLUDE_DOMAINS = Object.freeze([
    'wikipedia.org', 'wikiwand.com', 'wikimili.com', 'dbpedia.org', 'alchetron.com',
    'everybodywiki.com', 'kiddle.co', 'wiki2.org', 'infogalactic.com', 'justapedia.org',
    'wikizero.com', 'wikibrief.org', 'en-academic.com', 'dictionary.sensagent.com',
    'grokipedia.com', 'bharatpedia.org', 'handwiki.org', 'marefa.org', 'famousfix.com',
    'miraheze.org',
    'fandom.com', 'wikia.com', 'reddit.com', 'quora.com', 'answers.com', 'medium.com',
    'substack.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com',
    'pinterest.com', 'linkedin.com', 'scribd.com', 'deviantart.com', 'ebay.com',
    'dailymail.co.uk', 'thesun.co.uk', 'mirror.co.uk', 'rt.com', 'sputniknews.com',
    'breitbart.com', 'infowars.com',
]);

const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

/**
 * A daily call budget, reset at UTC midnight. In memory: a restart resets it,
 * which errs toward allowing calls, never toward a surprise bill beyond one
 * extra day's worth.
 */
export function createSearchBudget({
    limit = Number(process.env.SEARCH_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT,
    now = Date.now,
} = {}) {
    let day = null;
    let used = 0;
    const today = () => new Date(now()).toISOString().slice(0, 10);
    const take = () => {
        const d = today();
        if (d !== day) { day = d; used = 0; }
        if (used >= limit) return { allowed: false, limit, remaining: 0 };
        used += 1;
        return { allowed: true, limit, remaining: limit - used };
    };
    take.peek = () => {
        const d = today();
        return { limit, remaining: d === day ? Math.max(0, limit - used) : limit };
    };
    return take;
}

function validateSearchRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
    for (const key of Object.keys(body)) {
        if (key !== 'query' && key !== 'exclude_domains') return `Unknown field: ${key}`;
    }
    if (typeof body.query !== 'string' || !body.query.trim()) return 'query is required';
    if (body.query.length > MAX_QUERY_CHARS) return `query exceeds ${MAX_QUERY_CHARS} characters`;
    if (body.exclude_domains !== undefined) {
        if (!Array.isArray(body.exclude_domains) || body.exclude_domains.length > 50) {
            return 'exclude_domains must be an array of at most 50 domains';
        }
        if (!body.exclude_domains.every(d => typeof d === 'string' && DOMAIN.test(d))) {
            return 'exclude_domains must contain domain names';
        }
    }
    return null;
}

/**
 * One search. Each result carries `text`: Tavily's excerpts that match the
 * query, then the page itself, cut to what /v1/verify accepts as
 * source_content, so a caller can pass it straight on. Excerpts come first so
 * a long page's relevant passage survives the cut.
 */
export async function searchRequest(body, {
    fetch: doFetch = fetch,
    apiKey = process.env.TAVILY_API_KEY,
    budget,
} = {}) {
    const validationError = validateSearchRequest(body);
    if (validationError) return { status: 400, body: { error: validationError } };

    if (budget && !budget().allowed) {
        return { status: 429, body: { error: 'Daily search budget exhausted; try again tomorrow' } };
    }

    const exclude = [...new Set([...SEARCH_EXCLUDE_DOMAINS, ...(body.exclude_domains || []).map(d => d.toLowerCase())])];
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    else headers['X-Tavily-Access-Mode'] = 'keyless';

    const request = JSON.stringify({
        query: body.query.trim(),
        search_depth: 'basic',
        max_results: MAX_RESULTS,
        chunks_per_source: 3,
        include_raw_content: 'markdown',
        exclude_domains: exclude,
    });
    // Tavily now and then answers a query with no results at all, and the
    // same query moments later with ten (seen on the live service, October
    // 2026). One retry on an empty answer costs a credit only when it happens.
    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
            res = await doFetch(TAVILY_SEARCH_URL, { method: 'POST', headers, body: request });
        } catch {
            return { status: 502, body: { error: 'Search provider unreachable' } };
        }
        if (res.status === 429) return { status: 429, body: { error: 'Search provider rate limit; try again later' } };
        data = await res.json().catch(() => null);
        if (!res.ok || !data || !Array.isArray(data.results)) {
            return { status: 502, body: { error: `Search provider failed (${res.status})` } };
        }
        if (data.results.length > 0) break;
    }

    const results = data.results
        .filter(r => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url))
        .map(r => ({
            url: r.url,
            title: typeof r.title === 'string' && r.title ? r.title : r.url,
            score: typeof r.score === 'number' ? r.score : null,
            text: [r.content, r.raw_content].filter(t => typeof t === 'string' && t.trim())
                .join('\n\n').slice(0, MAX_SOURCE_CONTENT_CHARS),
        }))
        .filter(r => r.text.trim());
    return { status: 200, body: { results } };
}
