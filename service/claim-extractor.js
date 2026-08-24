// Stages 1-3 of the batch pipeline: take a selected article, pull its rendered
// HTML at a pinned revision, extract every citation and its claim, and retrieve
// the cited sources.
//
// Verification (stage 4) is deliberately not here — this module stops at "we
// have the claim and we have the source text", which is the point at which the
// replay corpus in benchmark/dataset.json can substitute for live fetching, and
// the point beyond which nothing works until the model is wired up.
//
// Everything external is injected: article fetching, source fetching, and the
// DOM parser. That keeps the module testable without network or a JSDOM
// dependency in the hot path, and lets the Toolforge runner swap the source
// fetcher for whichever transport the egress decision lands on.

import { collectCitations } from '../core/citations.js';
import { fetchArticleHtml } from '../core/wikipedia.js';

// Why an article yielded nothing, as a machine-readable code. Same reasoning as
// the verdict reason codes: prose belongs in a presenter, not in a record that
// may be stored or aggregated.
export const ARTICLE_OUTCOMES = Object.freeze({
    OK: 'ok',
    FETCH_FAILED: 'fetch_failed',
    NO_CITATIONS: 'no_citations',
});

/**
 * Runs one article through stages 1-3.
 *
 * `candidate` is a row from service/article-picker.js: { pageId, title, revisionId }.
 *
 * Returns a record per article rather than throwing, because a batch run must
 * survive a single bad article — a 404 from a page deleted between selection
 * and fetch should skip that row, not abort the sweep.
 */
export async function processArticle(candidate, {
    parseHtml,
    fetchSource,
    fetchArticle = fetchArticleHtml,
    sourceCache = new Map(),
    signal,
} = {}) {
    if (typeof parseHtml !== 'function') {
        throw new TypeError('processArticle requires a parseHtml(html) => Document function');
    }
    if (typeof fetchSource !== 'function') {
        throw new TypeError('processArticle requires a fetchSource(url, pageNum) function');
    }

    const base = {
        pageId: candidate.pageId,
        title: candidate.title,
        revisionId: candidate.revisionId,
    };

    const { html, status, error } = await fetchArticle({
        title: candidate.title,
        revisionId: candidate.revisionId,
    });

    if (!html) {
        return { ...base, outcome: ARTICLE_OUTCOMES.FETCH_FAILED, fetchStatus: status, error, citations: [] };
    }

    // Parsoid output has no #mw-content-text wrapper, so the document is the
    // root — see core/citations.js.
    const citations = collectCitations(parseHtml(html));
    if (citations.length === 0) {
        return { ...base, outcome: ARTICLE_OUTCOMES.NO_CITATIONS, citations: [] };
    }

    const results = [];
    for (const citation of citations) {
        if (signal?.aborted) break;
        results.push({
            citationNumber: citation.citationNumber,
            refName: citation.refName,
            claimText: citation.claimText,
            url: citation.url,
            pageNum: citation.pageNum,
            groupId: citation.groupId,
            groupSize: citation.groupSize,
            groupIndex: citation.groupIndex,
            groupCitationNumbers: citation.groupCitationNumbers,
            source: await resolveSource(citation, fetchSource, sourceCache),
        });
    }

    return { ...base, outcome: ARTICLE_OUTCOMES.OK, citations: results };
}

// Cache key must include the page number: the same PDF cited at two different
// pages is two different source texts.
export function sourceCacheKey(url, pageNum) {
    return pageNum ? `${url}|page=${pageNum}` : url;
}

async function resolveSource(citation, fetchSource, cache) {
    if (!citation.url) {
        return { content: null, status: null, error: null, unavailableReason: 'no_url', cached: false };
    }

    const key = sourceCacheKey(citation.url, citation.pageNum);
    if (cache.has(key)) {
        return { ...cache.get(key), cached: true };
    }

    let result;
    try {
        const fetched = await fetchSource(citation.url, citation.pageNum);
        result = {
            content: fetched?.content ?? null,
            status: fetched?.status ?? null,
            error: fetched?.error ?? null,
            unavailableReason: fetched?.content ? null : 'fetch_failed',
        };
    } catch (error) {
        // A throwing fetcher must not take down the article. Recorded as a
        // fetch failure with no status, matching "we never got a response".
        result = {
            content: null,
            status: null,
            error: error?.message || String(error),
            unavailableReason: 'fetch_failed',
        };
    }

    cache.set(key, result);
    return { ...result, cached: false };
}

/**
 * Runs a list of candidates through processArticle, sharing one source cache
 * across the whole batch — the main reason batch fetching is cheaper than the
 * per-editor pattern, since one source is often cited across many articles.
 *
 * Yields per article so a caller can persist findings incrementally rather than
 * buffering an entire sweep.
 */
export async function* runBatch(candidates, options = {}) {
    const sourceCache = options.sourceCache ?? new Map();

    for (const candidate of candidates) {
        if (options.signal?.aborted) return;
        yield await processArticle(candidate, { ...options, sourceCache });
    }
}
