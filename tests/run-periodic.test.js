import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    parseRecheckSpec, parseOptions, buildSteps, runPaths, stepOutcome, runExitCode,
    acquireLock, runPeriodic, defaultRunId, countRows, DEFAULT_RECHECK_PASSES, EXIT,
} from '../service/run-periodic.js';

const sink = () => ({ write() {} });
const quiet = { stdout: sink(), stderr: sink() };

async function tmp() {
    return mkdtemp(join(tmpdir(), 'run-periodic-'));
}

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

function opts(runsDir, extra = {}) {
    return { ...parseOptions(['--wiki', 'ruwiki', '--runs-dir', runsDir, '--run-id', 'r1']), ...extra };
}

const CSV = 'claim_text,verdict\n"a, b",NOT SUPPORTED\nc,NOT SUPPORTED\n';

// A stand-in for the child processes: writes what each real step would, and
// exits with the code the test asks for.
function fakeSteps({ codes = {}, titles = 'Москва\nКиев\n', deliverRows = CSV, keptRows = CSV } = {}) {
    const calls = [];
    const fn = async (step) => {
        calls.push(step);
        const out = step.args[step.args.indexOf('--out') + 1];
        if (step.name === 'pick') await writeFile(out, `# header\n${titles}`);
        if (step.name === 'sweep') await writeFile(out, CSV);
        if (step.name === 'deliver') await writeFile(out, deliverRows);
        if (step.name.startsWith('recheck-')) {
            await writeFile(out, CSV);
            await writeFile(out.replace(/\.csv$/, '-kept.csv'), keptRows);
        }
        return codes[step.name] ?? 0;
    };
    return { fn, calls };
}

// The wrapper restates these two rules to avoid loading the verification
// stack; read as text so this test needs none of it either.
test('keptCsvPath and parseTitlesFile still match the runners they restate', async () => {
    // Whitespace-insensitive, so a CRLF checkout or a reflowed line still matches.
    const squash = text => text.replace(/\s+/g, '');
    const recheck = squash(await readFile(new URL('../service/run-recheck.js', import.meta.url), 'utf8'));
    assert.ok(recheck.includes(squash(`export function keptCsvPath(out) {
        return out.replace(/\\.csv$/, '') + '-kept.csv';
    }`)), 'run-recheck.js keptCsvPath() changed: update run-periodic.js to match');
    const sweep = squash(await readFile(new URL('../service/run-sweep.js', import.meta.url), 'utf8'));
    assert.ok(sweep.includes(squash(`export function parseTitlesFile(text) {
        return text .split('\\n') .map(line => line.trim()) .filter(line => line && !line.startsWith('#'));
    }`)), 'run-sweep.js parseTitlesFile() changed: update run-periodic.js to match');
});

test('parseRecheckSpec splits prefix:provider:model, keeping colons in the model', () => {
    assert.deepEqual(parseRecheckSpec('qwen:huggingface:Qwen/Qwen3-32B'),
        { prefix: 'qwen', provider: 'huggingface', model: 'Qwen/Qwen3-32B' });
    assert.equal(parseRecheckSpec('x:p:org/model:v2').model, 'org/model:v2');
    for (const bad of ['qwen', 'qwen:hf', 'qwen:hf:', ':hf:m', 'q-x:hf:m']) {
        assert.throws(() => parseRecheckSpec(bad), /recheck/);
    }
});

test('parseOptions: --wiki is required, the defaults are the measured recheck pair', () => {
    assert.throws(() => parseOptions([]), /--wiki/);
    const o = parseOptions(['--wiki', 'ruwiki']);
    assert.deepEqual(o.rechecks, [...DEFAULT_RECHECK_PASSES]);
    assert.equal(o.max, 100);
    assert.match(o.runsDir, /sweeps[\\/]ruwiki$/);
    assert.deepEqual(parseOptions(['--wiki', 'ruwiki', '--no-recheck']).rechecks, []);
    assert.throws(() => parseOptions(['--wiki', 'ruwiki', '--no-recheck', '--recheck', 'a:b:c']), /contradict/);
    assert.throws(() => parseOptions(['--wiki', 'ruwiki', '--recheck', 'a:b:c', '--recheck', 'a:d:e']), /own prefix/);
    assert.throws(() => parseOptions(['--wiki', 'ruwiki', '--deliver-tier', 'nope']), /deliver-tier/);
    assert.throws(() => parseOptions(['--wiki', 'ruwiki', '--run-id', '../x']), /plain directory/);
    assert.deepEqual(parseOptions(['--wiki', 'ruwiki', '--sweep-arg=--lead-check', '--sweep-arg=--concurrency=8']).sweepArgs,
        ['--lead-check', '--concurrency=8']);
});

