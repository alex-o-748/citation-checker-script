import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCliArgs, runScheduled, acquireLock, releaseLock, LOCK_BUSY, DEFAULT_MAX, DEFAULT_CONCURRENCY,
} from '../service/run-scheduled.js';

// An in-memory filesystem with O_EXCL semantics for the lock.
function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const enoent = path => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return {
        files,
        mkdir: async () => {},
        writeFile: async (path, text, options) => {
            if ((options?.flag ?? '') === 'wx' && files.has(path)) {
                throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
            }
            files.set(path, text);
        },
        readFile: async path => {
            if (!files.has(path)) throw enoent(path);
            return files.get(path);
        },
        unlink: async path => {
            if (!files.has(path)) throw enoent(path);
            files.delete(path);
        },
    };
}

const NOW = new Date('2026-10-27T03:17:00Z');
const LOCK = 'sweeps/ruwiki/scheduled.lock';

const baseOpts = (overrides = {}) => ({
    ...parseCliArgs(['node', 'run-scheduled.js', '--wiki', 'ruwiki', '--provider', 'liftwing-safeguard',
        '--series', 'ruwiki-weekly']),
    ...overrides,
});

function harness({ fs = memoryFs(), pickCode = 0, sweepCode = 0, sweepThrows = null, trendsThrows = false } = {}) {
    const calls = { pick: [], sweep: [], trends: [], runWrites: [] };
    const logLines = [];
    const stderr = [];
    const io = {
        stdout: { write() {} },
        stderr: { write: s => stderr.push(s) },
        now: () => NOW,
        mkdir: fs.mkdir, writeFile: fs.writeFile, readFile: fs.readFile, unlink: fs.unlink,
        openLog: path => ({ path, write: s => logLines.push(s), end: done => done() }),
        pickFn: async (opts, stages) => {
            calls.pick.push(opts);
            stages.stdout.write('selected 25 article(s)\n');
            return pickCode;
        },
        sweepFn: async (opts, stages) => {
            calls.sweep.push(opts);
            stages.stderr.write('sweep: done.\n');
            if (sweepThrows) throw sweepThrows;
            return sweepCode;
        },
        trendsFn: async opts => {
            calls.trends.push(opts);
            if (trendsThrows) throw new Error('no ToolsDB');
            return 0;
        },
        connectToolsDb: async () => ({
            execute: async (sql, params) => { calls.runWrites.push({ sql, params }); return [{ affectedRows: 1 }]; },
            end: async () => {},
        }),
        codeVersionFn: async () => 'c0ffee0000000000000000000000000000000000',
    };
    return { io, fs, calls, logLines, stderr };
}

test('parseCliArgs defaults: a small batch, a few model calls at once, a series named after the wiki', () => {
    const opts = parseCliArgs(['node', 'x', '--wiki', 'ruwiki', '--provider', 'liftwing']);
    assert.equal(opts.max, DEFAULT_MAX);
    assert.equal(opts.concurrency, DEFAULT_CONCURRENCY);
    assert.equal(opts.series, 'ruwiki-scheduled');
    assert.equal(opts.outDir, 'sweeps');
    assert.equal(opts.lockStaleHours, 24);
    assert.equal(opts.severity, false);
});

test('--wiki and --provider are both required; an unknown provider is rejected', async () => {
    for (const args of [['--provider', 'liftwing'], ['--wiki', 'ruwiki'], ['--wiki', 'ruwiki', '--provider', 'nope']]) {
        const { io, calls } = harness();
        assert.equal(await runScheduled(parseCliArgs(['node', 'x', ...args]), io), 2, args.join(' '));
        assert.equal(calls.pick.length, 0);
    }
});

test('a run picks into its own directory, sweeps that list live under the same run id, then reports trends', async () => {
    const { io, fs, calls, logLines } = harness();
    const code = await runScheduled(baseOpts({ max: 10 }), io);

    assert.equal(code, 0);
    const [pick] = calls.pick;
    assert.equal(pick.wiki, 'ruwiki');
    assert.equal(pick.max, 10);
    assert.equal(pick.excludeChecked, true, 'already-checked articles are left out');
    assert.match(pick.out, /^sweeps\/ruwiki\/ruwiki-20261027T031700Z-[0-9a-f]{4}\/titles\.txt$/);
    const runDir = pick.out.replace(/\/titles\.txt$/, '');
    const runId = runDir.split('/').at(-1);

    const [sweep] = calls.sweep;
    assert.equal(sweep.titlesFile, pick.out);
    assert.equal(sweep.wiki, 'ruwiki');
    assert.equal(sweep.liveSourceFetch, true);
    assert.equal(sweep.store, true);
    assert.equal(sweep.provider, 'liftwing-safeguard');
    assert.equal(sweep.model, 'llm-gpt-oss-safeguard-20b');
    assert.equal(sweep.concurrency, DEFAULT_CONCURRENCY);
    assert.equal(sweep.runId, runId, 'the directory and the rows share one id');
    assert.equal(sweep.series, 'ruwiki-weekly');
    assert.equal(sweep.out, `${runDir}/findings.csv`);

    assert.deepEqual(calls.trends, [{ wiki: 'ruwiki', series: 'ruwiki-weekly', limit: 8, fromDir: null }]);
    assert.equal(fs.files.has(LOCK), false, 'the lock is released');
    const log = logLines.join('');
    assert.match(log, /selected 25 article\(s\)/, 'the stages\' output reaches the run\'s log');
    assert.match(log, /sweep: done\./);
    assert.match(log, /finished with exit code 0/);
});

