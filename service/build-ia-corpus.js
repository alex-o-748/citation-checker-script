#!/usr/bin/env node
// Joins an ia-load-test.js run's article extraction with its fetched content
// into a benchmark/run_benchmark.js-shaped dataset — one row per (claim,
// source) pair, matching benchmark/dataset.json's row semantics.
//
// Re-runs extraction (cheap and deterministic — no network beyond the
// article-HTML fetches already made during the load test) rather than
// threading task objects through the load-test run itself, so this also
// works after a --resume'd, multi-session run: --content-out is
// append-only and survives across sessions, unlike in-memory task state.
//
// Usage:
//   node service/build-ia-corpus.js --candidates candidates.json \
//     --content content.ndjson --out dataset_ia_load_test.json
//
// ground_truth is intentionally absent — this corpus has no human labels.
// It's useful for run_benchmark.js's verdict/quote/cost pipeline, not for
// analyze_results.js's accuracy scoring.

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { extractTasks } from './ia-load-test.js';
import { extractSourceText } from '../core/prompts.js';

function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            candidates: { type: 'string' },
            content:    { type: 'string' },
            out:        { type: 'string', default: 'dataset_ia_load_test.json' },
            help:       { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });
    return values;
}

const HELP_TEXT = `usage: node service/build-ia-corpus.js --candidates <file> --content <file> [options]

Options:
  --candidates <file>  Same candidates JSON passed to ia-load-test.js.
  --content <file>     The --content-out NDJSON from ia-load-test.js.
  --out <file>         Output dataset path (default: dataset_ia_load_test.json).
  --help, -h           Show this help and exit.
`;

export function loadContentByKey(contentPath) {
    const byKey = new Map();
    for (const line of fs.readFileSync(contentPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        byKey.set(rec.key, rec);
    }
    return byKey;
}

export function buildRows(tasks, contentByKey) {
    const rows = [];
    let n = 0;
    for (const task of tasks) {
        const rec = contentByKey.get(task.key);
        if (!rec) continue; // never fetched, or fetch failed
        // rec.content carries ia-load-test.js's "Source URL: ...\n\nSource
        // Content:\n..." wrapper (core/worker.js's fetchViaProxy format);
        // dataset.json's source_text convention is the unwrapped body.
        const sourceText = extractSourceText(rec.content);
        for (const c of task.citations) {
            n++;
            rows.push({
                id: `ia_${n}`,
                page_id: c.pageId,
                page_title: c.title,
                revision_id: c.revisionId,
                citation_number: c.citationNumber,
                claim_text: c.claimText,
                source_url: task.url,
                source_text: sourceText,
                dataset_version: 'ia-load-test',
                extraction_status: 'complete',
                needs_manual_review: false,
            });
        }
    }
    return rows;
}

async function main(argv) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    if (!opts.candidates || !opts.content) {
        process.stderr.write('error: --candidates and --content are both required\n');
        return 2;
    }

    const candidates = JSON.parse(fs.readFileSync(opts.candidates, 'utf8'));

    process.stderr.write('re-extracting citations from candidate articles...\n');
    const realLog = console.log;
    console.log = () => {};
    let tasks;
    try {
        tasks = await extractTasks(candidates);
    } finally {
        console.log = realLog;
    }

    const contentByKey = loadContentByKey(opts.content);
    const rows = buildRows(tasks, contentByKey);

    fs.writeFileSync(opts.out, JSON.stringify(rows, null, 2));
    process.stderr.write(`wrote ${rows.length} row(s) (from ${contentByKey.size} fetched source(s)) to ${opts.out}\n`);
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
