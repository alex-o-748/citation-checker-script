#!/usr/bin/env node
// Load-test runner for the Internet-Archive-only source-fetch path.
//
// Answers one question: as concurrency ramps up, where does fetching sources
// via Wayback break? It never contacts a publisher — every source fetch goes
// straight to a Wayback snapshot (fetchSourceContent's `archiveFirst` option,
// core/worker.js) — so it stays inside the clearance we already have from the
// Internet Archive and clear of the still-unresolved WMCS egress question
// tf-source-fetcher's README describes for publisher URLs.
//
// It logs one NDJSON record per outbound HTTP request (Wayback availability
// lookup + snapshot fetch), which is the artifact worth sending back to IA
// and WMF — see service/analyze-ia-load-test.js.
//
// Article fetch + citation/claim extraction (stages 1-2 of the batch
// pipeline) are reused as-is from service/pipeline.js's runBatch(), with a
// no-op fetchSource — this script owns stage 3 (source fetch) itself, since
// that's the part under test: ramp control, per-request telemetry, resume.
//
// Usage:
//   # once, wherever Wiki Replicas is reachable (a Toolforge bastion):
//   node service/select-articles.js --criterion failed-verification --max 300 > candidates.json
//
//   # run a local fetch sidecar (see alex-o-748/tf-source-fetcher) with its
//   # own cache and per-host politeness effectively disabled — this runner
//   # owns pacing for the load test, not the sidecar:
//   DISABLE_CACHE=1 HOST_MIN_INTERVAL_MS=1 HOST_MAX_QUEUE_WAIT_MS=60000 HOST_BACKOFF_MS=1 \
//     node server.js &
//
//   node service/ia-load-test.js --candidates candidates.json \
//     --sidecar http://127.0.0.1:8080 --out run.ndjson --content-out content.ndjson
//
// Resume an interrupted run with the same --out file:
//   node service/ia-load-test.js --candidates candidates.json --out run.ndjson --content-out content.ndjson --resume

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { fetchArticleHtml } from '../core/wikipedia.js';
import { fetchSourceContent } from '../core/worker.js';
import { runBatch, sourceCacheKey } from './pipeline.js';

// Ramp table: each step attempts up to `requests` not-yet-attempted unique
// sources at `concurrency` in flight. Deliberately fixed steps rather than an
// adaptive controller — a clean per-step reading is the point; an
// auto-tuning controller smears the boundary you're trying to find.
export const DEFAULT_STEPS = [
    { requests: 50, concurrency: 1 },
    { requests: 500, concurrency: 2 },
    { requests: 2000, concurrency: 4 },
    { requests: 7500, concurrency: 8 },
];

function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            candidates:       { type: 'string' },
            sidecar:          { type: 'string', default: 'http://127.0.0.1:8080' },
            out:              { type: 'string', default: 'ia-load-test.ndjson' },
            'content-out':    { type: 'string' },
            steps:            { type: 'string' },
            resume:           { type: 'boolean', default: false },
            'warn-error-rate':  { type: 'string', default: '0.02' },
            'abort-error-rate': { type: 'string', default: '0.10' },
            window:           { type: 'string', default: '50' },
            help:             { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        candidates: values.candidates,
        sidecar: values.sidecar,
        out: values.out,
        contentOut: values['content-out'],
        steps: values.steps ? JSON.parse(values.steps) : DEFAULT_STEPS,
        resume: values.resume,
        warnErrorRate: Number(values['warn-error-rate']),
        abortErrorRate: Number(values['abort-error-rate']),
        window: Number(values.window),
    };
}

const HELP_TEXT = `usage: node service/ia-load-test.js --candidates <file> [options]

Ramps concurrency against Wayback/Internet-Archive-only source fetching and
logs one NDJSON record per outbound HTTP request. Never contacts a publisher.

Options:
  --candidates <file>     JSON array of { pageId, title, revisionId } (from
                           service/select-articles.js). Required.
  --sidecar <url>         Base URL of a running tf-source-fetcher instance
                           (default: http://127.0.0.1:8080)
  --out <file>            NDJSON request log (default: ia-load-test.ndjson).
                           Also the resume marker: task completions are read
                           back from this file when --resume is passed.
  --content-out <file>    If set, appends { key, url, pageNum, content } for
                           every successfully fetched source, for later corpus
                           assembly (see service/build-ia-corpus.js).
  --steps <json>          Override the ramp table, e.g.
                           '[{"requests":100,"concurrency":2}]'
                           (default: ${JSON.stringify(DEFAULT_STEPS)})
  --resume                Skip sources already attempted per --out.
  --warn-error-rate <n>   Rolling error rate that triggers a warning but does
                           not stop the run (default: 0.02).
  --abort-error-rate <n>  Rolling error rate that aborts the whole run
                           (default: 0.10).
  --window <n>            Number of recent requests the rolling error rate is
                           computed over (default: 50).
  --help, -h              Show this help and exit.
`;

