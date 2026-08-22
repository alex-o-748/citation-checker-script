#!/usr/bin/env node
// Runnable entry point for the ToolsDB findings write path: selects
// candidate articles from Wiki Replicas, runs stages 1-3 (select-articles.js
// + extract-articles.js's machinery), maps each article's citations to
// finding records (service/finding-record.js), and writes them to ToolsDB
// (service/findings.js) — or just reports what it would write.
//
// See docs/design-plans/2026-08-21-findings-write-path-wiring.md for the
// design this wires together.
//
// Usage (on a Toolforge bastion, inside the tool account):
//   node service/store-findings.js --criterion failed-verification --max 5
//   node service/store-findings.js --max 1 --live-source-fetch --write
//
// --dry-run (report only, no ToolsDB writes) is the DEFAULT, not --write —
// stage 3 is stubbed by default (see extract-articles.js's own header on why
// live source fetching is opt-in only), and a default-on write would pour
// dozens of fabricated "unavailable" rows into the live table on someone's
// first exploratory run. Pass --write to actually persist.
//
// Stage 4 (calling an LLM to compute a verdict) is a separate, not-yet-built
// piece — see docs/design-plans/2026-08-07-batch-source-checks-for-edit-
// suggestions.md §4. This runner's default verifyCitation/verifyGroup THROW
// if ever actually invoked. In practice that only happens when
// --live-source-fetch surfaces a citation with real fetched content
// (SOURCE_UNAVAILABLE and no-URL findings never call the verifier at all —
// see service/finding-record.js) — so a plain run, or a --live-source-fetch
// run over articles with no fetchable sources, completes cleanly regardless.

import { parseArgs } from 'node:util';
import { openReplicaConnection, makeQueryFn as makeReplicaQueryFn } from './replicas.js';
import { selectCandidates, CRITERIA } from './selection.js';
import { runBatch } from './pipeline.js';
import { fetchArticleHtml } from '../core/wikipedia.js';
import { fetchSourceContent } from '../core/worker.js';
import { openToolsDbConnection } from './toolsdb.js';
import { toFindingRecords } from './finding-record.js';
import { buildUpsertQuery, buildBulkUpsertQuery } from './findings.js';

// Same contract as extract-articles.js's TOOLFORGE_SOURCE_FETCHER_BASE.
const TOOLFORGE_SOURCE_FETCHER_BASE = 'https://source-fetcher.toolforge.org';

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            criterion:           { type: 'string', default: 'failed-verification' },
            wiki:                { type: 'string', default: 'enwiki' },
            max:                 { type: 'string', default: '3' },
            'live-source-fetch': { type: 'boolean', default: false },
            write:               { type: 'boolean', default: false },
            help:                { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        criterion: values.criterion,
        wiki: values.wiki,
        max: Number(values.max),
        liveSourceFetch: values['live-source-fetch'],
        write: values.write,
    };
}

const HELP_TEXT = `usage: node service/store-findings.js [options]

Selects candidate articles from Wiki Replicas, extracts their citations, and
maps them to citation_findings rows. Reports what it would write by default;
pass --write to actually persist to ToolsDB.

Options:
  --criterion <name>   Selection criterion. One of: ${Object.keys(CRITERIA).join(', ')}
                        (default: failed-verification)
  --wiki <db>           Wiki database name, e.g. enwiki, frwiki (default: enwiki)
  --max <n>             Maximum articles to process (default: 3)
  --live-source-fetch   Fetch real sources via tf-source-fetcher instead of
                         the stub. Manual smoke-test use only — see
                         extract-articles.js's own header for why.
  --write               Actually write findings to ToolsDB. Without this flag,
                         nothing is written; the run only reports counts.
  --help, -h            Show this help and exit.
`;

async function stubFetchSource() {
    return { content: null, status: null, error: 'source fetching not wired up — pass --live-source-fetch to fetch via tf-source-fetcher' };
}

async function liveFetchSource(url, pageNum) {
    return fetchSourceContent(url, pageNum, { workerBase: TOOLFORGE_SOURCE_FETCHER_BASE });
}

function verifierNotImplemented(kind) {
    return async () => {
        throw new Error(
            `${kind} was called, but stage 4 (LLM verification) isn't wired into store-findings.js yet — ` +
            `see docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md §4. ` +
            `This should only happen with --live-source-fetch over an article with a real, fetchable source.`
        );
    };
}

/**
 * Writes one article's finding records to ToolsDB inside a transaction, all
 * or nothing. On a chunk failure, falls back to per-row writes for that
 * article so one bad row doesn't cost the rest of the sweep — the offending
 * row is reported by row-level failure, not by aborting silently.
 *
 * `connection` needs execute/beginTransaction/commit/rollback — the mysql2
 * connection shape. Injectable so this is testable with a fake.
 */
export async function writeRecords(connection, records) {
    if (records.length === 0) return { written: 0, failed: [] };

    await connection.beginTransaction();
    try {
        for (const { sql, params } of buildBulkUpsertQuery(records)) {
            await connection.execute(sql, params);
        }
        await connection.commit();
        return { written: records.length, failed: [] };
    } catch (batchError) {
        await connection.rollback();
        return writeRecordsIndividually(connection, records, batchError);
    }
}

async function writeRecordsIndividually(connection, records, batchError) {
    let written = 0;
    const failed = [];
    for (const record of records) {
        try {
            const { sql, params } = buildUpsertQuery(record);
            await connection.execute(sql, params);
            written++;
        } catch (rowError) {
            failed.push({ record, error: rowError.message });
        }
    }
    return { written, failed, batchError: batchError.message };
}

