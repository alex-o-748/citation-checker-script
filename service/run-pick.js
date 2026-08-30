#!/usr/bin/env node
// Runnable entry point: connects to Wiki Replicas, runs the candidate query,
// prints the selected articles as JSON.
//
// This is the first piece of the batch pipeline meant to actually be executed
// (as opposed to imported and tested), so it stays deliberately thin — wiring,
// not logic. selection.js and replicas.js own the logic and are unit-tested;
// this script's only job is to connect them and handle process concerns
// (argv, exit code, closing the connection).
//
// Usage (on a Toolforge bastion, inside the tool account):
//   node service/run-pick.js
//   node service/run-pick.js --criterion citation-needed --max 20
//   node service/run-pick.js --wiki enwiki --max 500 > candidates.json

import { parseArgs } from 'node:util';
import { openReplicaConnection, makeQueryFn } from './replicas.js';
import { selectCandidates, CRITERIA } from './article-picker.js';

function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            criterion: { type: 'string', default: 'failed-verification' },
            wiki:      { type: 'string', default: 'enwiki' },
            template:  { type: 'string' },
            max:       { type: 'string', default: '20' },
            help:      { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        criterion: values.criterion,
        wiki: values.wiki,
        template: values.template,
        max: Number(values.max),
    };
}

const HELP_TEXT = `usage: node service/run-pick.js [options]

Options:
  --criterion <name>  Selection criterion. One of: ${Object.keys(CRITERIA).join(', ')}
                       (default: failed-verification)
  --wiki <db>          Wiki database name, e.g. enwiki, frwiki, ruwiki (default: enwiki)
  --template <title>   Override the criterion's template title (underscores, no
                        namespace prefix) — CRITERIA's names are enwiki-specific,
                        so a non-English --wiki needs its own equivalent title
                        here (e.g. the ruwiki version of "citation needed"),
                        or the query matches zero pages rather than erroring.
  --max <n>            Maximum articles to select (default: 20)
  --help, -h           Show this help and exit.
`;

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
    if (opts.wiki !== 'enwiki' && !opts.template) {
        process.stderr.write(
            `WARNING: --wiki ${opts.wiki} with the default "${opts.criterion}" template ` +
            `(${CRITERIA[opts.criterion]?.template ?? opts.criterion}, an enwiki title). ` +
            `That template almost certainly does not exist on ${opts.wiki} under this name — ` +
            `the query will most likely match zero pages rather than error. Pass --template ` +
            `with the equivalent title on ${opts.wiki} to select real candidates.\n`
        );
    }

    let connection;
    try {
        connection = await openReplicaConnection({ wikiDb: opts.wiki });
    } catch (error) {
        process.stderr.write(`error: could not connect to Wiki Replicas: ${error.message}\n`);
        return 1;
    }

    try {
        const candidates = await selectCandidates(makeQueryFn(connection), {
            criterion: opts.criterion,
            template: opts.template,
            max: opts.max,
        });
        process.stdout.write(JSON.stringify(candidates, null, 2) + '\n');
        process.stderr.write(`selected ${candidates.length} article(s) via "${opts.criterion}" on ${opts.wiki}\n`);
        return 0;
    } catch (error) {
        process.stderr.write(`error: ${error.message}\n`);
        return 1;
    } finally {
        await connection.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
