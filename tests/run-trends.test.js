import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    runRates, compareToBaseline, renderTrends, loadRunsFromDir, runTrends, parseCliArgs, DRIFT_POINTS,
} from '../service/run-trends.js';

let day = 0;
// A finished weekly run: 100 judged verdicts, `flagged` of them flagged.
function run(overrides = {}) {
    day += 7;
    const started = new Date(Date.UTC(2026, 9, 1) + day * 86400000);
    return {
        run_id: `ruwiki-${day}`, wiki: 'ruwiki', series: 'ruwiki-weekly', status: 'ok',
        started_at: started.toISOString(), finished_at: new Date(started.getTime() + 90 * 60000).toISOString(),
        model: 'llm-gpt-oss-safeguard-20b', prompt_version: 'p1',
        articles: 25, rows_total: 200, model_rows: 120,
        supported: 70, partially_supported: 15, not_supported: 15, source_unavailable: 80, error_rows: 4, skipped_rows: 0,
        citations_with_url: 180, fetched: 120, fetch_failed: 60, our_fetch_failed: 1, truncated: 12,
        tokens_in: 250000, tokens_out: 25000,
        ...overrides,
    };
}

test('runRates divides each count by the population it is about', () => {
    const rates = runRates(run());
    assert.equal(rates.flagged, 0.3, '(PS + NS) of judged verdicts, not of all rows');
    assert.equal(rates.notSupported, 0.15);
    assert.equal(rates.unavailable, 0.4);
    assert.equal(rates.errors, 0.02);
    assert.equal(rates.fetchFailed, 60 / 180);
    assert.equal(rates.truncated, 0.1);
    assert.equal(rates.rowsPerArticle, 8);
    assert.equal(rates.tokensPerArticle, 11000);
    assert.equal(rates.minutes, 90);
});

test('runRates is null, not zero, where a record has no counts (a run still going, or checks skipped)', () => {
    const rates = runRates({ status: 'running', started_at: '2026-10-27T03:17:00Z', finished_at: null });
    assert.equal(rates.flagged, null);
    assert.equal(rates.fetchFailed, null);
    assert.equal(rates.minutes, null);
});

test('no drift when the latest run looks like the ones before it', () => {
    const records = [run(), run(), run(), run({ not_supported: 17, supported: 68 })];
    const result = compareToBaseline(records);
    assert.equal(result.note, null);
    assert.equal(result.baseline.length, 3);
    assert.deepEqual(result.drift, []);
});

test('a publisher refusing Toolforge shows as fetch-failure drift', () => {
    const records = [run(), run(), run(), run({ fetch_failed: 120 })];
    const result = compareToBaseline(records);
    assert.deepEqual(result.drift.map(d => d.key), ['fetchFailed']);
    assert.ok(result.drift[0].delta >= DRIFT_POINTS);
});

test('a model switch is not reported as drift: the new model has no history yet', () => {
    const records = [run(), run(), run(), run({ model: 'llm-qwen38-27b', partially_supported: 40, supported: 45 })];
    const result = compareToBaseline(records);
    assert.equal(result.baseline.length, 0);
    assert.deepEqual(result.drift, []);
    assert.match(result.note, /not enough comparable runs .*same model and prompt version/);
});

test('the baseline leaves out runs that failed or halted, and a run still going is not "latest"', () => {
    const records = [
        run(), run({ status: 'checks_failed', fetch_failed: 170 }), run(), run(),
        run({ fetch_failed: 61 }),
        run({ status: 'running', finished_at: null, fetch_failed: null }),
    ];
    const result = compareToBaseline(records);
    assert.equal(result.latest.fetch_failed, 61);
    assert.equal(result.baseline.length, 3);
    assert.ok(result.baseline.every(r => r.status === 'ok'));
    assert.deepEqual(result.drift, []);
});

test('the baseline is the most recent comparable runs, up to its size', () => {
    const old = Array.from({ length: 6 }, () => run({ error_rows: 40 }));
    const recent = Array.from({ length: 5 }, () => run());
    const result = compareToBaseline([...old, ...recent, run()]);
    assert.equal(result.baseline.length, 5);
    assert.deepEqual(result.drift, [], 'the old high-error runs fell out of the window');
});

test('renderTrends lists every run oldest first and states the drift verdict', () => {
    const records = [run(), run(), run(), run({ fetch_failed: 120 })].reverse();
    const text = renderTrends(records, compareToBaseline(records), { wiki: 'ruwiki', series: 'ruwiki-weekly' });
    assert.match(text, /^Sweep runs: ruwiki · series ruwiki-weekly · 4 run\(s\)/);
    const lines = text.split('\n');
    const dataLines = lines.filter(l => /^\d{4}-\d{2}-\d{2} /.test(l));
    assert.equal(dataLines.length, 4);
    assert.ok(dataLines[0] < dataLines[3], 'oldest first');
    assert.match(text, /fetchF: 66\.7% vs 33\.3% \(\+33\.3 points\)/);
});

