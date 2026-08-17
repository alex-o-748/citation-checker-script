#!/usr/bin/env node
// Runnable validation script for pipeline stages 1-2: selects candidate
// articles from Wiki Replicas, fetches each one's real rendered HTML from the
// Wikipedia REST API, and extracts its citations and claims.
//
// Stage 3 (fetching the cited sources) is deliberately stubbed here — that
// step is blocked on the source-fetcher Toolforge tool, which does not exist
// yet. Every citation with a URL will report "source fetching not wired up"
// until it does. This script exists to validate everything up to that point
// without depending on it.
//
// Usage (on a Toolforge bastion, inside the tool account):
//   node service/extract-articles.js
//   node service/extract-articles.js --criterion citation-needed --max 5

import { JSDOM } from 'jsdom';
import { parseArgs } from 'node:util';
import { openReplicaConnection, makeQueryFn } from './replicas.js';
import { selectCandidates, CRITERIA } from './selection.js';
import { runBatch, ARTICLE_OUTCOMES } from './pipeline.js';
import { fetchArticleHtml } from '../core/wikipedia.js';

function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            criterion: { type: 'string', default: 'failed-verification' },
            wiki:      { type: 'string', default: 'enwiki' },
            max:       { type: 'string', default: '3' },
            help:      { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        criterion: values.criterion,
        wiki: values.wiki,
        max: Number(values.max),
    };
}

const HELP_TEXT = `usage: node service/extract-articles.js [options]

Selects candidate articles from Wiki Replicas, fetches each one's real
rendered HTML, and extracts its citations and claims. Source fetching (stage
3) is stubbed — this validates selection and extraction only.

Options:
  --criterion <name>  Selection criterion. One of: ${Object.keys(CRITERIA).join(', ')}
                       (default: failed-verification)
  --wiki <db>          Wiki database name, e.g. enwiki, frwiki (default: enwiki)
  --max <n>            Maximum articles to process (default: 3)
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
        error: 'source fetching not wired up yet — waiting on the source-fetcher Toolforge tool',
    };
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

    process.stderr.write(`selected ${candidates.length} article(s); fetching and extracting...\n\n`);

    let totalCitations = 0;
    let totalWithUrl = 0;

    for await (const result of runBatch(candidates, {
        parseHtml,
        fetchArticle: fetchArticleHtml,
        fetchSource: stubFetchSource,
    })) {
        const { citations, withUrl } = printArticle(result);
        totalCitations += citations;
        totalWithUrl += withUrl;
    }

    process.stderr.write(
        `done. ${totalCitations} citation(s) extracted across ${candidates.length} article(s), ${totalWithUrl} with a fetchable URL.\n`
    );
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
