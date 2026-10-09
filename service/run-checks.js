#!/usr/bin/env node
// Runs the post-run checks (service/sweep-checks.js) over a findings CSV and
// writes three small files beside it:
//
//   <name>-checks.md    the report: one line per check, PASS / WARN / FAIL
//   <name>-checks.json  the same, plus the metrics (rows per article, verdicts,
//                       fetch failures by cause), for comparing a later run
//   <name>-review.csv   the rows worth reading: example suspect rows from each
//                       row check, plus a random sample of each verdict
//
// service/run-sweep.js calls runChecksOnFile() at the end of every sweep; this
// CLI is for any existing CSV, including one from a run that was killed.
//
// Usage:
//   node service/run-checks.js findings.csv
//   node service/run-checks.js findings.csv --titles-file service/article-lists/pilot-100.txt --wiki enwiki
//
// Exit codes: 0 no check failed (warnings allowed), 1 at least one check
// failed, 2 bad arguments or an unreadable file.

import { parseArgs } from 'node:util';
import { extname } from 'node:path';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';

import { streamCsvRows } from './csv-stream.js';
import { createSweepChecker, renderMarkdown, reviewRows, LEVELS } from './sweep-checks.js';
import { csvHeaderLine, parseCsv } from './csv-report.js';

export const HELP_TEXT = `usage: node service/run-checks.js <findings.csv> [options]

Checks a batch findings CSV for signs that the run went wrong: missing
articles, fetch outages, ERROR rows, markup in claims, rationales in the wrong
language, answers that break the prompt's format, and more. Streams the file,
so its size doesn't matter. Writes <name>-checks.md, <name>-checks.json and
<name>-review.csv beside it.

Options:
  --titles-file <path>  The titles list the run was given; enables the
                         coverage check (which titles produced no rows).
  --wiki <db>           Wiki database name, e.g. ruwiki. Default: read from
                         the rows' permalinks.
  --seed <n>            Seed for the random examples and sample (default: 1).
  --help, -h            Show this help and exit.

Exit codes: 0 no check failed, 1 a check failed, 2 bad arguments or I/O error.
`;

export function checksPaths(csvPath) {
    const extension = extname(csvPath);
    const base = extension ? csvPath.slice(0, -extension.length) : csvPath;
    return { md: `${base}-checks.md`, json: `${base}-checks.json`, review: `${base}-review.csv` };
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPECTED_HEADER = parseCsv(csvHeaderLine())[0];

/**
 * Checks one CSV and writes the three report files. Returns
 * `{ result, paths, markdown }`. Throws only when the CSV can't be read.
 */
export async function runChecksOnFile(csvPath, {
    titles = null,
    wiki = null,
    seed = 1,
    writeFile = fsWriteFile,
    streamRows = streamCsvRows,
} = {}) {
    const checker = createSweepChecker({ titles, wiki, seed });
    const read = await streamRows(csvPath, {
        onRow: (row, index) => checker.addRow(row, index),
        onMalformed: (fields, index) => checker.addMalformed(fields, index),
    });
    const result = checker.finish({
        header: read.header, expectedHeader: EXPECTED_HEADER,
        unterminated: read.unterminated, lastIndex: read.lastIndex,
    });

    const paths = checksPaths(csvPath);
    const markdown = renderMarkdown(result, { file: csvPath, reviewPath: paths.review });
    const review = reviewRows(result, read.header).map(row => row.map(csvCell).join(',')).join('\n') + '\n';
    await writeFile(paths.md, markdown, 'utf8');
    await writeFile(paths.json, JSON.stringify({
        file: csvPath,
        checkedAt: new Date().toISOString(),
        status: result.status,
        checks: result.checks,
        metrics: result.metrics,
        suspectCounts: Object.fromEntries(result.suspects.map(s => [s.check, s.count])),
    }, null, 2) + '\n', 'utf8');
    await writeFile(paths.review, review, 'utf8');
    return { result, paths, markdown };
}

// The few lines worth printing to a terminal or a job log.
export function summaryLines(result, paths) {
    const lines = [`checks: ${result.status.toUpperCase()}`];
    for (const check of result.checks) {
        if (check.level === LEVELS.FAIL || check.level === LEVELS.WARN) {
            lines.push(`  ${check.level.toUpperCase()}  ${check.title}: ${check.summary}`);
        }
    }
    lines.push(`  report: ${paths.md} · rows to read: ${paths.review}`);
    return lines;
}

export async function main(argv = process.argv, {
    stdout = process.stdout,
    stderr = process.stderr,
    readTitlesFile = path => fsReadFile(path, 'utf8'),
    runChecks = runChecksOnFile,
} = {}) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv.slice(2),
            options: {
                'titles-file': { type: 'string' },
                wiki: { type: 'string' },
                seed: { type: 'string', default: '1' },
                help: { type: 'boolean', short: 'h', default: false },
            },
            allowPositionals: true,
            strict: true,
        });
    } catch (error) {
        stderr.write(`checks: ${error.message}\n${HELP_TEXT}`);
        return 2;
    }
    if (parsed.values.help) { stdout.write(HELP_TEXT); return 0; }
    if (parsed.positionals.length !== 1) { stderr.write(HELP_TEXT); return 2; }
    const seed = Number(parsed.values.seed);
    if (!Number.isInteger(seed)) { stderr.write('checks: --seed must be an integer\n'); return 2; }

    let titles = null;
    if (parsed.values['titles-file']) {
        try {
            titles = parseTitles(await readTitlesFile(parsed.values['titles-file']));
        } catch (error) {
            stderr.write(`checks: could not read --titles-file: ${error.message}\n`);
            return 2;
        }
    }

    let outcome;
    try {
        outcome = await runChecks(parsed.positionals[0], { titles, wiki: parsed.values.wiki ?? null, seed });
    } catch (error) {
        stderr.write(`checks: ${error.message}\n`);
        return 2;
    }
    stdout.write(outcome.markdown);
    stderr.write(summaryLines(outcome.result, outcome.paths).join('\n') + '\n');
    return outcome.result.status === LEVELS.FAIL ? 1 : 0;
}

// Same rules as service/run-sweep.js's parseTitlesFile(); repeated rather than
// imported so this CLI doesn't load the whole sweep (and its database
// drivers) to read a list of titles.
function parseTitles(text) {
    return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    process.exitCode = await main();
}