test('renderTrends says so when nothing is recorded', () => {
    assert.match(renderTrends([], compareToBaseline([]), { wiki: 'ruwiki' }), /No runs recorded\./);
});

test('loadRunsFromDir finds -run.json files at any depth and filters by wiki and series', async () => {
    const tree = {
        sweeps: ['ruwiki', 'enwiki', 'notes.txt'],
        'sweeps/ruwiki': ['r1', 'r2'],
        'sweeps/ruwiki/r1': ['findings.csv', 'findings-run.json'],
        'sweeps/ruwiki/r2': ['findings-run.json', 'broken-run.json'],
        'sweeps/enwiki': ['findings-run.json'],
    };
    const files = {
        'sweeps/ruwiki/r1/findings-run.json': JSON.stringify({ run_id: 'r1', wiki: 'ruwiki', series: 'ruwiki-weekly' }),
        'sweeps/ruwiki/r2/findings-run.json': JSON.stringify({ run_id: 'r2', wiki: 'ruwiki', series: null }),
        'sweeps/ruwiki/r2/broken-run.json': '{"run_id": "half-writ',
        'sweeps/enwiki/findings-run.json': JSON.stringify({ run_id: 'e1', wiki: 'enwiki' }),
    };
    const readdir = async path => tree[path].map(name => ({
        name, isDirectory: () => `${path}/${name}` in tree,
    }));
    const readFile = async path => files[path];

    const all = await loadRunsFromDir('sweeps', { wiki: 'ruwiki', readdir, readFile });
    assert.deepEqual(all.map(r => r.run_id).sort(), ['r1', 'r2'], 'a broken file is skipped, not fatal');
    const series = await loadRunsFromDir('sweeps', { wiki: 'ruwiki', series: 'ruwiki-weekly', readdir, readFile });
    assert.deepEqual(series.map(r => r.run_id), ['r1']);
});

test('runTrends reads ToolsDB by default and prints the report', async () => {
    const out = [];
    const calls = [];
    let ended = false;
    const code = await runTrends({ wiki: 'ruwiki', series: null, limit: 5, fromDir: null }, {
        stdout: { write: s => out.push(s) },
        stderr: { write() {} },
        connectToolsDb: async () => ({
            execute: async (sql, params) => { calls.push({ sql, params }); return [[run(), run()]]; },
            end: async () => { ended = true; },
        }),
    });
    assert.equal(code, 0);
    assert.match(calls[0].sql, /FROM sweep_runs WHERE wiki = \? ORDER BY started_at DESC LIMIT 5/);
    assert.equal(ended, true);
    assert.match(out.join(''), /Sweep runs: ruwiki · 2 run\(s\)/);
});

test('runTrends --from-dir never touches ToolsDB, and keeps only the newest --limit runs', async () => {
    const out = [];
    let connected = false;
    const records = [run({ run_id: 'a' }), run({ run_id: 'b' }), run({ run_id: 'c' })];
    const code = await runTrends({ wiki: 'ruwiki', series: null, limit: 2, fromDir: 'sweeps' }, {
        stdout: { write: s => out.push(s) },
        connectToolsDb: async () => { connected = true; },
        loadFromDir: async () => records.slice().reverse(),
    });
    assert.equal(code, 0);
    assert.equal(connected, false);
    assert.match(out.join(''), /2 run\(s\)/);
});

test('runTrends rejects a missing --wiki and reports an unreadable store', async () => {
    assert.equal(await runTrends({ limit: 5 }, { stderr: { write() {} } }), 2);
    const err = [];
    const code = await runTrends({ wiki: 'ruwiki', limit: 5, fromDir: null }, {
        stderr: { write: s => err.push(s) },
        connectToolsDb: async () => { throw new Error('no ToolsDB here'); },
    });
    assert.equal(code, 1);
    assert.match(err.join(''), /could not read run records: no ToolsDB here/);
});

test('parseCliArgs', () => {
    const opts = parseCliArgs(['node', 'x', '--wiki', 'ruwiki', '--series', 'ruwiki-weekly', '--from-dir', 'sweeps']);
    assert.deepEqual(opts, { help: false, wiki: 'ruwiki', series: 'ruwiki-weekly', limit: 12, fromDir: 'sweeps' });
});

test('a failed pick (a run with nothing counted) is shown but never taken as the latest run', () => {
    const records = [run(), run(), run(), run({ fetch_failed: 61 }),
        { run_id: 'pick', wiki: 'ruwiki', status: 'pick_failed', started_at: '2027-01-01T03:17:00Z', rows_total: null }];
    const result = compareToBaseline(records);
    assert.equal(result.latest.fetch_failed, 61);
    assert.equal(result.note, null);
    const text = renderTrends(records, result, { wiki: 'ruwiki' });
    assert.match(text, /pick_failed/);
    assert.match(text, /Drift: none — the run of \d{4}-\d{2}-\d{2} \d{2}:\d{2} is within/);
});
