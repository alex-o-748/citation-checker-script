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
import { attachArticleContext, articleCategories } from '../core/article-context.js';
import { fetchArticleHtml } from '../core/wikipedia.js';
import { sentencexLastSentence } from './sentences.js';
import { hostOf, runHostPool } from './host-pool.js';

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
    // The batch pipeline defaults to sentence-scope claims: unlike the
    // interactive userscript, nobody is there to read a two-sentence claim
    // and recognize that only its first sentence is unsupported. At
    // paragraph scope that reads as a false NOT SUPPORTED — the sentence
    // that's actually supported drags along a citation-needed sentence that
    // isn't. Narrowing to the sentence immediately preceding the reference
    // keeps flags meaning "this citation doesn't support what's right next
    // to it" rather than "something in this whole span isn't supported".
    claimScope = 'sentence',
    // The article's language, for sentence splitting: each language has its
    // own abbreviations ("г.", "ул.", "Dr.") that end in a period without
    // ending the sentence. See service/sentences.js.
    langCode = 'en',
    splitLastSentence = sentencexLastSentence(langCode),
    // How many sources to fetch at once. 1 is the old serial behavior; the
    // runners pass --fetch-concurrency. Never more than one per host either
    // way — see service/host-pool.js.
    fetchConcurrency = 1,
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
    const root = parseHtml(html);
    const citations = collectCitations(root, { claimScope, splitLastSentence });
    // Categories ride on the article record, not each citation: the egregiousness
    // pass reads Category:Living people off them (see core/article-context.js).
    const categories = articleCategories(root);
    if (citations.length === 0) {
        return { ...base, outcome: ARTICLE_OUTCOMES.NO_CITATIONS, categories, citations: [] };
    }
    attachArticleContext(citations, root);

    // Every source this article needs, fetched up front and concurrently
    // (see service/host-pool.js), then attached below in citation order.
    const fresh = await fetchSources(citations, fetchSource, sourceCache, {
        concurrency: fetchConcurrency,
        signal,
    });

    const results = [];
    for (const citation of citations) {
        // An abort stops new fetches, so the citations after it have nothing
        // to attach; report the ones that finished, in order, and stop there —
        // what the serial loop did.
        const source = citation.skipReason
            ? { content: null, status: null, error: null, unavailableReason: null, cached: false }
            : sourceFor(citation, sourceCache, fresh);
        if (!source) break;
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
            skipReason: citation.skipReason,
            sectionTitle: citation.sectionTitle,
            paragraphText: citation.paragraphText,
            source,
        });
    }

    return { ...base, outcome: ARTICLE_OUTCOMES.OK, categories, citations: results };
}

// Cache key must include the page number: the same PDF cited at two different
// pages is two different source texts.
export function sourceCacheKey(url, pageNum) {
    return pageNum ? `${url}|page=${pageNum}` : url;
}

// Fetches every distinct source `citations` need that `cache` doesn't already
// hold, `concurrency` at a time and never two to one host at once, writing
// each result into `cache`. Returns the keys fetched by this call, so the
// first citation to use one can be reported `cached: false` — the same
// first-use-pays accounting the serial loop had.
async function fetchSources(citations, fetchSource, cache, { concurrency = 1, signal } = {}) {
    const jobs = [];
    const queued = new Set();
    for (const citation of citations) {
        // A skipped citation never reaches a model, so fetching its source
        // would spend a third party's bandwidth for nothing.
        if (citation.skipReason || !citation.url) continue;
        const key = sourceCacheKey(citation.url, citation.pageNum);
        if (cache.has(key) || queued.has(key)) continue;
        queued.add(key);
        jobs.push({ key, url: citation.url, pageNum: citation.pageNum });
    }

    const fresh = new Set();
    await runHostPool(jobs, async job => {
        cache.set(job.key, await fetchOne(job, fetchSource));
        fresh.add(job.key);
    }, { concurrency, keyOf: job => hostOf(job.url), signal });
    return fresh;
}

async function fetchOne({ url, pageNum }, fetchSource) {
    try {
        const fetched = await fetchSource(url, pageNum);
        return {
            content: fetched?.content ?? null,
            status: fetched?.status ?? null,
            error: describeFetchError(fetched),
            unavailableReason: fetched?.content ? null : 'fetch_failed',
        };
    } catch (error) {
        // A throwing fetcher must not take down the article. Recorded as a
        // fetch failure with no status, matching "we never got a response".
        return {
            content: null,
            status: null,
            error: error?.message || String(error),
            unavailableReason: 'fetch_failed',
        };
    }
}

// The fetcher's message, plus its connection error code when it sent one:
// "fetch failed" alone covers a dead domain, a refused connection and a reset
// alike, and the CSV's fetch_error column is where a sweep is diagnosed after
// the fact. See core/worker.js's isPublisherNetworkFailure.
function describeFetchError(fetched) {
    const error = fetched?.error ?? null;
    if (!error || !fetched?.errorCode) return error;
    return `${error} (${fetched.errorCode})`;
}

// The source to attach to one citation, or null if it was never fetched (the
// run was aborted first).
function sourceFor(citation, cache, fresh) {
    if (!citation.url) {
        return { content: null, status: null, error: null, unavailableReason: 'no_url', cached: false };
    }
    const key = sourceCacheKey(citation.url, citation.pageNum);
    if (!cache.has(key)) return null;
    const cached = !fresh.delete(key);
    return { ...cache.get(key), cached };
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