const parseHtml = html => new JSDOM(html).window.document;

// Extraction-only pass over the candidate articles: reuses runBatch's article
// fetch + citation/claim extraction, with a no-op fetchSource so it never
// resolves a source itself — this script controls that phase separately.
// Returns one task per *unique* (url, pageNum), each carrying every citation
// across the candidate pool that cites it (a source is often shared across
// articles, and de-duping here is a request we don't have to spend on IA).
// `onProgress(articlesDone, articlesTotal, uniqueSourcesSoFar)`, when
// supplied, fires after each article — this loop is sequential (one real
// Wikipedia REST fetch per candidate, not parallelized), so on a few hundred
// candidates it can run for minutes with nothing else to show for it. Without
// this a caller watching the log sees one line and then silence, which is
// indistinguishable from a hang.
export async function extractTasks(candidates, { fetchArticle = fetchArticleHtml, onProgress } = {}) {
    const tasks = [];
    const byKey = new Map();
    const noopFetchSource = async () => ({ content: null, status: null, error: null });

    let articlesDone = 0;
    for await (const result of runBatch(candidates, {
        parseHtml,
        fetchArticle,
        fetchSource: noopFetchSource,
        // Throwaway cache: the no-op result must never leak into the real
        // fetch phase, which keys its own dedup off this task list.
        sourceCache: new Map(),
    })) {
        articlesDone++;
        if (result.outcome !== 'ok') {
            onProgress?.(articlesDone, candidates.length, tasks.length);
            continue;
        }
        for (const c of result.citations) {
            if (!c.url) continue;
            const key = sourceCacheKey(c.url, c.pageNum);
            let task = byKey.get(key);
            if (!task) {
                task = { key, url: c.url, pageNum: c.pageNum, citations: [] };
                byKey.set(key, task);
                tasks.push(task);
            }
            task.citations.push({
                pageId: result.pageId,
                title: result.title,
                revisionId: result.revisionId,
                citationNumber: c.citationNumber,
                claimText: c.claimText,
            });
        }
        onProgress?.(articlesDone, candidates.length, tasks.length);
    }
    return tasks;
}

// Reads the request log back and returns the set of source keys that already
// have a completed attempt (success or failure) — resume skips these rather
// than re-spending a request re-confirming a result we already have.
export function loadCompletedKeys(logPath) {
    const done = new Set();
    if (!fs.existsSync(logPath)) return done;
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue; // tolerate a truncated last line from a killed run
        }
        if (rec.event === 'task-done') done.add(rec.key);
    }
    return done;
}

export async function runPool(items, concurrency, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            await worker(items[idx]);
        }
    });
    await Promise.all(runners);
}

// Rolling error rate over the last `windowSize` request-level (not
// task-level) records — a step at concurrency 8 fetches 2 requests per task
// (availability + snapshot), so this reacts within a handful of tasks rather
// than waiting for a whole step to finish.
export function makeBreaker(windowSize) {
    const recent = [];
    return {
        record(ok) {
            recent.push(ok);
            if (recent.length > windowSize) recent.shift();
        },
        errorRate() {
            const minSample = Math.min(10, windowSize);
            if (recent.length < minSample) return 0;
            return recent.filter(ok => !ok).length / recent.length;
        },
    };
}

// Prefixes a status line with an ISO timestamp — for a run spanning minutes
// to hours (article extraction alone can take a while; see extractTasks's
// onProgress), a plain transcript can't answer "how long did that step take"
// after the fact. A leading blank line (used for visual spacing between
// steps) is kept before the timestamp rather than after it, so spacing still
// reads naturally.
export function timestampedLog(msg) {
    const leading = msg.match(/^\n+/)?.[0] ?? '';
    const rest = msg.slice(leading.length);
    process.stderr.write(`${leading}[${new Date().toISOString()}] ${rest}`);
}

