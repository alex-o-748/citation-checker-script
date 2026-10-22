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
// A CSV's run record (<name>-run.json, service/sweep-runs.js) is loaded with
// it when present, so a run made with --no-store, or whose own record write
// failed, still reaches sweep_runs. CSVs from before run records have none.
//
// Usage (in a Toolforge job or bastion shell; ToolsDB isn't reachable elsewhere):
//   node service/run-import-findings.js ru-batch4-findings.csv --wiki ruwiki
//   node service/run-import-findings.js ru-batch3-findings.csv ru-batch4-findings.csv --wiki ruwiki
//   node service/run-import-findings.js ru-batch4-findings.csv --wiki ruwiki --dry-run

import { parseArgs } from 'node:util';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { streamCsvRows } from './csv-stream.js';
import { upsertFinding } from './findings-store.js';
import { openToolsDbConnection } from './toolsdb.js';
import { makeQueryFn } from './replicas.js';
import { FINDING_TTL_DAYS } from './finding-builder.js';
import { runJsonPath, upsertRun, missingRunSchema } from './sweep-runs.js';

export const HELP_TEXT = `usage: node service/run-import-findings.js <findings.csv>... --wiki <db> [options]

Upserts every row of one or more run-sweep.js findings CSVs into ToolsDB's
citation_findings table, and each CSV's <name>-run.json (when there is one)
into sweep_runs. Safe to re-run: existing rows are updated, not duplicated
(after migration 004). Needs migration 006 (service/migrations/).

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
        // Absent from CSVs written before migration 006; null then.
        runId: textOrNull(row.run_id),
    };
}

export async function runImport(opts, {
    stderr = process.stderr,
    connectToolsDb = openToolsDbConnection,
    streamRows = streamCsvRows,
    stat = fsStat,
    readFile = fsReadFile,
} = {}) {
    if (!opts.wiki) {
        stderr.write('import: --wiki is required (the CSV does not record which wiki it came from)\n');
        return 2;
    }
    if (!opts.files.length) {
        stderr.write('import: name at least one findings CSV\n');
        return 2;
    }

    let connection = null;
    let query = null;
    if (!opts.dryRun) {
        try {
            connection = await connectToolsDb();
            query = makeQueryFn(connection);
        } catch (error) {
            stderr.write(`import: could not connect to ToolsDB: ${error.message}\n`);
            return 1;
        }
        const missing = await missingRunSchema(query);
        if (missing) {
            stderr.write(`import: ${missing.replace(', or pass --no-store', '')}\n`);
            await connection.end();
            return 1;
        }
    }

    // Returns false only when a record exists and could not be written.
    async function importRunRecord(file) {
        let record;
        try {
            record = JSON.parse(await readFile(runJsonPath(file), 'utf8'));
        } catch {
            return true; // no run record beside this CSV: older than run records
        }
        if (!query) {
            stderr.write(`import: ${file}: run ${record.run_id} would be recorded\n`);
            return true;
        }
        try {
            await upsertRun(query, record);
            stderr.write(`import: ${file}: run ${record.run_id} recorded\n`);
            return true;
        } catch (error) {
            stderr.write(`import: ${file}: could not record run ${record.run_id}: ${error.message}\n`);
            return false;
        }
    }

    let failed = false;
    try {
        for (const file of opts.files) {
            const fetchedAt = (await stat(file)).mtime;
            const counts = { written: 0, noPageId: 0, malformed: 0, failed: 0 };
            let firstError = null;
            // streamRows calls onRow synchronously, so a file's findings are
            // collected first and then upserted one at a time, in order. The
            // 44k-row ruwiki batch is on the order of 100 MB held at once —
            // fine for a 2Gi job; split the CSV if one ever isn't.
            const pending = [];
            await streamRows(file, {
                onRow: row => {
                    const finding = findingFromCsvRow(row, { wiki: opts.wiki, fetchedAt });
                    if (!finding) { counts.noPageId++; return; }
                    if (!query) { counts.written++; return; }
                    pending.push(finding);
                },
                onMalformed: () => { counts.malformed++; },
            });
            for (const finding of pending.splice(0)) {
                try {
                    await upsertFinding(query, finding);
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
                + '\n'
            );
            if (counts.failed) failed = true;
            if (!(await importRunRecord(file))) failed = true;
        }
    } finally {
        if (connection) await connection.end();
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
