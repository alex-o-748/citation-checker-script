#!/usr/bin/env node
// Runnable validation script for pipeline stages 1-3: selects candidate
// articles from Wiki Replicas, fetches each one's real rendered HTML from the
// Wikipedia REST API, extracts its citations and claims, and (opt-in only)
// fetches the cited sources via the tf-source-fetcher Toolforge tool
// (https://github.com/alex-o-748/tf-source-fetcher).
//
// Stage 3 defaults to a stub. tf-source-fetcher is built and deployable, but
// per its own README, unattended fetching of third-party publisher URLs from
// Wikimedia infrastructure has not yet been cleared with WMCS — so no batch
// job may be pointed at it as a matter of course. Pass --live-source-fetch to
// opt in for a one-off manual smoke test (e.g. from a Toolforge bastion,
// after checking WMCS clearance); every other run stays stubbed.
//
// Usage (on a Toolforge bastion, inside the tool account):
//   node service/extract-articles.js
//   node service/extract-articles.js --criterion citation-needed --max 5
//   node service/extract-articles.js --live-source-fetch --max 1

import { JSDOM } from 'jsdom';
import { parseArgs } from 'node:util';
import { openReplicaConnection, makeQueryFn } from './replicas.js';
import { selectCandidates, CRITERIA } from './selection.js';
import { runBatch, ARTICLE_OUTCOMES } from './pipeline.js';
import { fetchArticleHtml } from '../core/wikipedia.js';
import { fetchSourceContent } from '../core/worker.js';

// Same contract, same query shape (?fetch=&page=), same Google-Books-skip and
// Wayback-fallback behavior as the reference Cloudflare Worker proxy — see
// that repo's README ("Behavior carried over from the reference Worker").
const TOOLFORGE_SOURCE_FETCHER_BASE = 'https://source-fetcher.toolforge.org';

function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            criterion:        { type: 'string', default: 'failed-verification' },
            wiki:             { type: 'string', default: 'enwiki' },
            max:              { type: 'string', default: '3' },
            'live-source-fetch': { type: 'boolean', default: false },
            help:             { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        criterion: values.criterion,
        wiki: values.wiki,
        max: Number(values.max),
        liveSourceFetch: values['live-source-fetch'],
    };
}

const HELP_TEXT = `usage: node service/extract-articles.js [options]

Selects candidate articles from Wiki Replicas, fetches each one's real
rendered HTML, and extracts its citations and claims. Source fetching (stage
3) is stubbed by default — pass --live-source-fetch to fetch real sources via
tf-source-fetcher for a one-off manual smoke test. Per that service's own
README, it is not yet cleared by WMCS for unattended production traffic, so
--live-source-fetch is opt-in only and should not be used in a scheduled job.

Options:
  --criterion <name>  Selection criterion. One of: ${Object.keys(CRITERIA).join(', ')}
                       (default: failed-verification)
  --wiki <db>          Wiki database name, e.g. enwiki, frwiki (default: enwiki)
  --max <n>            Maximum articles to process (default: 3)
  --live-source-fetch  Fetch real sources via tf-source-fetcher instead of the
                        stub. Manual smoke-test use only (see above).
  --help, -h           Show this help and exit.
`;

const parseHtml = html => new JSDOM(html).window.document;

// Stage 3 stand-in. Every citation with a URL will resolve to
// unavailableReason "fetch_failed" carrying this message, which is accurate —
// it genuinely was not fetched — rather than a real failure.
async function stubFetchSource() {
    return {
        content: null,
        status: null,
        error: 'source fetching not wired up — pass --live-source-fetch to fetch via tf-source-fetcher',
    };
}

async function liveFetchSource(url, pageNum) {
    return fetchSourceContent(url, pageNum, { workerBase: TOOLFORGE_SOURCE_FETCHER_BASE });
}

