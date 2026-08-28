import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    extractTasks,
    loadCompletedKeys,
    runPool,
    makeBreaker,
    runLoadTest,
    DEFAULT_STEPS,
} from '../service/ia-load-test.js';

const parseHtml = html => new JSDOM(html).window.document;

function article(prose, footnotes) {
    const body = prose.replace(/@@(\S+?)@@/g, (_, id) =>
        `<sup id="cite_ref-${id}" class="reference"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`
    );
    const list = Object.entries(footnotes)
        .map(([id, html]) => `<li id="cite_note-${id}">${html}</li>`)
        .join('');
    return `<!DOCTYPE html><body>${body}<ol class="references">${list}</ol></body>`;
}
const link = url => `<a rel="nofollow" class="external text" href="${url}">source</a>`;

const articleA = article(
    '<p>The bridge opened in 1998.@@1@@ It cost 40 million.@@2@@</p>',
    { 1: link('https://example.com/a'), 2: link('https://example.com/b') }
);
// Cites the same source as articleA's [1] — should dedup to one task.
const articleB = article(
    '<p>The same bridge opened in 1998.@@1@@</p>',
    { 1: link('https://example.com/a') }
);

const candidates = [
    { pageId: 1, title: 'Article A', revisionId: 10 },
    { pageId: 2, title: 'Article B', revisionId: 20 },
];

// processArticle() (service/pipeline.js) calls fetchArticle({ title,
// revisionId }) — not the whole candidate — so this keys off title.
function fetchArticleFor({ title }) {
    if (title === 'Article A') return { html: articleA, status: 200, error: null };
    if (title === 'Article B') return { html: articleB, status: 200, error: null };
    return { html: null, status: 404, error: 'not found' };
}

async function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-load-test-'));
    try {
        return await fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('extractTasks dedups a source shared across articles into one task', async () => {
    const tasks = await extractTasks(candidates, {
        fetchArticle: async (c) => fetchArticleFor(c),
    });

    assert.equal(tasks.length, 2, 'two unique sources: example.com/a and example.com/b');
    const a = tasks.find(t => t.url === 'https://example.com/a');
    assert.ok(a, 'source a present');
    assert.equal(a.citations.length, 2, 'cited by both articles');
    assert.equal(a.citations[0].pageId, 1);
    assert.equal(a.citations[1].pageId, 2);

    const b = tasks.find(t => t.url === 'https://example.com/b');
    assert.equal(b.citations.length, 1);
});

test('extractTasks skips articles that fail to fetch without throwing', async () => {
    const tasks = await extractTasks([{ pageId: 99, title: 'Missing', revisionId: 1 }], {
        fetchArticle: async () => ({ html: null, status: 404, error: 'gone' }),
    });
    assert.deepEqual(tasks, []);
});

test('loadCompletedKeys reads task-done records and ignores request records', async () => {
    await withTempDir(dir => {
        const logPath = path.join(dir, 'run.ndjson');
        fs.writeFileSync(logPath, [
            JSON.stringify({ event: 'request', key: 'url1' }),
            JSON.stringify({ event: 'task-done', key: 'url1', ok: true }),
            JSON.stringify({ event: 'task-done', key: 'url2', ok: false }),
            '', // trailing blank line
        ].join('\n'));

        const done = loadCompletedKeys(logPath);
        assert.deepEqual([...done].sort(), ['url1', 'url2']);
    });
});

test('loadCompletedKeys tolerates a truncated last line', async () => {
    await withTempDir(dir => {
        const logPath = path.join(dir, 'run.ndjson');
        fs.writeFileSync(logPath, `${JSON.stringify({ event: 'task-done', key: 'url1' })}\n{"event":"task-d`);
        const done = loadCompletedKeys(logPath);
        assert.deepEqual([...done], ['url1']);
    });
});

test('loadCompletedKeys returns empty set when the log does not exist yet', () => {
    const done = loadCompletedKeys('/nonexistent/path/run.ndjson');
    assert.equal(done.size, 0);
});

test('runPool respects the concurrency ceiling', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
    });
    assert.ok(maxInFlight <= 2, `max in flight was ${maxInFlight}`);
});

test('makeBreaker stays at 0 until the minimum sample size is reached', () => {
    const breaker = makeBreaker(50);
    for (let i = 0; i < 9; i++) breaker.record(false);
    assert.equal(breaker.errorRate(), 0, 'below the min(10, window) sample floor');
    breaker.record(false);
    assert.equal(breaker.errorRate(), 1, 'now at the floor, all failures');
});