test('the sweep\'s exit code is the run\'s: a failed check still mails', async () => {
    const { io, fs } = harness({ sweepCode: 5 });
    assert.equal(await runScheduled(baseOpts(), io), 5);
    assert.equal(fs.files.has(LOCK), false);
});

test('a pick that fails skips the sweep but still leaves a pick_failed record', async () => {
    const { io, fs, calls } = harness({ pickCode: 1 });
    const code = await runScheduled(baseOpts(), io);
    assert.equal(code, 1);
    assert.equal(calls.sweep.length, 0);
    const [recordPath] = [...fs.files.keys()].filter(p => p.endsWith('findings-run.json'));
    const record = JSON.parse(fs.files.get(recordPath));
    assert.equal(record.status, 'pick_failed');
    assert.equal(record.exit_code, 1);
    assert.equal(record.series, 'ruwiki-weekly');
    assert.equal(record.model, 'llm-gpt-oss-safeguard-20b');
    assert.equal(calls.runWrites.length, 1);
    assert.match(calls.runWrites[0].sql, /INSERT INTO sweep_runs/);
    assert.equal(fs.files.has(LOCK), false);
});

test('a run that finds the lock held by a live run exits 6 without picking', async () => {
    const holder = JSON.stringify({ runId: 'ruwiki-earlier', startedAt: '2026-10-27T01:00:00Z' });
    const { io, fs, calls, stderr } = harness({ fs: memoryFs({ [LOCK]: holder }) });
    const code = await runScheduled(baseOpts(), io);
    assert.equal(code, LOCK_BUSY);
    assert.equal(calls.pick.length, 0);
    assert.equal(fs.files.get(LOCK), holder, 'the other run\'s lock is left alone');
    assert.match(stderr.join(''), /another run holds .*ruwiki-earlier/);
});

test('a stale lock (a run killed before it could release it) is taken over, and says so', async () => {
    const holder = JSON.stringify({ runId: 'ruwiki-killed', startedAt: '2026-10-20T03:17:00Z' });
    const { io, fs, calls, logLines } = harness({ fs: memoryFs({ [LOCK]: holder }) });
    const code = await runScheduled(baseOpts(), io);
    assert.equal(code, 0);
    assert.equal(calls.sweep.length, 1);
    assert.match(logLines.join(''), /took over a stale lock from ruwiki-killed/);
    assert.equal(fs.files.has(LOCK), false);
});

test('trends that can\'t be read never change the exit code', async () => {
    const { io, logLines } = harness({ trendsThrows: true });
    assert.equal(await runScheduled(baseOpts(), io), 0);
    assert.match(logLines.join(''), /trends unavailable: no ToolsDB/);
});

test('a stage that throws is exit 1, logged, and still releases the lock', async () => {
    const { io, fs, logLines } = harness({ sweepThrows: new Error('boom') });
    assert.equal(await runScheduled(baseOpts(), io), 1);
    assert.match(logLines.join(''), /scheduled: Error: boom/);
    assert.equal(fs.files.has(LOCK), false);
});

test('acquireLock: O_EXCL first, then only a lock older than the stale age is taken', async () => {
    const fs = memoryFs();
    const staleMs = 24 * 3600_000;
    const first = await acquireLock(LOCK, { runId: 'a', now: () => NOW, staleMs, ...fs });
    assert.deepEqual(first, { acquired: true, tookOver: null });
    const second = await acquireLock(LOCK, { runId: 'b', now: () => new Date(NOW.getTime() + 3600_000), staleMs, ...fs });
    assert.equal(second.acquired, false);
    assert.equal(second.holder.runId, 'a');
    const third = await acquireLock(LOCK, { runId: 'c', now: () => new Date(NOW.getTime() + 25 * 3600_000), staleMs, ...fs });
    assert.equal(third.acquired, true);
    assert.equal(third.tookOver.runId, 'a');
    assert.equal(JSON.parse(fs.files.get(LOCK)).runId, 'c');
});

test('acquireLock treats an unreadable lock as stale rather than blocking every run', async () => {
    const fs = memoryFs({ [LOCK]: 'not json' });
    const result = await acquireLock(LOCK, { runId: 'a', now: () => NOW, staleMs: 3600_000, ...fs });
    assert.equal(result.acquired, true);
});

test('releaseLock only removes the lock it holds', async () => {
    const fs = memoryFs({ [LOCK]: JSON.stringify({ runId: 'someone-else' }) });
    assert.equal(await releaseLock(LOCK, { runId: 'me', ...fs }), false);
    assert.equal(fs.files.has(LOCK), true);
    assert.equal(await releaseLock(LOCK, { runId: 'someone-else', ...fs }), true);
    assert.equal(fs.files.has(LOCK), false);
});