/**
 * Runs the sweep: candidates -> pipeline stages 1-3 -> finding records ->
 * (optionally) ToolsDB writes. Every external dependency is injected, so this
 * is fully testable without Wiki Replicas, ToolsDB, or a real HTTP fetch.
 *
 * `connection` is null/undefined for a dry run (report only); otherwise a
 * ToolsDB connection (execute/beginTransaction/commit/rollback).
 *
 * Returns a summary: { articles, records, skipped: {reason: count}, written,
 * failed, perArticle: [...] }.
 */
export async function runSweep({
    candidates,
    parseHtml,
    fetchArticle,
    fetchSource,
    wiki,
    sourceFetchEnabled,
    verifyCitation = verifierNotImplemented('verifyCitation'),
    verifyGroup = verifierNotImplemented('verifyGroup'),
    connection = null,
    log = () => {},
}) {
    const summary = {
        articles: 0,
        records: 0,
        skipped: {},
        written: 0,
        failed: [],
        perArticle: [],
    };

    for await (const article of runBatch(candidates, { parseHtml, fetchArticle, fetchSource })) {
        summary.articles++;

        const { records, skipped } = await toFindingRecords(article, {
            wiki,
            sourceFetchEnabled,
            verifyCitation,
            verifyGroup,
        });

        for (const s of skipped) {
            summary.skipped[s.reason] = (summary.skipped[s.reason] || 0) + 1;
        }
        summary.records += records.length;

        let written = 0;
        if (connection && records.length > 0) {
            const result = await writeRecords(connection, records);
            written = result.written;
            summary.written += result.written;
            if (result.failed.length) summary.failed.push(...result.failed);
        }

        summary.perArticle.push({
            pageId: article.pageId,
            title: article.title,
            outcome: article.outcome,
            records: records.length,
            skipped: skipped.length,
            written,
        });
        log(article, { records, skipped, written });
    }

    return summary;
}

function printArticleLog(article, { records, skipped, written }, opts) {
    process.stdout.write(`## ${article.title} (page ${article.pageId})\n`);
    process.stdout.write(`  outcome: ${article.outcome}\n`);
    if (article.outcome !== 'ok') {
        process.stdout.write('\n');
        return;
    }
    const skipLine = skipped.length
        ? ` (skipped: ${Object.entries(
            skipped.reduce((acc, s) => ((acc[s.reason] = (acc[s.reason] || 0) + 1), acc), {})
        ).map(([r, n]) => `${n} ${r}`).join(', ')})`
        : '';
    process.stdout.write(`  findings: ${records.length}${skipLine}\n`);
    process.stdout.write(`  ${opts.write ? 'written' : 'would write'}: ${opts.write ? written : records.length}\n\n`);
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

    let replicaConnection;
    try {
        replicaConnection = await openReplicaConnection({ wikiDb: opts.wiki });
    } catch (error) {
        process.stderr.write(`error: could not connect to Wiki Replicas: ${error.message}\n`);
        return 1;
    }

    let candidates;
    try {
        candidates = await selectCandidates(makeReplicaQueryFn(replicaConnection), {
            criterion: opts.criterion,
            max: opts.max,
        });
    } catch (error) {
        process.stderr.write(`error: ${error.message}\n`);
        return 1;
    } finally {
        await replicaConnection.end();
    }

    let toolsDbConnection = null;
    if (opts.write) {
        try {
            toolsDbConnection = await openToolsDbConnection({});
        } catch (error) {
            process.stderr.write(`error: could not connect to ToolsDB: ${error.message}\n`);
            return 1;
        }
    }

    if (opts.liveSourceFetch) {
        process.stderr.write(
            `WARNING: --live-source-fetch is on — fetching real sources via ${TOOLFORGE_SOURCE_FETCHER_BASE}. ` +
            `Confirm WMCS has cleared unattended fetching before using this outside a manual smoke test.\n`
        );
    }
    if (!opts.write) {
        process.stderr.write('DRY RUN — nothing will be written to ToolsDB. Pass --write to persist.\n');
    }
    process.stderr.write(`selected ${candidates.length} article(s); processing...\n\n`);

    const { JSDOM } = await import('jsdom');
    const realLog = console.log;
    console.log = () => {}; // silence core/urls.js's per-citation logging — see extract-articles.js's comment on the same suppression
    let summary;
    try {
        summary = await runSweep({
            candidates,
            parseHtml: html => new JSDOM(html).window.document,
            fetchArticle: fetchArticleHtml,
            fetchSource: opts.liveSourceFetch ? liveFetchSource : stubFetchSource,
            wiki: opts.wiki,
            sourceFetchEnabled: opts.liveSourceFetch,
            connection: toolsDbConnection,
            log: (article, result) => printArticleLog(article, result, opts),
        });
    } finally {
        console.log = realLog;
        if (toolsDbConnection) await toolsDbConnection.end();
    }

    const skipSummary = Object.entries(summary.skipped).map(([r, n]) => `${n} ${r}`).join(', ') || 'none';
    process.stderr.write(
        `done. ${summary.articles} article(s), ${summary.records} finding(s) ${opts.write ? 'written' : 'computed'} ` +
        `(skipped: ${skipSummary}).\n`
    );
    if (summary.failed.length) {
        process.stderr.write(`WARNING: ${summary.failed.length} row(s) failed to write individually after a batch rollback:\n`);
        for (const f of summary.failed) {
            process.stderr.write(`  page ${f.record.pageId}, claim "${f.record.claimText.slice(0, 60)}…": ${f.error}\n`);
        }
        return 1;
    }
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
