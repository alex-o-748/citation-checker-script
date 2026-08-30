#!/usr/bin/env node
// Throwaway diagnostic: how much concurrency can tf-llm-router's /liftwing
// route sustain? Not part of the batch pipeline (service/run-sweep.js /
// service/run-replay.js) — a one-off probe to answer the question left open
// on 2026-08-24: a single sequential caller survived 100 back-to-back calls
// with zero delay (`run-replay.js --live-llm-router --delay-ms 0`), which
// ruled out a hard per-request floor, but says nothing about concurrent
// load — and concurrent load is what any real sweep speedup depends on.
// Delete this file once the answer is known and acted on; it isn't meant
// to become a permanent runner.
//
// Fires `--calls` requests at each concurrency level in `--levels`, using
// real claim/source pairs from benchmark/dataset.json so the model does
// real work (not near-instant SOURCE UNAVAILABLE short-circuits). Reports
// wall-clock time, throughput, and error counts (429s broken out
// separately) per level, and stops at the first level that produces any
// failure — a higher level is unlikely to do better once one has failed,
// and there's no reason to keep loading a shared upstream past that point.
//
// Usage:
//   node scripts/probe-concurrency.js
//   node scripts/probe-concurrency.js --levels 1,2,4,8,16 --calls 20

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { verifyCitation, makeModelCaller } from '../service/verifier.js';
import { PROVIDER_MODELS } from '../service/provider-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET_PATH = join(__dirname, '..', 'benchmark', 'dataset.json');

// Same endpoint as service/run-sweep.js's / service/run-replay.js's
// --live-llm-router — see the comment on TOOLFORGE_LLM_ROUTER_BASE in
// either file for why this differs from core/providers.js's default
// (the Cloudflare Worker's shared approved-bot-JWT path).
const TOOLFORGE_LLM_ROUTER_BASE = 'https://llm-router.toolforge.org';

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            dataset: { type: 'string', default: DEFAULT_DATASET_PATH },
            levels:  { type: 'string', default: '1,2,4,8,16' },
            calls:   { type: 'string', default: '20' },
            help:    { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });
    return {
        help: values.help,
        dataset: values.dataset,
        levels: values.levels.split(',').map(Number),
        callsPerLevel: Number(values.calls),
    };
}

export const HELP_TEXT = `usage: node scripts/probe-concurrency.js [options]

Throwaway diagnostic — fires N concurrent calls at Lift Wing via
tf-llm-router at each concurrency level, using real dataset claim/source
pairs, and reports wall-clock time, throughput, and error counts per level.
Stops at the first level that produces any failure. Not part of the batch
pipeline; delete once you have your answer.

Options:
  --dataset <path>  Dataset JSON file (default: benchmark/dataset.json)
  --levels <list>   Comma-separated concurrency levels to try (default: 1,2,4,8,16)
  --calls <n>       Calls to fire at each level (default: 20)
  --help, -h        Show this help and exit.
`;

// Minimal reshape of a dataset row into the shape verifyCitation() expects —
// deliberately not service/run-replay.js's toCitation(), which also carries
// wiki/page-id metadata this probe has no use for.
export function toCallable(row) {
    return {
        claimText: row.claim_text,
        source: {
            content: `Source URL: ${row.source_url}\n\nSource Content:\n${row.source_text}`,
            status: 200,
            error: null,
        },
    };
}

// N in flight at once, refilling as each finishes — same shape as
// benchmark/run_benchmark.js's runPool(), reimplemented here so this
// throwaway script has no dependency on that ESM-only package.
export async function runPool(items, concurrency, worker) {
    let idx = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (idx < items.length) {
            const i = idx++;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

// Matches core/providers.js's "<label> API request failed (<status>): ..."
// shape (same one core/retry.js's RETRYABLE_STATUS parses).
export function classifyError(error) {
    const status = Number((error?.message || '').match(/\((\d{3})\)/)?.[1]);
    if (status === 429) return '429';
    if (status) return `http_${status}`;
    return 'other';
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        stdout.write(HELP_TEXT);
        return 0;
    }

    const dataset = JSON.parse(await readFile(opts.dataset, 'utf8'));
    const usable = dataset.rows.filter(r => r.source_text);
    if (usable.length === 0) {
        stderr.write('probe: no dataset rows have source_text — nothing to call the model with\n');
        return 1;
    }
    stderr.write(`probe: ${usable.length}/${dataset.rows.length} dataset rows have source_text; cycling through them as needed\n`);
    stderr.write(`probe: routing liftwing via ${TOOLFORGE_LLM_ROUTER_BASE}\n\n`);

    const callModel = makeModelCaller({
        provider: 'liftwing',
        model: PROVIDER_MODELS.liftwing,
        workerBase: TOOLFORGE_LLM_ROUTER_BASE,
    });

    const results = [];

    for (const concurrency of opts.levels) {
        const calls = Array.from({ length: opts.callsPerLevel }, (_, i) => toCallable(usable[i % usable.length]));
        let ok = 0;
        const errors = {};

        const startedAt = Date.now();
        await runPool(calls, concurrency, async citation => {
            try {
                const verification = await verifyCitation(citation.claimText, citation.source, {
                    callModel,
                    // Small, fast retry budget: this probe wants to see raw
                    // failures quickly, not have withRetry's up-to-30s
                    // backoff mask them within a level's wall-clock time.
                    retry: { maxRetries: 2, minBackoffMs: 300, maxBackoffMs: 1000 },
                });
                if (verification.usage) ok++;
            } catch (error) {
                const kind = classifyError(error);
                errors[kind] = (errors[kind] || 0) + 1;
            }
        });
        const elapsedMs = Date.now() - startedAt;

        const row = {
            concurrency,
            calls: opts.callsPerLevel,
            ok,
            failed: opts.callsPerLevel - ok,
            errors,
            elapsedSec: (elapsedMs / 1000).toFixed(1),
            callsPerSec: (ok / (elapsedMs / 1000)).toFixed(2),
        };
        results.push(row);
        stdout.write(
            `concurrency=${concurrency}  ok=${row.ok}/${row.calls}  ` +
            `failed=${row.failed}${row.failed ? ' ' + JSON.stringify(row.errors) : ''}  ` +
            `elapsed=${row.elapsedSec}s  throughput=${row.callsPerSec}/s\n`
        );

        if (row.failed > 0) {
            stdout.write(`\nprobe: stopping — concurrency=${concurrency} produced failures, higher levels are unlikely to do better.\n`);
            break;
        }
    }

    stdout.write('\nprobe: summary\n');
    for (const r of results) {
        stdout.write(`  concurrency=${r.concurrency}: ${r.ok}/${r.calls} ok, ${r.callsPerSec}/s\n`);
    }

    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