test('buildSteps chains each recheck pass onto the previous pass\'s kept file', () => {
    const o = parseOptions(['--wiki', 'ruwiki', '--runs-dir', '/r', '--sweep-arg=--lead-check']);
    const paths = runPaths('/r/x', o);
    const steps = buildSteps(o, paths);
    assert.deepEqual(steps.map(s => s.name), ['pick', 'sweep', 'deliver', 'recheck-qwen', 'recheck-glm', 'review']);
    const [, sweep, deliver, qwen, glm] = steps;
    assert.ok(sweep.args.includes('--live-source-fetch'));
    assert.ok(sweep.args.includes('--lead-check'));
    assert.equal(deliver.args[0], paths.findings);
    assert.equal(qwen.args[0], paths.deliver);
    assert.equal(glm.args[0], paths.rechecks[0].kept);
    assert.equal(paths.final, paths.rechecks[1].kept);
    assert.equal(runPaths('/r/x', { rechecks: [] }).final, runPaths('/r/x', { rechecks: [] }).deliver);
});

test('exit codes: a failed check continues and makes the run 5; any other failure stops it', () => {
    const sweep = { name: 'sweep', fatal: true };
    assert.equal(stepOutcome(sweep, 0), 'continue');
    assert.equal(stepOutcome(sweep, 5), 'checks-failed');
    assert.equal(stepOutcome(sweep, 3), 'stop');
    assert.equal(stepOutcome({ name: 'deliver', fatal: true }, 5), 'stop');
    assert.equal(stepOutcome({ name: 'review', fatal: false }, 1), 'continue');
    assert.equal(runExitCode([{ outcome: 'continue' }]), 0);
    assert.equal(runExitCode([{ outcome: 'checks-failed' }, { outcome: 'continue' }]), 5);
    assert.equal(runExitCode([{ outcome: 'checks-failed' }, { outcome: 'stop', code: 3 }]), 3);
});

test('defaultRunId is the UTC minute, safe as a directory name', () => {
    assert.equal(defaultRunId(new Date('2026-11-30T03:00:42Z')), '2026-11-30T0300Z');
});

test('countRows counts CSV records, not lines, and titles without comments', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'a.csv'), 'x,y\n"multi\nline",1\n2,3\n');
    await writeFile(join(dir, 't.txt'), '# c\n\nA\nB\n');
    assert.equal(await countRows(join(dir, 'a.csv')), 2);
    assert.equal(await countRows(join(dir, 't.txt'), 'titles'), 2);
    assert.equal(await countRows(join(dir, 'missing.csv')), 0);
});

test('acquireLock refuses a fresh lock and takes over a stale one', async () => {
    const dir = await tmp();
    const lock = join(dir, '.lock');
    const t0 = Date.parse('2026-11-30T03:00:00Z');
    assert.equal((await acquireLock(lock, 'a', { now: t0 })).acquired, true);
    const refused = await acquireLock(lock, 'b', { now: t0 + 3_600_000 });
    assert.equal(refused.acquired, false);
    assert.equal(refused.holder.runId, 'a');
    const taken = await acquireLock(lock, 'c', { now: t0 + 73 * 3_600_000, staleHours: 72 });
    assert.equal(taken.acquired, true);
    assert.equal(taken.tookOver.runId, 'a');
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).runId, 'c');
});