function makeLogger(logPath) {
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    return {
        write(record) {
            stream.write(JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
        },
        close() {
            return new Promise(resolve => stream.end(resolve));
        },
    };
}

export async function runLoadTest({
    tasks,
    sidecar,
    steps,
    out,
    contentOut,
    resume,
    warnErrorRate,
    abortErrorRate,
    window,
    log = timestampedLog,
}) {
    const completedKeys = resume ? loadCompletedKeys(out) : new Set();
    if (completedKeys.size) {
        log(`resuming: ${completedKeys.size} source(s) already attempted, skipping\n`);
    }
    const pending = tasks.filter(t => !completedKeys.has(t.key));

    const logger = makeLogger(out);
    const contentLogger = contentOut ? makeLogger(contentOut) : null;
    const breaker = makeBreaker(window);

    let cursor = 0;
    let aborted = false;
    let requestCount = 0;
    const stepSummaries = [];

    for (const step of steps) {
        if (aborted) break;
        const label = `${step.requests}@c${step.concurrency}`;
        const stepItems = pending.slice(cursor, cursor + step.requests);
        if (stepItems.length === 0) {
            log(`step ${label}: no pending sources left, stopping\n`);
            break;
        }
        cursor += stepItems.length;
        log(`\n=== step ${label}: ${stepItems.length} source(s) ===\n`);

        let stepOk = 0;
        let stepErr = 0;
        const stepStartedAt = Date.now();

        await runPool(stepItems, step.concurrency, async task => {
            if (aborted) return;

            const onRequest = (rec) => {
                requestCount++;
                logger.write({ event: 'request', step: label, concurrency: step.concurrency, key: task.key, ...rec });
                breaker.record(rec.ok);
                const rate = breaker.errorRate();
                if (rate >= abortErrorRate) {
                    if (!aborted) {
                        aborted = true;
                        log(`\nABORT: rolling error rate ${(rate * 100).toFixed(1)}% >= ${(abortErrorRate * 100).toFixed(1)}% threshold — stopping.\n`);
                    }
                } else if (rate >= warnErrorRate) {
                    log(`warn: rolling error rate ${(rate * 100).toFixed(1)}%\n`);
                }
            };

            const result = await fetchSourceContent(task.url, task.pageNum, {
                workerBase: sidecar,
                archiveFirst: true,
                onRequest,
            });

            const ok = !!result.content;
            if (ok) stepOk++; else stepErr++;
            logger.write({ event: 'task-done', key: task.key, ok, error: result.error, status: result.status });

            if (ok && contentLogger) {
                contentLogger.write({ key: task.key, url: task.url, pageNum: task.pageNum, content: result.content });
            }
        });

        const stepMs = Date.now() - stepStartedAt;
        log(`step ${label} done: ${stepOk} ok, ${stepErr} failed in ${(stepMs / 1000).toFixed(1)}s\n`);
        stepSummaries.push({ label, requests: stepItems.length, concurrency: step.concurrency, ok: stepOk, failed: stepErr, ms: stepMs });
        if (aborted) break;
    }

    await logger.close();
    if (contentLogger) await contentLogger.close();

    return { aborted, requestCount, stepSummaries };
}

async function main(argv) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    if (!opts.candidates) {
        timestampedLog('error: --candidates is required\n');
        return 2;
    }

    let candidates;
    try {
        candidates = JSON.parse(fs.readFileSync(opts.candidates, 'utf8'));
    } catch (error) {
        timestampedLog(`error: could not read --candidates ${opts.candidates}: ${error.message}\n`);
        return 1;
    }

    timestampedLog('extracting citations from candidate articles...\n');
    // core/urls.js logs one console.log per citation it examines — fine for a
    // human watching one article in devtools, unusable noise across hundreds.
    const realLog = console.log;
    console.log = () => {};
    let tasks;
    try {
        tasks = await extractTasks(candidates, {
            // Every 10 articles (and always the last one) rather than every
            // single one — enough to prove it's alive without flooding the
            // log across a few hundred candidates.
            onProgress: (done, total, uniqueSoFar) => {
                if (done % 10 === 0 || done === total) {
                    timestampedLog(`  ${done}/${total} article(s) processed, ${uniqueSoFar} unique source(s) found so far\n`);
                }
            },
        });
    } finally {
        console.log = realLog;
    }
    timestampedLog(`${tasks.length} unique source(s) to fetch across ${candidates.length} candidate article(s)\n`);

    const { aborted, requestCount, stepSummaries } = await runLoadTest({
        tasks,
        sidecar: opts.sidecar,
        steps: opts.steps,
        out: opts.out,
        contentOut: opts.contentOut,
        resume: opts.resume,
        warnErrorRate: opts.warnErrorRate,
        abortErrorRate: opts.abortErrorRate,
        window: opts.window,
    });

    timestampedLog(`\ntotal requests logged: ${requestCount}\n`);
    timestampedLog(`log: ${opts.out}\n`);
    if (opts.contentOut) timestampedLog(`content: ${opts.contentOut}\n`);
    for (const s of stepSummaries) {
        timestampedLog(`  ${s.label}: ${s.ok} ok, ${s.failed} failed, ${(s.ms / 1000).toFixed(1)}s\n`);
    }

    return aborted ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
