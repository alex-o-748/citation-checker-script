#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeCleanCsv, cleanCsvPath } from './csv-report.js';

export const HELP_TEXT = `usage: node service/clean-csv.js <input.csv> [--out <path>]

Creates a clean copy of a batch findings CSV. It removes checks whose source
was truncated and, when a collective group check exists, removes that group's
individual citation checks. The input file is never modified.
`;

export async function main(argv = process.argv, io = {}) {
    const { stdout = process.stdout, stderr = process.stderr, writeCleanCsvFn = writeCleanCsv } = io;
    let parsed;
    try {
        parsed = parseArgs({
            args: argv.slice(2),
            options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
            allowPositionals: true,
            strict: true,
        });
    } catch (error) {
        stderr.write(`clean-csv: ${error.message}\n${HELP_TEXT}`);
        return 2;
    }
    if (parsed.values.help) { stdout.write(HELP_TEXT); return 0; }
    if (parsed.positionals.length !== 1) { stderr.write(HELP_TEXT); return 2; }
    const input = parsed.positionals[0];
    const output = parsed.values.out || cleanCsvPath(input);
    try {
        await writeCleanCsvFn(input, output);
        stdout.write(`clean-csv: wrote ${output}\n`);
        return 0;
    } catch (error) {
        stderr.write(`clean-csv: ${error.message}\n`);
        return 1;
    }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
    process.exitCode = await main();
}