test('a full run executes every step, writes the summary and releases the lock', async () => {
    const dir = await tmp();
    const { fn, calls } = fakeSteps();
    const code = await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn });
    assert.equal(code, 0);
    assert.deepEqual(calls.map(c => c.name), ['pick', 'sweep', 'deliver', 'recheck-qwen', 'recheck-glm', 'review']);
    const summary = await readFile(join(dir, 'r1', 'summary.md'), 'utf8');
    assert.match(summary, /Articles picked \| 2 \|/);
    assert.match(summary, /Kept by glm/);
    assert.match(summary, /Final delivery file: recheck-glm-kept\.csv/);
    assert.equal(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).runId, 'r1');
    assert.equal(await exists(join(dir, '.lock')), false);
});

test('a sweep whose checks failed still delivers, and the run exits 5', async () => {
    const dir = await tmp();
    const { fn, calls } = fakeSteps({ codes: { sweep: 5 } });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), EXIT.CHECKS_FAILED);
    assert.ok(calls.some(c => c.name === 'recheck-glm'));
    assert.match(await readFile(join(dir, 'r1', 'summary.md'), 'utf8'), /post-run checks failed/);
});

test('an auth failure stops the run with its own code', async () => {
    const dir = await tmp();
    const { fn, calls } = fakeSteps({ codes: { sweep: 3 } });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), 3);
    assert.deepEqual(calls.map(c => c.name), ['pick', 'sweep']);
    const state = JSON.parse(await readFile(join(dir, 'r1', 'run.json'), 'utf8'));
    assert.equal(state.steps.find(s => s.name === 'deliver').status, 'not run');
});

test('a failed review is reported, not fatal', async () => {
    const dir = await tmp();
    const { fn } = fakeSteps({ codes: { review: 1 } });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), 0);
});

test('nothing picked: the run ends cleanly without sweeping', async () => {
    const dir = await tmp();
    const { fn, calls } = fakeSteps({ titles: '' });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), 0);
    assert.deepEqual(calls.map(c => c.name), ['pick']);
});

test('an empty delivery file skips the rechecks', async () => {
    const dir = await tmp();
    const { fn, calls } = fakeSteps({ deliverRows: 'claim_text,verdict\n' });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), 0);
    assert.deepEqual(calls.map(c => c.name), ['pick', 'sweep', 'deliver', 'review']);
});

test('a second run is refused while the first holds the lock', async () => {
    const dir = await tmp();
    await acquireLock(join(dir, '.lock'), 'other');
    const { fn, calls } = fakeSteps();
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), EXIT.LOCKED);
    assert.equal(calls.length, 0);
});

test('--resume skips finished steps and resumes the sweep into its CSV', async () => {
    const dir = await tmp();
    const first = fakeSteps({ codes: { sweep: 4 } });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: first.fn }), 4);
    const again = fakeSteps();
    const code = await runPeriodic(opts(dir, { runId: null, resume: 'r1' }), { ...quiet, spawnStepFn: again.fn });
    assert.equal(code, 0);
    assert.equal(again.calls[0].name, 'sweep');
    assert.ok(again.calls[0].args.includes('--resume'));
    assert.ok(!again.calls.find(c => c.name === 'deliver').args.includes('--resume'));
});

test('an existing run directory is never overwritten without --resume', async () => {
    const dir = await tmp();
    const { fn } = fakeSteps();
    await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn });
    assert.equal(await runPeriodic(opts(dir), { ...quiet, spawnStepFn: fn }), EXIT.USAGE);
});

test('spawnStep runs a real child from the repo root, tees its output and returns its code', async () => {
    const { spawnStep, REPO_ROOT } = await import('../service/run-periodic.js');
    const dir = await tmp();
    const script = join(dir, 'step.js');
    await writeFile(script, `process.stdout.write('out:' + process.cwd() + ':' + process.argv[2] + '\\n');
process.stderr.write('err\\n');
process.exitCode = 5;\n`);
    const log = join(dir, 'step.log');
    let stdout = '';
    let stderr = '';
    const code = await spawnStep({ name: 'step', script, args: ['arg1'] }, log,
        { stdout: { write: c => { stdout += c; } }, stderr: { write: c => { stderr += c; } } });
    assert.equal(code, 5);
    assert.equal(stdout, `out:${REPO_ROOT}:arg1\n`);
    assert.equal(stderr, 'err\n');
    assert.match(await readFile(log, 'utf8'), /out:.*arg1\n[\s\S]*err\n/);
});