function describeSource(source) {
    if (source.content) {
        const cached = source.cached ? ', cached' : '';
        return `fetched, ${source.content.length} chars (status ${source.status}${cached})`;
    }
    return `unavailable (${source.unavailableReason}, status ${source.status}): ${source.error}`;
}

function printArticle(result) {
    process.stdout.write(`## ${result.title} (page ${result.pageId}, rev ${result.revisionId})\n`);
    process.stdout.write(`outcome: ${result.outcome}\n`);

    if (result.outcome === ARTICLE_OUTCOMES.FETCH_FAILED) {
        process.stdout.write(`  article fetch failed (status ${result.fetchStatus}): ${result.error}\n\n`);
        return { citations: 0, withUrl: 0 };
    }
    if (result.outcome === ARTICLE_OUTCOMES.NO_CITATIONS) {
        process.stdout.write(`  no citations extracted\n\n`);
        return { citations: 0, withUrl: 0 };
    }

    const withUrl = result.citations.filter(c => c.url).length;
    process.stdout.write(`  citations: ${result.citations.length} (${withUrl} with a fetchable URL)\n`);

    for (const c of result.citations.slice(0, 2)) {
        const claim = c.claimText.length > 100 ? `${c.claimText.slice(0, 100)}…` : c.claimText;
        process.stdout.write(`  [${c.citationNumber}] ${claim}\n`);
        process.stdout.write(`      url: ${c.url || '(none)'}\n`);
        if (c.url) {
            process.stdout.write(`      source: ${describeSource(c.source)}\n`);
        }
    }
    process.stdout.write('\n');

    return { citations: result.citations.length, withUrl };
}

async function main(argv) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    if (!Number.isInteger(opts.max) || opts.max < 1) {
        process.stderr.write(`error: --max must be a positive integer (got: ${opts.max})\n`);
        return 2;
    }

    let connection;
    try {
        connection = await openReplicaConnection({ wikiDb: opts.wiki });
    } catch (error) {
        process.stderr.write(`error: could not connect to Wiki Replicas: ${error.message}\n`);
        return 1;
    }

    let candidates;
    try {
        candidates = await selectCandidates(makeQueryFn(connection), {
            criterion: opts.criterion,
            max: opts.max,
        });
    } catch (error) {
        process.stderr.write(`error: ${error.message}\n`);
        return 1;
    } finally {
        // Done with Replicas before the (slower, external) REST fetches begin
        // — no reason to hold the DB connection open across them.
        await connection.end();
    }

    if (opts.liveSourceFetch) {
        process.stderr.write(
            `WARNING: --live-source-fetch is on — fetching real sources via ${TOOLFORGE_SOURCE_FETCHER_BASE}. ` +
            `Confirm WMCS has cleared unattended fetching before using this outside a manual smoke test.\n`
        );
    }

    process.stderr.write(`selected ${candidates.length} article(s); fetching and extracting...\n\n`);

    let totalCitations = 0;
    let totalWithUrl = 0;

    // core/urls.js logs one console.log per citation it examines (no-URL,
    // page-number-extracted, Harvard/sfn resolution) — fine for a human
    // watching one article in devtools, unusable noise for a batch article
    // with 80+ citations and nobody reading in real time. That module is
    // shared with the live userscript and the CLI, where the logging is
    // legitimate, so it stays as-is there; this suppresses only around the
    // extraction loop in this script.
    const realLog = console.log;
    console.log = () => {};
    try {
        for await (const result of runBatch(candidates, {
            parseHtml,
            fetchArticle: fetchArticleHtml,
            fetchSource: opts.liveSourceFetch ? liveFetchSource : stubFetchSource,
        })) {
            const { citations, withUrl } = printArticle(result);
            totalCitations += citations;
            totalWithUrl += withUrl;
        }
    } finally {
        console.log = realLog;
    }

    process.stderr.write(
        `done. ${totalCitations} citation(s) extracted across ${candidates.length} article(s), ${totalWithUrl} with a fetchable URL.\n`
    );
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
