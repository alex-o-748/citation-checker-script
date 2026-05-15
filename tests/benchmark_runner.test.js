import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPool, withRetry, makeSaver, hostForProvider, shapeResult, synthesizePipelineSU, compareVerdicts } from '../benchmark/run_benchmark.js';

// ---- runPool ----------------------------------------------------------------

test('runPool: processes every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen = [];
    await runPool(items, 5, async (n) => { seen.push(n); });
    seen.sort((a, b) => a - b);
    assert.deepEqual(seen, items);
});

test('runPool: never exceeds the concurrency cap', async () => {
    const concurrency = 4;
    let inFlight = 0;
    let peak = 0;
    await runPool(Array.from({ length: 30 }), concurrency, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setImmediate(r));
        inFlight--;
    });
    assert.equal(peak, concurrency);
});

test('runPool: handles empty input without spawning workers', async () => {
    let calls = 0;
    await runPool([], 5, async () => { calls++; });
    assert.equal(calls, 0);
});

test('runPool: caps worker count at items.length when concurrency > items', async () => {
    let peak = 0;
    let inFlight = 0;
    await runPool([1, 2], 100, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setImmediate(r));
        inFlight--;
    });
    assert.equal(peak, 2);
});

// ---- withRetry --------------------------------------------------------------

const noSleep = () => Promise.resolve();

test('withRetry: returns the value on first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; }, { sleepFn: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
});

test('withRetry: retries on HTTP 429 and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 3) throw new Error('HTTP 429: rate limited');
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('withRetry: retries on HTTP 503', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 2) throw new Error('HTTP 503: backend unavailable');
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(calls, 2);
    assert.equal(result, 'ok');
});

test('withRetry: retries on network timeout', async () => {
    let calls = 0;
    await withRetry(async () => {
        calls++;
        if (calls < 2) throw new Error('Request timeout');
        return 'ok';
    }, { sleepFn: noSleep });
    assert.equal(calls, 2);
});

test('withRetry: does NOT retry on HTTP 400', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('HTTP 400: bad request');
        }, { sleepFn: noSleep }),
        /HTTP 400/
    );
    assert.equal(calls, 1);
});

test('withRetry: does NOT retry on parse errors', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('Parse error: unexpected token');
        }, { sleepFn: noSleep }),
        /Parse error/
    );
    assert.equal(calls, 1);
});

test('withRetry: gives up after maxRetries and throws the last error', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error(`HTTP 429: try ${calls}`);
        }, { sleepFn: noSleep, maxRetries: 3 }),
        /HTTP 429: try 3/
    );
    assert.equal(calls, 3);
});

test('withRetry: backoff schedule is exponential and uses sleepFn', async () => {
    const delays = [];
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            throw new Error('HTTP 429');
        }, { maxRetries: 4, sleepFn: async (ms) => { delays.push(ms); } })
    );
    // 4 attempts → 3 sleeps between them. Base values: 1000, 2000, 4000 (+ up to 500 jitter).
    assert.equal(delays.length, 3);
    assert.ok(delays[0] >= 1000 && delays[0] < 1500, `attempt 0 sleep was ${delays[0]}`);
    assert.ok(delays[1] >= 2000 && delays[1] < 2500, `attempt 1 sleep was ${delays[1]}`);
    assert.ok(delays[2] >= 4000 && delays[2] < 4500, `attempt 2 sleep was ${delays[2]}`);
});

// ---- makeSaver --------------------------------------------------------------

