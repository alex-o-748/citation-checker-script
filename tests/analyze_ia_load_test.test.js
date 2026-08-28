import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRequests, summarize, analyzeLog } from '../service/analyze-ia-load-test.js';

function req(overrides) {
    return {
        event: 'request',
        step: '1@c1',
        concurrency: 1,
        key: 'k1',
        kind: 'source-fetch',
        url: 'https://web.archive.org/web/x/https://example.com',
        status: 200,
        ok: true,
        error: null,
        latencyMs: 100,
        bytes: 500,
        ts: '2026-08-28T00:00:00.000Z',
        ...overrides,
    };
}

test('loadRequests filters to request events and tolerates malformed lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-analyze-'));
    try {
        const logPath = path.join(dir, 'run.ndjson');
        fs.writeFileSync(logPath, [
            JSON.stringify(req({})),
            JSON.stringify({ event: 'task-done', key: 'k1', ok: true }),
            'not json',
            '',
        ].join('\n'));

        const requests = loadRequests(logPath);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].event, 'request');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('summarize computes error rate, status breakdown, and host breakdown', () => {
    const requests = [
        req({ ts: '2026-08-28T00:00:00.000Z', ok: true, status: 200, kind: 'wayback-availability' }),
        req({ ts: '2026-08-28T00:00:01.000Z', ok: true, status: 200, kind: 'source-fetch' }),
        req({ ts: '2026-08-28T00:00:02.000Z', ok: false, status: 429, kind: 'source-fetch' }),
        req({ ts: '2026-08-28T00:00:03.000Z', ok: false, status: null, kind: 'source-fetch' }),
    ];

    const s = summarize(requests);
    assert.equal(s.requests, 4);
    assert.equal(s.ok, 2);
    assert.equal(s.failed, 2);
    assert.equal(s.errorRate, 0.5);
    assert.equal(s.statusCounts['200'], 2);
    assert.equal(s.statusCounts['429'], 1);
    assert.equal(s.statusCounts['network_error'], 1);
    assert.equal(s.hostCounts['archive.org'], 1);
    assert.equal(s.hostCounts['web.archive.org'], 3);
    assert.ok(s.requestsPerSec > 0);
});

test('summarize on an empty slice returns zeroed fields without throwing', () => {
    const s = summarize([]);
    assert.equal(s.requests, 0);
    assert.equal(s.errorRate, 0);
    assert.equal(s.requestsPerSec, 0);
});

test('analyzeLog groups by step and reports concurrency per step', () => {
    const requests = [
        req({ step: '10@c1', concurrency: 1, ts: '2026-08-28T00:00:00.000Z' }),
        req({ step: '10@c1', concurrency: 1, ts: '2026-08-28T00:00:01.000Z' }),
        req({ step: '20@c2', concurrency: 2, ts: '2026-08-28T00:00:02.000Z', ok: false, status: 500 }),
    ];

    const { overall, steps } = analyzeLog(requests);
    assert.equal(overall.requests, 3);

    assert.equal(steps.length, 2);
    const step1 = steps.find(s => s.step === '10@c1');
    const step2 = steps.find(s => s.step === '20@c2');
    assert.equal(step1.requests, 2);
    assert.equal(step1.concurrency, 1);
    assert.equal(step2.requests, 1);
    assert.equal(step2.errorRate, 1);
});
