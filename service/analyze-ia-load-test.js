#!/usr/bin/env node
// Turns an ia-load-test.js NDJSON request log into the throughput/error
// report worth sending to the Internet Archive and WMF: requests/sec,
// latency percentiles, and error breakdown by upstream status, per ramp step
// and overall.
//
// Usage:
//   node service/analyze-ia-load-test.js run.ndjson
//   node service/analyze-ia-load-test.js run.ndjson --json summary.json

import { parseArgs } from 'node:util';
import fs from 'node:fs';

export function loadRequests(logPath) {
    const requests = [];
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec.event === 'request') requests.push(rec);
    }
    return requests;
}

function percentile(sortedValues, p) {
    if (sortedValues.length === 0) return null;
    const idx = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
    return sortedValues[idx];
}

// One summary for an arbitrary slice of request records — reused for the
// overall total and for each per-step breakdown.
export function summarize(requests) {
    const n = requests.length;
    if (n === 0) {
        return { requests: 0, ok: 0, failed: 0, errorRate: 0, requestsPerSec: 0, latencyMs: {}, statusCounts: {}, hostCounts: {} };
    }

    const ok = requests.filter(r => r.ok).length;
    const failed = n - ok;

    const latencies = requests.map(r => r.latencyMs).filter(x => typeof x === 'number').sort((a, b) => a - b);
    const latencyMs = {
        p50: percentile(latencies, 0.50),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: latencies.length ? latencies[latencies.length - 1] : null,
    };

    const statusCounts = {};
    for (const r of requests) {
        const key = r.status === null || r.status === undefined ? 'network_error' : String(r.status);
        statusCounts[key] = (statusCounts[key] || 0) + 1;
    }

    const hostCounts = {};
    for (const r of requests) {
        const key = r.kind === 'wayback-availability' ? 'archive.org' : 'web.archive.org';
        hostCounts[key] = (hostCounts[key] || 0) + 1;
    }

    const timestamps = requests.map(r => new Date(r.ts).getTime()).filter(Number.isFinite);
    const spanMs = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    const requestsPerSec = spanMs > 0 ? n / (spanMs / 1000) : n;

    return {
        requests: n,
        ok,
        failed,
        errorRate: failed / n,
        requestsPerSec,
        latencyMs,
        statusCounts,
        hostCounts,
    };
}

export function analyzeLog(requests) {
    const overall = summarize(requests);

    const byStep = new Map();
    for (const r of requests) {
        if (!byStep.has(r.step)) byStep.set(r.step, []);
        byStep.get(r.step).push(r);
    }

    const steps = [...byStep.entries()].map(([step, reqs]) => ({
        step,
        concurrency: reqs[0]?.concurrency ?? null,
        ...summarize(reqs),
    }));

    return { overall, steps };
}

function fmtPct(x) {
    return `${(x * 100).toFixed(1)}%`;
}

function printReport(analysis) {
    const { overall, steps } = analysis;
    console.log('=== Internet Archive load test — summary ===\n');
    console.log(`total requests: ${overall.requests} (${overall.ok} ok, ${overall.failed} failed, ${fmtPct(overall.errorRate)} error rate)`);
    console.log(`throughput: ${overall.requestsPerSec.toFixed(2)} req/s (across the whole run, all steps combined)`);
    console.log(`latency: p50=${overall.latencyMs.p50}ms p95=${overall.latencyMs.p95}ms p99=${overall.latencyMs.p99}ms max=${overall.latencyMs.max}ms`);
    console.log(`by host: ${Object.entries(overall.hostCounts).map(([h, c]) => `${h}=${c}`).join(', ')}`);
    console.log(`by status: ${Object.entries(overall.statusCounts).sort().map(([s, c]) => `${s}=${c}`).join(', ')}`);

    console.log('\n=== per step ===\n');
    for (const s of steps) {
        console.log(`${s.step}  (concurrency ${s.concurrency})`);
        console.log(`  requests: ${s.requests}  ok: ${s.ok}  failed: ${s.failed}  error rate: ${fmtPct(s.errorRate)}`);
        console.log(`  throughput: ${s.requestsPerSec.toFixed(2)} req/s`);
        console.log(`  latency: p50=${s.latencyMs.p50}ms p95=${s.latencyMs.p95}ms p99=${s.latencyMs.p99}ms`);
        console.log(`  status: ${Object.entries(s.statusCounts).sort().map(([st, c]) => `${st}=${c}`).join(', ')}`);
        console.log('');
    }
}

async function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv.slice(2),
        options: {
            json: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
        allowPositionals: true,
        strict: true,
    });

    if (values.help || positionals.length === 0) {
        process.stdout.write('usage: node service/analyze-ia-load-test.js <log.ndjson> [--json <summary-out.json>]\n');
        return values.help ? 0 : 2;
    }

    const requests = loadRequests(positionals[0]);
    if (requests.length === 0) {
        process.stderr.write(`no request records found in ${positionals[0]}\n`);
        return 1;
    }

    const analysis = analyzeLog(requests);
    printReport(analysis);

    if (values.json) {
        fs.writeFileSync(values.json, JSON.stringify(analysis, null, 2));
        process.stderr.write(`\nwrote ${values.json}\n`);
    }

    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