function tmpFile(prefix) {
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('makeSaver: coalesces many concurrent requests into ≤2 disk writes', async () => {
    const file = tmpFile('saver-coalesce');
    let writes = 0;
    const data = { value: 0 };
    const { requestSave, drain } = makeSaver(file, {}, () => {
        writes++;
        return data;
    });
    try {
        // Fire 20 requests synchronously in one tick — these should collapse.
        for (let i = 0; i < 20; i++) {
            data.value = i;
            requestSave();
        }
        await drain();
        // Worst case: one write that started before requests piled up,
        // plus one more flushing the queued state.
        assert.ok(writes <= 2, `expected ≤2 writes, got ${writes}`);
        assert.ok(writes >= 1, 'expected at least one write');

        // Final saved state reflects the latest data.
        const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.equal(saved.rows.value, 19);
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('makeSaver: drain() waits for in-flight write to finish', async () => {
    const file = tmpFile('saver-drain');
    const { requestSave, drain } = makeSaver(file, { run_at: 'fixed' }, () => ({ done: true }));
    try {
        requestSave();
        await drain();
        // After drain() returns, the file must exist and be readable.
        assert.ok(fs.existsSync(file));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
            metadata: { run_at: 'fixed' },
            rows: { done: true }
        });
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('makeSaver: writes are atomic via tmp+rename (no partial JSON visible)', async () => {
    // Concurrent reads during many saves should always see valid JSON, never
    // a half-written file. We probe the file repeatedly while saves are in
    // flight and assert every observation parses.
    const file = tmpFile('saver-atomic');
    const data = { value: 0 };
    const { requestSave, drain } = makeSaver(file, {}, () => data);
    let stop = false;
    const observations = [];
    const reader = (async () => {
        while (!stop) {
            try {
                const text = fs.readFileSync(file, 'utf-8');
                observations.push(JSON.parse(text)); // throws on partial write
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
            await new Promise(r => setImmediate(r));
        }
    })();
    try {
        for (let i = 0; i < 50; i++) {
            data.value = i;
            requestSave();
            await new Promise(r => setImmediate(r));
        }
        await drain();
        stop = true;
        await reader;
        // We should have observed at least one write and no parse failure.
        assert.ok(observations.length > 0, 'reader saw no observations');
        const last = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.equal(last.rows.value, 49);
    } finally {
        stop = true;
        try { await reader; } catch {}
        fs.rmSync(file, { force: true });
    }
});

// ---- hostForProvider --------------------------------------------------------

test('hostForProvider: derives hostname from endpoint URL', () => {
    const fakeProviders = {
        a: { endpoint: 'https://api.example.com/v1/x' },
        b: { endpoint: 'https://api.example.com/v2/y' },
        c: { endpoint: 'https://other.example.org/v1/z' },
    };
    assert.equal(hostForProvider('a', fakeProviders), 'api.example.com');
    assert.equal(hostForProvider('b', fakeProviders), 'api.example.com');
    assert.equal(hostForProvider('c', fakeProviders), 'other.example.org');
});

test('hostForProvider: real PROVIDERS — PublicAI models share one host', () => {
    // Regression guard: if anyone splits PublicAI models across hosts in the
    // future, the per-host concurrency budget assumption changes.
    const a = hostForProvider('apertus-70b');
    const b = hostForProvider('qwen-sealion');
    const c = hostForProvider('olmo-32b');
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a, 'api.publicai.co');
});

test('hostForProvider: Anthropic and Gemini are independent hosts', () => {
    assert.equal(hostForProvider('claude-sonnet-4-5'), 'api.anthropic.com');
    assert.equal(hostForProvider('gemini-2.5-flash'), 'generativelanguage.googleapis.com');
});

// ---- shapeResult (parse delegation to core/parsing.js) ----------------------
// Behavioral wiring tests — full parser coverage lives in tests/parsing.test.js.

test('shapeResult: delegates JSON parsing to core and title-cases the verdict', () => {
    const text = JSON.stringify({ verdict: 'SUPPORTED', confidence: 90, comments: 'ok' });
    const out = shapeResult({ text, usage: { input: 10, output: 5, cost_usd: null } });
    assert.equal(out.verdict, 'Supported');
    assert.equal(out.confidence, 90);
    assert.equal(out.raw_response, text);
    assert.deepEqual(out.usage, { input: 10, output: 5, cost_usd: null });
});

test('shapeResult: recovers verdict from the Granite-style markdown fallback', () => {
    // Regression guard: pre-consolidation, the benchmark's local regex
    // (/verdict["\s:]+([A-Z_ ]+)/i) could not advance past "**" in
    // "**Verdict:** SUPPORTED". The shared parser now strips emphasis first.
    const text = '**Verdict:** SUPPORTED\n**Comments:** matches the source.';
    const out = shapeResult({ text, usage: null });
    assert.equal(out.verdict, 'Supported');
});

test('shapeResult: returns PARSE_ERROR sentinel on unrecoverable prose', () => {
    const out = shapeResult({ text: 'I cannot determine this.', usage: null });
    assert.equal(out.verdict, 'PARSE_ERROR');
    assert.equal(out.confidence, 0);
});

// ---- synthesizePipelineSU --------------------------------------------------

test('synthesizePipelineSU emits Source unavailable verdict with pipeline_attributed flag', () => {
    const entry = {
        id: 'row_70',
        ground_truth: 'Not supported',
        extraction_status: 'body_unusable',
        body_unusable_reason: 'json_ld_leak',
    };
    const result = synthesizePipelineSU(entry, 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929');
    assert.equal(result.entry_id, 'row_70');
    assert.equal(result.provider, 'claude-sonnet-4-5');
    assert.equal(result.model, 'claude-sonnet-4-5-20250929');
    assert.equal(result.predicted_verdict, 'Source unavailable');
    assert.equal(result.confidence, 'High');
    assert.equal(result.comments, 'Pipeline-attributed (json_ld_leak)');
    assert.equal(result.latency_ms, 0);
    assert.equal(result.error, null);
    assert.equal(result.pipeline_attributed, true);
    assert.ok(result.timestamp);
});

test('synthesizePipelineSU correct field reflects GT match', () => {
    // When GT is "Source unavailable", the synthesized verdict matches → exact
    const matchingEntry = {
        id: 'row_x',
        ground_truth: 'Source unavailable',
        body_unusable_reason: 'wayback_chrome',
    };
    const matching = synthesizePipelineSU(matchingEntry, 'p', 'm');
    assert.equal(matching.correct, 'exact');

    // When GT is "Supported", the synthesized SU verdict is wrong (per-row this
    // is a pipeline-attributed failure; the analyzer separates from model failures).
    const mismatchEntry = {
        id: 'row_y',
        ground_truth: 'Supported',
        body_unusable_reason: 'wayback_chrome',
    };
    const mismatch = synthesizePipelineSU(mismatchEntry, 'p', 'm');
    assert.equal(mismatch.correct, 'wrong');
});

test('synthesizePipelineSU handles missing body_unusable_reason gracefully', () => {
    const entry = { id: 'row_x', ground_truth: 'Not supported' };
    const result = synthesizePipelineSU(entry, 'p', 'm');
    assert.equal(result.comments, 'Pipeline-attributed (unknown)');
});
