#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { extname } from 'node:path';
import { writeCleanCsv, cleanCsvPath } from './csv-report.js';
import { deliveryPredicate, DELIVERY_TIER_NAMES, DEFAULT_EXCLUDED_HOSTS } from './delivery-filter.js';

export function deliverCsvPath(path, tier) {
    const extension = extname(path) || '.csv';
    const base = extname(path) ? path.slice(0, -extension.length) : path;
    return `${base}-deliver-${tier}${extension}`;
}

export const HELP_TEXT = `usage: node service/clean-csv.js <input.csv> [--out <path>]

Creates a clean copy of a batch findings CSV. On a truncated source it keeps
only SUPPORTED and NOT SUPPORTED / contradiction checks, and once a group has a collective
check it removes that group's individual citation checks — even when the
collective check was itself removed. In a group where one source was SOURCE
UNAVAILABLE, it drops the group's PARTIALLY SUPPORTED and NOT SUPPORTED /
omission checks, collective or individual. The input file is never modified.

Options:
  --out <path>            Output path (default: <input>-clean.csv, or
                          <input>-deliver-<tier>.csv with --deliver)
  --deliver <tier>        After cleaning, keep only the flags delivered at this
                          tier (service/delivery-filter.js), dropping problem
                          hosts and table-cell claims. Tiers, widest first:
                          ${DELIVERY_TIER_NAMES.join(', ')}.
                          scripts/review-sweep.js reports the count each leaves.
  --exclude-hosts <list>  Comma-separated hosts to treat as problem hosts with
                          --deliver, replacing the default list.
`;

export async function main(argv = process.argv, io = {}) {
    const { stdout = process.stdout, stderr = process.stderr, writeCleanCsvFn = writeCleanCsv } = io;
    let parsed;
    try {
        parsed = parseArgs({
            args: argv.slice(2),
            options: {
                out: { type: 'string' }, deliver: { type: 'string' }, 'exclude-hosts': { type: 'string' },
                help: { type: 'boolean', short: 'h' },
            },
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
    const tier = parsed.values.deliver;
    let filter = null;
    if (tier) {
        const excludedHosts = parsed.values['exclude-hosts']
            ? parsed.values['exclude-hosts'].split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_EXCLUDED_HOSTS;
        try {
            filter = deliveryPredicate(tier, { excludedHosts });
        } catch (error) {
            stderr.write(`clean-csv: ${error.message}\n`);
            return 2;
        }
    }
    const output = parsed.values.out || (tier ? deliverCsvPath(input, tier) : cleanCsvPath(input));
    try {
        await (filter ? writeCleanCsvFn(input, output, { filter }) : writeCleanCsvFn(input, output));
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
