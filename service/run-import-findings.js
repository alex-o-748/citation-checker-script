#!/usr/bin/env node
// Loads findings CSVs (service/run-sweep.js's --out) into ToolsDB.
//
// Two uses:
// - Backfilling batches that never reached ToolsDB: every sweep before
//   storing became the default (2026-10), and any run with --no-store. Once
//   loaded, service/run-pick-pilot.js leaves their articles out of new
//   batches by itself, with no --exclude-titles-file per batch.
// - Catching up after ToolsDB writes failed mid-sweep. The sweep keeps going
//   and prints this command; the CSV is the record and the store follows it.
//
// Re-running is safe: rows are upserted on citation_findings' unique key, so
// a second import of the same CSV updates rows rather than adding them —
// provided service/migrations/004-store-by-default.sql has been applied,
// which is also what lets rows with no model call (provider '') match.
//
// The CSV lacks two stored fields. `wiki` comes from --wiki. `fetched_at`
// (and the expiry computed from it) is taken from the CSV file's
// modification time, i.e. when the sweep last wrote to it — off by up to the
// length of the run, which is close enough for an expiry 30 days out.
//
// Usage (in a Toolforge job or bastion shell; ToolsDB isn't reachable elsewhere):
//   node service/run-import-findings.js ru-batch4-findings.csv --wiki ruwiki
//   node service/run-import-findings.js ru-batch3-findings.csv ru-batch4-findings.csv --wiki ruwiki
//   node service/run-import-findings.js ru-batch4-findings.csv --wiki ruwiki --dry-run

import { parseArgs } from 'node:util';
import { stat as fsStat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { iterateCsvRows } from './csv-stream.js';
import { upsertFinding } from './findings-store.js';
import { openToolsDbConnection, openReconnectingQuery } from './toolsdb.js';
import { FINDING_TTL_DAYS } from './finding-builder.js';

export const HELP_TEXT = `usage: node service/run-import-findings.js <findings.csv>... --wiki <db> [options]

Upserts every row of one or more run-sweep.js findings CSVs into ToolsDB's
citation_findings table. Safe to re-run: existing rows are updated, not
duplicated (after migration 004).

Options:
  --wiki <db>     Wiki database name the CSVs were swept on, e.g. ruwiki. Required.
  --dry-run       Read and convert every row, report counts, write nothing
                  (and don't connect to ToolsDB).
  --help, -h      Show this help and exit.
`;

const numberOrNull = value => (value === '' || value === undefined || value === null ? null : Number(value));
const textOrNull = value => (value === '' || value === undefined ? null : value);

/**
 * Turns one CSV row (keyed by header name) back into the finding shape
 * service/finding-builder.js produces, as far as the CSV carries it. Returns
 * null for a row ToolsDB can't hold: no page id (a title that never resolved).
 */
export function findingFromCsvRow(row, { wiki, fetchedAt, ttlDays = FINDING_TTL_DAYS }) {
    const pageId = numberOrNull(row.page_id);
    if (!pageId) return null;
    // A source was fetched unless the row says otherwise; mirrors
    // finding-builder.js, which sets fetched_at / expires_at only then.
    const hasContent = row.verdict !== 'SOURCE UNAVAILABLE' && row.verdict !== 'SKIPPED';
    return {
        wiki,
        pageId,
        pageTitle: row.page_title,
        revisionId: numberOrNull(row.revision_id),
        claimText: row.claim_text ?? '',
        citationNumber: textOrNull(row.citation_number),
        refName: textOrNull(row.ref_name),
        sourceUrl: textOrNull(row.source_url),
        fetchedAt: hasContent ? fetchedAt : null,
        groupId: textOrNull(row.group_id),
        isCollective: row.is_collective === '1',
        verdict: row.verdict,
        supportScore: numberOrNull(row.support_score),
        reasonType: textOrNull(row.reason_type),
        rationale: textOrNull(row.rationale),
        sourceQuote: textOrNull(row.source_quote),
        quoteStatus: textOrNull(row.quote_status),
        provider: textOrNull(row.provider),
        model: textOrNull(row.model),
        promptVersion: row.prompt_version,
        fetchStatus: numberOrNull(row.fetch_status),
        sourceTruncated: row.source_truncated === '1',
        tokensIn: numberOrNull(row.tokens_in),
        tokensOut: numberOrNull(row.tokens_out),
        expiresAt: hasContent ? new Date(fetchedAt.getTime() + ttlDays * 24 * 60 * 60 * 1000) : null,
        published: row.published === '1',
    };
}

// Rows are upserted as they are read, never collected first: holding every
// finding of the 122,542-row November 2026 ruwiki rerun got the 1 GiB job
// OOM-killed (exit 137) before it wrote a row or printed a line. The
// connection is reopened if it drops (openReconnectingQuery), and progress is
// printed every PROGRESS_EVERY rows so a long import is never silent.
export const PROGRESS_EVERY = 5000;

export async function runImport(opts, {
    stderr = process.stderr,
    connectToolsDb = openToolsDbConnection,
    iterateRows = iterateCsvRows,
    stat = fsStat,
} = {}) {
    if (!opts.wiki) {
        stderr.write('import: --wiki is required (the CSV does not record which wiki it came from)\n');
        return 2;
    }
    if (!opts.files.length) {
        stderr.write('import: name at least one findings CSV\n');
        return 2;
    }

    let db = null;
    if (!opts.dryRun) {
        try {
            db = await openReconnectingQuery(() => connectToolsDb(), {
                onReconnect: (error, n) => stderr.write(`import: ToolsDB connection lost (${error.message}); reconnected (${n})\n`),
            });
        } catch (error) {
            stderr.write(`import: could not connect to ToolsDB: ${error.message}\n`);
            return 1;
        }
    }

    let failed = false;
    try {
        for (const file of opts.files) {
            const fetchedAt = (await stat(file)).mtime;
            const counts = { written: 0, noPageId: 0, malformed: 0, failed: 0 };
            let firstError = null;
            let seen = 0;
            for await (const { row, malformed } of iterateRows(file)) {
                if (++seen % PROGRESS_EVERY === 0) {
                    stderr.write(`import: ${file}: ${seen} rows read, ${counts.written} written, ${counts.failed} failed\n`);
                }
                if (malformed) { counts.malformed++; continue; }
                const finding = findingFromCsvRow(row, { wiki: opts.wiki, fetchedAt });
                if (!finding) { counts.noPageId++; continue; }
                if (!db) { counts.written++; continue; }
                try {
                    await upsertFinding(db.query, finding);
                    counts.written++;
                } catch (error) {
                    counts.failed++;
                    firstError ??= error;
                }
            }
            stderr.write(
                `import: ${file}: ${counts.written} row(s) ${opts.dryRun ? 'would be written' : 'written'}`
                + `, ${counts.noPageId} without a page id skipped, ${counts.malformed} malformed`
                + (counts.failed ? `, ${counts.failed} failed (first: ${firstError.message})` : '')
                + (db?.reconnects ? `, ${db.reconnects} reconnect(s)` : '')
                + '\n'
            );
            if (counts.failed) failed = true;
        }
    } finally {
        if (db) await db.end();
    }
    return failed ? 1 : 0;
}

export function parseCliArgs(argv) {
    const { values, positionals } = parseArgs({
        args: argv.slice(2),
        options: {
            wiki: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
        strict: true,
    });
    return { help: values.help, wiki: values.wiki, dryRun: values['dry-run'], files: positionals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const opts = parseCliArgs(process.argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
    } else {
        process.exitCode = await runImport(opts);
    }
}
