import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createHostGate,
    runHostPool,
    hostOf,
    DEFAULT_FETCH_CONCURRENCY,
} from '../service/host-pool.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Tracks how many calls are running at once, overall and per key.
function concurrencyProbe() {
    const running = new Map();
    let total = 0;
    const probe = { maxTotal: 0, maxPerKey: 0, order: [] };
    probe.run = async (key, ms = 5) => {
        total++;
        running.set(key, (running.get(key) ?? 0) + 1);
        probe.maxTotal = Math.max(probe.maxTotal, total);
        probe.maxPerKey = Math.max(probe.maxPerKey, running.get(key));
        probe.order.push(key);
        await sleep(ms);
        running.set(key, running.get(key) - 1);
        total--;
    };
    return probe;
}

test('hostOf groups by host and port, case-insensitively', () => {
    assert.equal(hostOf('https://Example.COM/a?b=c'), 'example.com');
    assert.equal(hostOf('https://example.com:8443/a'), 'example.com:8443');
    assert.equal(hostOf('https://web.archive.org/web/2020id_/https://x.com/'), 'web.archive.org');
    assert.equal(hostOf('not a url'), 'not a url', 'an unparseable URL is its own key, not a crash');
});

test('the default fetch concurrency is modest — the per-host cap holds regardless', () => {
    assert.ok(DEFAULT_FETCH_CONCURRENCY > 1, 'the point of the change is to not be serial');
    assert.ok(DEFAULT_FETCH_CONCURRENCY <= 8, 'one shared fetcher pod; raise it deliberately, not by default');
});

// --- createHostGate ---

test('the gate never runs two calls for one host at once', async () => {
    const gate = createHostGate();
    const probe = concurrencyProbe();
    await Promise.all(Array.from({ length: 5 }, () => gate('a.example', () => probe.run('a.example'))));
    assert.equal(probe.maxPerKey, 1);
});

test('the gate lets different hosts run in parallel', async () => {
    const gate = createHostGate();
    const probe = concurrencyProbe();
    await Promise.all(['a', 'b', 'c'].map(h => gate(h, () => probe.run(h, 20))));
    assert.equal(probe.maxTotal, 3);
});

test('the gate admits waiters in arrival order and returns each call\'s result', async () => {
    const gate = createHostGate();
    const order = [];
    const results = await Promise.all([1, 2, 3, 4].map(n => gate('h', async () => {
        order.push(n);
        await sleep(1);
        return n * 10;
    })));
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.deepEqual(results, [10, 20, 30, 40]);
});

test('a throwing call releases its host for the next waiter', async () => {
    const gate = createHostGate();
    const first = gate('h', async () => { throw new Error('boom'); });
    const second = gate('h', async () => 'ran');
    await assert.rejects(first, /boom/);
    assert.equal(await second, 'ran');
});

test('perHost raises the per-host ceiling exactly', async () => {
    const gate = createHostGate({ perHost: 2 });
    const probe = concurrencyProbe();
    await Promise.all(Array.from({ length: 6 }, () => gate('h', () => probe.run('h'))));
    assert.equal(probe.maxPerKey, 2);
});

// --- runHostPool ---

test('the pool runs up to `concurrency` jobs at once, and no more', async () => {
    const probe = concurrencyProbe();
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    await runHostPool(jobs, job => probe.run(job, 10), { concurrency: 3, keyOf: j => j });
    assert.equal(probe.maxTotal, 3);
    assert.equal(probe.order.length, jobs.length, 'every job ran');
});

test('the pool never runs two jobs with the same key at once', async () => {
    const probe = concurrencyProbe();
    const jobs = ['a', 'a', 'a', 'b', 'a', 'c'].map((host, i) => ({ host, i }));
    await runHostPool(jobs, job => probe.run(job.host, 5), { concurrency: 4, keyOf: j => j.host });
    assert.equal(probe.maxPerKey, 1);
    assert.equal(probe.order.length, jobs.length);
});

test('the pool skips past a busy host instead of parking a slot behind it', async () => {
    // Four citations to one slow publisher, then two to others. A queue that
    // only ever took its head would run b and c after all four a's.
    const started = [];
    const jobs = [
        { host: 'a', ms: 30 }, { host: 'a', ms: 30 }, { host: 'a', ms: 30 }, { host: 'a', ms: 30 },
        { host: 'b', ms: 1 }, { host: 'c', ms: 1 },
    ];
    await runHostPool(jobs, async job => {
        started.push(job.host);
        await sleep(job.ms);
    }, { concurrency: 2, keyOf: j => j.host });
    assert.deepEqual(started.slice(0, 3), ['a', 'b', 'c']);
});

test('the pool starts nothing new once the signal aborts, and lets running jobs finish', async () => {
    const controller = new AbortController();
    const finished = [];
    await runHostPool(['a', 'b', 'c', 'd'], async job => {
        if (job === 'a') controller.abort();
        await sleep(5);
        finished.push(job);
    }, { concurrency: 1, keyOf: j => j, signal: controller.signal });
    assert.deepEqual(finished, ['a']);
});

test('a throwing job does not stall the pool', async () => {
    const ran = [];
    await runHostPool(['a', 'b', 'c'], async job => {
        ran.push(job);
        if (job === 'a') throw new Error('boom');
    }, { concurrency: 1, keyOf: j => j });
    assert.deepEqual(ran, ['a', 'b', 'c']);
});

test('an empty job list resolves immediately', async () => {
    await runHostPool([], () => { throw new Error('should not run'); }, { concurrency: 4, keyOf: j => j });
});