test('makeBreaker computes a rolling rate and evicts old records', () => {
    const breaker = makeBreaker(10);
    for (let i = 0; i < 10; i++) breaker.record(true);
    assert.equal(breaker.errorRate(), 0);
    for (let i = 0; i < 10; i++) breaker.record(false);
    assert.equal(breaker.errorRate(), 1, 'window fully evicted the earlier successes');
});

test('DEFAULT_STEPS sums to a five-figure request budget', () => {
    const total = DEFAULT_STEPS.reduce((sum, s) => sum + s.requests, 0);
    assert.equal(total, 10050);
});

function mockFetch(impl) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    return () => { globalThis.fetch = original; };
}

test('runLoadTest logs one task-done and archive-only requests per source', async () => {
    await withTempDir(async dir => {
        const restore = mockFetch(async (url) => {
            if (String(url).includes('wayback/available')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        archived_snapshots: {
                            closest: { available: true, timestamp: '20240101120000', url: 'http://web.archive.org/web/20240101120000/https://example.com/a' }
                        }
                    }),
                };
            }
            return { ok: true, status: 200, json: async () => ({ content: 'x'.repeat(500), truncated: false }) };
        });

        try {
            const out = path.join(dir, 'run.ndjson');
            const contentOut = path.join(dir, 'content.ndjson');
            const tasks = [
                { key: 'k1', url: 'https://example.com/a', pageNum: null, citations: [] },
            ];

            const { aborted, requestCount, stepSummaries } = await runLoadTest({
                tasks,
                sidecar: 'http://sidecar.invalid',
                steps: [{ requests: 1, concurrency: 1 }],
                out,
                contentOut,
                resume: false,
                warnErrorRate: 0.02,
                abortErrorRate: 0.10,
                window: 50,
                log: () => {},
            });

            assert.equal(aborted, false);
            assert.equal(requestCount, 2, 'availability lookup + snapshot fetch');
            assert.equal(stepSummaries[0].ok, 1);

            const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
            const requests = lines.filter(l => l.event === 'request');
            const done = lines.filter(l => l.event === 'task-done');
            assert.equal(requests.length, 2);
            assert.equal(done.length, 1);
            assert.equal(done[0].ok, true);

            const contentLines = fs.readFileSync(contentOut, 'utf8').trim().split('\n').map(JSON.parse);
            assert.equal(contentLines.length, 1);
            assert.equal(contentLines[0].key, 'k1');
        } finally {
            restore();
        }
    });
});

test('runLoadTest resume skips sources already recorded in --out', async () => {
    await withTempDir(async dir => {
        let calls = 0;
        const restore = mockFetch(async () => {
            calls++;
            throw new Error('should not be called for an already-completed source');
        });
        try {
            const out = path.join(dir, 'run.ndjson');
            fs.writeFileSync(out, `${JSON.stringify({ event: 'task-done', key: 'k1', ok: true })}\n`);

            const { requestCount } = await runLoadTest({
                tasks: [{ key: 'k1', url: 'https://example.com/a', pageNum: null, citations: [] }],
                sidecar: 'http://sidecar.invalid',
                steps: [{ requests: 5, concurrency: 1 }],
                out,
                contentOut: null,
                resume: true,
                warnErrorRate: 0.02,
                abortErrorRate: 0.10,
                window: 50,
                log: () => {},
            });

            assert.equal(requestCount, 0);
            assert.equal(calls, 0);
        } finally {
            restore();
        }
    });
});

test('runLoadTest aborts the run once the rolling error rate crosses the abort threshold', async () => {
    await withTempDir(async dir => {
        const restore = mockFetch(async (url) => {
            // Every request fails outright: availability lookup errors.
            throw new Error('simulated failure');
        });
        try {
            const out = path.join(dir, 'run.ndjson');
            const tasks = Array.from({ length: 30 }, (_, i) => ({
                key: `k${i}`, url: `https://example.com/${i}`, pageNum: null, citations: [],
            }));

            const { aborted, stepSummaries } = await runLoadTest({
                tasks,
                sidecar: 'http://sidecar.invalid',
                steps: [{ requests: 30, concurrency: 1 }],
                out,
                contentOut: null,
                resume: false,
                warnErrorRate: 0.02,
                abortErrorRate: 0.10,
                window: 10,
                log: () => {},
            });

            assert.equal(aborted, true);
            // Should stop well short of attempting all 30 sources.
            assert.ok(stepSummaries[0].ok + stepSummaries[0].failed < 30);
        } finally {
            restore();
        }
    });
});
