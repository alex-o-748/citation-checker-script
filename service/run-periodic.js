#!/usr/bin/env node
// One unattended batch run: pick -> sweep -> delivery file -> second-model
// rechecks -> review, each step a child process, written into one dated run
// directory. This is what a scheduled Toolforge job calls
// (service/jobs.yaml); every step is still runnable by hand, and this file
// adds no verification logic of its own — only the order, the file names
// handed from one step to the next, and what a step's exit code means for the
// rest of the run.
//
// Why child processes rather than importing each runner's main(): memory.
// Every step is a long, allocation-heavy pass (the November 2026 ruwiki
// rerun's sweep and import were each OOM-killed once), and a fresh process
// per step hands all of it back before the next one starts.
//
// The steps, and the file each one leaves in the run directory:
//
//   pick      service/run-pick-pilot.js   titles.txt (+ pick.json)
//   sweep     service/run-sweep.js        findings.csv, findings-clean.csv,
//                                         findings-checks.md/.json, findings-review.csv
//   deliver   service/clean-csv.js        findings-deliver-<tier>.csv
//   recheck-* service/run-recheck.js      recheck-<prefix>.csv, recheck-<prefix>-kept.csv
//                                         — each pass reads the previous pass's
//                                         kept file, so the last one holds only
//                                         flags every model agreed on
//   review    scripts/review-sweep.js     review.md, review-sample.csv
//
// plus run.json (each step's status, exit code and time; what --resume reads)
// and summary.md (the counts, and what to read first).
//
// What a step's exit code means for the run:
//   - sweep exiting 5 (a post-run check failed) does not stop the run: the
//     CSV is complete, and 5 means "read the checks first". The later steps
//     still run, and the run itself exits 5 at the end, so a job submitted
//     with emails: onfailure says so.
//   - any other non-zero exit from pick, sweep, deliver or a recheck stops the
//     run with that code (3 = model auth/billing, 4 = model service down,
//     as run-sweep.js defines them).
//   - review is informational: its failure is reported, never fatal.
//
// Two runs never overlap: a sweep can take longer than the schedule's period,
// so a lock file in the runs directory makes the second one exit 6.
//
// The re-check policy is unchanged: run-pick-pilot.js leaves out every
// article that already has a stored finding for the wiki, so each run checks
// new articles only. Nothing here re-checks an article whose finding has
// expired or whose text has changed since.
//
// Usage:
//   node service/run-periodic.js --wiki ruwiki --max 100
//   node service/run-periodic.js --wiki ruwiki --sweep-arg=--lead-check --sweep-arg=--concurrency=8
//   node service/run-periodic.js --wiki ruwiki --resume 2026-11-30T0300Z
//   node service/run-periodic.js --wiki ruwiki --dry-run

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, open, unlink, access, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { iterateCsvRows } from './csv-stream.js';
import { cleanCsvPath } from './csv-report.js';
import { checksPaths } from './run-checks.js';
import { deliverCsvPath } from './clean-csv.js';
import { DELIVERY_TIER_NAMES } from './delivery-filter.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Two rules restated from the runners rather than imported, because importing
// run-recheck.js or run-sweep.js loads the whole verification stack (jsdom,
// sentencex, mysql2) into a process that only spawns them.
// tests/run-periodic.test.js fails if either original changes.
//   run-recheck.js's keptCsvPath(): where a pass writes the rows it kept.
export function keptCsvPath(out) {
    return out.replace(/\.csv$/, '') + '-kept.csv';
}
//   run-sweep.js's parseTitlesFile(): one title per line, # comments skipped.
export function parseTitlesFile(text) {
    return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

// The two-model agreement measured on the 50 hand-labelled ruwiki
// contradictions (benchmark/contradiction-spotcheck-2026-11*.csv): Qwen3-32B
// and GLM-5.2 each reach 73% precision there but err on different rows, and
// keeping only flags both call NOT SUPPORTED reaches 83%. Both go through
// tf-llm-router's /hf route; GLM-5.2 must be on the router's allowlist.
export const DEFAULT_RECHECK_PASSES = Object.freeze([
    Object.freeze({ prefix: 'qwen', provider: 'huggingface', model: 'Qwen/Qwen3-32B' }),
    Object.freeze({ prefix: 'glm', provider: 'huggingface', model: 'zai-org/GLM-5.2' }),
]);
export const DEFAULT_RECHECK_WORKER_BASE = 'https://llm-router.toolforge.org';

// The tier the recheck was measured on: NOT SUPPORTED / contradiction with
// the contradicting passage verified in the source.
export const DEFAULT_DELIVER_TIER = 'verified-contradiction';

// A lock older than this is assumed to belong to a job that was killed
// without cleaning up (an OOM kill runs no finally block) and is taken over.
// Longer than any sweep has taken, shorter than a weekly schedule's period.
export const DEFAULT_STALE_LOCK_HOURS = 72;

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, CHECKS_FAILED: 5, LOCKED: 6 });

export const HELP_TEXT = `usage: node service/run-periodic.js --wiki <db> [options]

Runs one unattended batch into a new dated directory: picks articles not yet
checked, sweeps them with live source fetching, writes the delivery file, and
rechecks its flags with a second (and third) model. Meant to be run by a
scheduled Toolforge job (service/jobs.yaml).

Options:
  --wiki <db>             Wiki database name, e.g. ruwiki (required)
  --max <n>               Articles to pick (default: 100)
  --runs-dir <path>       Where run directories go (default: ~/sweeps/<wiki>)
  --run-id <id>           Name of this run's directory (default: the UTC time,
                          e.g. 2026-11-30T0300Z)
  --resume <id>           Continue the run in <runs-dir>/<id>: steps that
                          finished are skipped, and the sweep and recheck
                          steps continue into their existing output.
  --deliver-tier <name>   Delivery tier (default: ${DEFAULT_DELIVER_TIER}). One of:
                          ${DELIVERY_TIER_NAMES.join(', ')}
  --recheck <spec>        A recheck pass, as prefix:provider:model. Repeatable;
                          passes run in order, each on the previous one's kept
                          rows. Replaces the default passes:
                          ${DEFAULT_RECHECK_PASSES.map(formatRecheckSpec).join('\n                          ')}
  --recheck-worker-base <url>
                          Model route for the rechecks (default: ${DEFAULT_RECHECK_WORKER_BASE})
  --no-recheck            Skip the recheck passes; the delivery file is final.
  --no-review             Skip scripts/review-sweep.js.
  --pick-arg=<arg>        Extra argument for run-pick-pilot.js. Repeatable.
  --sweep-arg=<arg>       Extra argument for run-sweep.js, e.g.
                          --sweep-arg=--lead-check --sweep-arg=--concurrency=8.
                          Repeatable. Use the = form: the value starts with --.
  --stale-lock-hours <n>  Take over a lock older than this (default: ${DEFAULT_STALE_LOCK_HOURS})
  --dry-run               Print the steps and exit without running anything.
  --help, -h              Show this help and exit.

Exit codes: 0 done; 5 done, but the sweep's post-run checks failed (read
findings-checks.md before using the files); 6 another run holds the lock;
any other code is the failing step's own (3 = model auth/billing,
4 = model service down; see run-sweep.js --help).
`;

export function formatRecheckSpec({ prefix, provider, model }) {
    return `${prefix}:${provider}:${model}`;
}

/** "prefix:provider:model" — the model id may itself contain colons. */
export function parseRecheckSpec(spec) {
    const first = spec.indexOf(':');
    const second = first < 0 ? -1 : spec.indexOf(':', first + 1);
    if (first <= 0 || second <= first + 1 || second === spec.length - 1) {
        throw new Error(`--recheck "${spec}" is not prefix:provider:model`);
    }
    const prefix = spec.slice(0, first);
    if (!/^[a-z][a-z0-9_]*$/i.test(prefix)) {
        throw new Error(`--recheck prefix "${prefix}" must be a column-name prefix (letters, digits, _)`);
    }
    return { prefix, provider: spec.slice(first + 1, second), model: spec.slice(second + 1) };
}

/** UTC minute, filesystem-safe: 2026-11-30T0300Z. */
export function defaultRunId(now = new Date()) {
    const iso = now.toISOString();
    return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/** Every file a run reads or writes, by role. */
export function runPaths(runDir, { deliverTier = DEFAULT_DELIVER_TIER, rechecks = DEFAULT_RECHECK_PASSES } = {}) {
    const findings = join(runDir, 'findings.csv');
    const passes = rechecks.map(pass => {
        const out = join(runDir, `recheck-${pass.prefix}.csv`);
        return { ...pass, out, kept: keptCsvPath(out) };
    });
    const deliver = deliverCsvPath(findings, deliverTier);
    return {
        runDir,
        state: join(runDir, 'run.json'),
        summary: join(runDir, 'summary.md'),
        titles: join(runDir, 'titles.txt'),
        pickJson: join(runDir, 'pick.json'),
        findings,
        clean: cleanCsvPath(findings),
        checks: checksPaths(findings).md,
        deliver,
        rechecks: passes,
        final: passes.length ? passes[passes.length - 1].kept : deliver,
        review: join(runDir, 'review'),
        reviewMd: join(runDir, 'review.md'),
    };
}

/**
 * The run's steps, in order. Each is { name, script, args, input?, fatal }:
 * `input` is a file the step reads, and a step whose input holds no rows is
 * skipped rather than run (an empty delivery file has nothing to recheck).
 * `resume` marks the steps that can continue into their own earlier output.
 */
export function buildSteps(opts, paths) {
    const steps = [
        {
            name: 'pick',
            script: 'service/run-pick-pilot.js',
            args: ['--wiki', opts.wiki, '--max', String(opts.max), '--out', paths.titles,
                '--json-out', paths.pickJson, ...opts.pickArgs],
            fatal: true,
        },
        {
            name: 'sweep',
            script: 'service/run-sweep.js',
            args: ['--wiki', opts.wiki, '--titles-file', paths.titles, '--live-source-fetch',
                '--out', paths.findings, ...opts.sweepArgs],
            input: { path: paths.titles, kind: 'titles' },
            resumable: true,
            fatal: true,
        },
        {
            name: 'deliver',
            script: 'service/clean-csv.js',
            args: [paths.findings, '--deliver', opts.deliverTier, '--out', paths.deliver],
            fatal: true,
        },
    ];
    let input = paths.deliver;
    for (const pass of paths.rechecks) {
        steps.push({
            name: `recheck-${pass.prefix}`,
            script: 'service/run-recheck.js',
            args: [input, '--provider', pass.provider, '--model', pass.model,
                '--worker-base', opts.recheckWorkerBase, '--wiki', opts.wiki,
                '--prefix', pass.prefix, '--out', pass.out],
            input: { path: input, kind: 'csv' },
            resumable: true,
            fatal: true,
        });
        input = pass.kept;
    }
    if (opts.review) {
        steps.push({
            name: 'review',
            script: 'scripts/review-sweep.js',
            args: [paths.findings, '--out', paths.review],
            fatal: false,
        });
    }
    return steps;
}

/**
 * What a step's exit code means for the rest of the run:
 * 'continue', 'checks-failed' (continue, but the run exits 5) or 'stop'.
 */
export function stepOutcome(step, code) {
    if (code === 0) return 'continue';
    if (step.name === 'sweep' && code === EXIT.CHECKS_FAILED) return 'checks-failed';
    return step.fatal ? 'stop' : 'continue';
}

/** The run's exit code, from its step records. */
export function runExitCode(records) {
    const stopped = records.find(r => r.outcome === 'stop');
    if (stopped) return stopped.code;
    return records.some(r => r.outcome === 'checks-failed') ? EXIT.CHECKS_FAILED : EXIT.OK;
}

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

/** Data rows in a CSV, or titles in a titles file; 0 for a missing file. */
export async function countRows(path, kind = 'csv', { readFileFn = readFile } = {}) {
    if (kind === 'titles') {
        try { return parseTitlesFile(await readFileFn(path, 'utf8')).length; } catch { return 0; }
    }
    if (!(await exists(path))) return 0;
    let n = 0;
    for await (const { row } of iterateCsvRows(path)) if (row) n++;
    return n;
}

/**
 * Takes the runs directory's lock, or reports who holds it. A lock older
 * than staleHours is taken over: a killed job leaves its lock behind.
 */
export async function acquireLock(lockPath, runId, { staleHours = DEFAULT_STALE_LOCK_HOURS, now = Date.now() } = {}) {
    const body = JSON.stringify({ runId, startedAt: new Date(now).toISOString(), host: hostname(), pid: process.pid });
    try {
        const handle = await open(lockPath, 'wx');
        await handle.writeFile(body);
        await handle.close();
        return { acquired: true };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try { holder = JSON.parse(await readFile(lockPath, 'utf8')); } catch { /* unreadable: judge by mtime */ }
    const startedAt = holder?.startedAt ? Date.parse(holder.startedAt) : (await stat(lockPath)).mtimeMs;
    const ageHours = (now - startedAt) / 3_600_000;
    if (ageHours < staleHours) return { acquired: false, holder, ageHours };
    await writeFile(lockPath, body);
    return { acquired: true, tookOver: holder, ageHours };
}

async function releaseLock(lockPath, runId) {
    try {
        const holder = JSON.parse(await readFile(lockPath, 'utf8'));
        if (holder.runId === runId) await unlink(lockPath);
    } catch { /* already gone, or someone else's */ }
}

// Runs one step as a child process from the repo root, its output going both
// to this process's stdout/stderr (the job's log) and to <runDir>/<step>.log.
export function spawnStep(step, logPath, { stdout, stderr }) {
    return new Promise(resolvePromise => {
        const log = createWriteStream(logPath, { flags: 'a' });
        const child = spawn(process.execPath, [step.script, ...step.args], {
            cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => { stdout.write(chunk); log.write(chunk); });
        child.stderr.on('data', chunk => { stderr.write(chunk); log.write(chunk); });
        child.on('error', error => {
            log.end(`run-periodic: could not start ${step.script}: ${error.message}\n`);
            resolvePromise(1);
        });
        child.on('close', (code, signal) => {
            if (signal) log.write(`run-periodic: ${step.name} killed by ${signal}\n`);
            log.end();
            resolvePromise(code ?? 1);
        });
    });
}

function rel(runDir, path) {
    return relative(runDir, path) || path;
}

/** summary.md: what ran, what it produced, what to read first. */
export function renderSummary({ opts, runId, paths, records, counts, exitCode }) {
    const lines = [`# ${opts.wiki} sweep ${runId}`, ''];
    const status = exitCode === EXIT.OK ? 'finished'
        : exitCode === EXIT.CHECKS_FAILED ? `finished, but the post-run checks failed: read ${rel(paths.runDir, paths.checks)} before using these files`
            : `stopped at ${records.find(r => r.outcome === 'stop')?.name} (exit ${exitCode})`;
    lines.push(`Status: ${status}.`, '');
    lines.push('| Step | Result | Exit | Minutes |', '| --- | --- | --- | --- |');
    for (const r of records) {
        const minutes = r.ms == null ? '' : (r.ms / 60000).toFixed(1);
        lines.push(`| ${r.name} | ${r.status}${r.note ? ` (${r.note})` : ''} | ${r.code ?? ''} | ${minutes} |`);
    }
    lines.push('', '| | Rows | File |', '| --- | --- | --- |');
    const row = (label, key, path) => {
        if (counts[key] != null) lines.push(`| ${label} | ${counts[key]} | ${rel(paths.runDir, path)} |`);
    };
    row('Articles picked', 'titles', paths.titles);
    row('Findings', 'findings', paths.findings);
    row(`Delivery tier (${opts.deliverTier})`, 'deliver', paths.deliver);
    for (const pass of paths.rechecks) row(`Kept by ${pass.prefix} (${pass.model})`, `kept-${pass.prefix}`, pass.kept);
    lines.push('', `Final delivery file: ${rel(paths.runDir, paths.final)}`);
    return lines.join('\n') + '\n';
}

async function loadState(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export async function runPeriodic(opts, io = {}) {
    const { stdout = process.stdout, stderr = process.stderr, spawnStepFn = spawnStep, now = () => new Date() } = io;
    const runId = opts.resume ?? opts.runId ?? defaultRunId(now());
    const runDir = join(opts.runsDir, runId);
    const paths = runPaths(runDir, opts);
    const steps = buildSteps(opts, paths);

    if (opts.dryRun) {
        stdout.write(`run-periodic: would run into ${runDir}\n`);
        for (const step of steps) stdout.write(`  ${step.name}: node ${step.script} ${step.args.join(' ')}\n`);
        return EXIT.OK;
    }

    const previous = opts.resume ? await loadState(paths.state) : null;
    if (opts.resume && !previous) {
        stderr.write(`run-periodic: nothing to resume at ${paths.state}\n`);
        return EXIT.USAGE;
    }
    if (!opts.resume && await exists(runDir)) {
        stderr.write(`run-periodic: ${runDir} already exists; pass --resume ${runId} to continue it\n`);
        return EXIT.USAGE;
    }

    await mkdir(opts.runsDir, { recursive: true });
    const lockPath = join(opts.runsDir, '.lock');
    const lock = await acquireLock(lockPath, runId, { staleHours: opts.staleLockHours, now: now().getTime() });
    if (!lock.acquired) {
        stderr.write(`run-periodic: run ${lock.holder?.runId ?? '(unknown)'} has held ${lockPath} for `
            + `${lock.ageHours.toFixed(1)} h; not starting. Delete the file if that run is gone.\n`);
        return EXIT.LOCKED;
    }
    if (lock.tookOver) {
        stderr.write(`run-periodic: took over a ${lock.ageHours.toFixed(1)} h old lock from run ${lock.tookOver?.runId ?? '(unknown)'}\n`);
    }

    try {
        await mkdir(runDir, { recursive: true });
        // A sweep whose checks failed finished its CSV: resuming doesn't redo it.
        const done = new Set((previous?.steps ?? [])
            .filter(r => r.status === 'ok' || r.status === 'checks failed').map(r => r.name));
        const records = [];
        const counts = {};
        const saveState = () => writeFile(paths.state, JSON.stringify({
            runId, wiki: opts.wiki, startedAt: previous?.startedAt ?? now().toISOString(),
            options: { ...opts, resume: undefined }, steps: records,
        }, null, 2) + '\n');

        let stopped = false;
        for (const step of steps) {
            if (stopped) { records.push({ name: step.name, status: 'not run' }); continue; }
            if (done.has(step.name)) {
                records.push({ ...previous.steps.find(r => r.name === step.name) });
                stdout.write(`run-periodic: ${step.name} already done, skipping\n`);
                continue;
            }
            if (step.input) {
                const n = await countRows(step.input.path, step.input.kind);
                if (n === 0) {
                    const note = step.input.kind === 'titles' ? 'no articles picked' : 'nothing to recheck';
                    records.push({ name: step.name, status: 'skipped', note, outcome: 'continue' });
                    stdout.write(`run-periodic: skipping ${step.name}: ${note}\n`);
                    // With nothing picked there is nothing for any later step either.
                    if (step.input.kind === 'titles') stopped = true;
                    continue;
                }
            }
            const args = opts.resume && step.resumable && await exists(step.args[step.args.indexOf('--out') + 1])
                ? [...step.args, '--resume'] : step.args;
            stdout.write(`run-periodic: ${step.name}: node ${step.script} ${args.join(' ')}\n`);
            const started = Date.now();
            const code = await spawnStepFn({ ...step, args }, join(runDir, `${step.name}.log`), { stdout, stderr });
            const outcome = stepOutcome(step, code);
            const status = code === 0 ? 'ok' : outcome === 'checks-failed' ? 'checks failed' : 'failed';
            records.push({ name: step.name, status, code, outcome, ms: Date.now() - started });
            await saveState();
            if (outcome === 'stop') stopped = true;
        }

        counts.titles = await countRows(paths.titles, 'titles');
        for (const [key, path] of [['findings', paths.findings], ['deliver', paths.deliver]]) {
            if (await exists(path)) counts[key] = await countRows(path);
        }
        for (const pass of paths.rechecks) {
            if (await exists(pass.kept)) counts[`kept-${pass.prefix}`] = await countRows(pass.kept);
        }
        const exitCode = runExitCode(records);
        await saveState();
        const summary = renderSummary({ opts, runId, paths, records, counts, exitCode });
        await writeFile(paths.summary, summary);
        await writeFile(join(opts.runsDir, 'latest.json'), JSON.stringify({ runId, exitCode, summary: paths.summary }, null, 2) + '\n');
        stdout.write(`\n${summary}`);
        return exitCode;
    } finally {
        await releaseLock(lockPath, runId);
    }
}

export function parseOptions(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            wiki: { type: 'string' },
            max: { type: 'string', default: '100' },
            'runs-dir': { type: 'string' },
            'run-id': { type: 'string' },
            resume: { type: 'string' },
            'deliver-tier': { type: 'string', default: DEFAULT_DELIVER_TIER },
            recheck: { type: 'string', multiple: true },
            'recheck-worker-base': { type: 'string', default: DEFAULT_RECHECK_WORKER_BASE },
            'no-recheck': { type: 'boolean', default: false },
            'no-review': { type: 'boolean', default: false },
            'pick-arg': { type: 'string', multiple: true },
            'sweep-arg': { type: 'string', multiple: true },
            'stale-lock-hours': { type: 'string', default: String(DEFAULT_STALE_LOCK_HOURS) },
            'dry-run': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });
    if (values.help) return { help: true };
    if (!values.wiki || !/^[a-z_]+wiki$/.test(values.wiki)) throw new Error('--wiki is required, e.g. --wiki ruwiki');
    const max = Number(values.max);
    if (!Number.isInteger(max) || max < 1) throw new Error('--max must be a positive integer');
    if (!DELIVERY_TIER_NAMES.includes(values['deliver-tier'])) {
        throw new Error(`--deliver-tier must be one of ${DELIVERY_TIER_NAMES.join(', ')}`);
    }
    if (values['no-recheck'] && values.recheck) throw new Error('--recheck and --no-recheck contradict each other');
    const rechecks = values['no-recheck'] ? [] : values.recheck ? values.recheck.map(parseRecheckSpec) : [...DEFAULT_RECHECK_PASSES];
    const prefixes = rechecks.map(r => r.prefix);
    if (new Set(prefixes).size !== prefixes.length) throw new Error('each --recheck needs its own prefix');
    const staleLockHours = Number(values['stale-lock-hours']);
    if (!(staleLockHours > 0)) throw new Error('--stale-lock-hours must be positive');
    if (values.resume && values['run-id']) throw new Error('--resume names the run; drop --run-id');
    for (const id of [values.resume, values['run-id']]) {
        if (id != null && !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`run id "${id}" must be a plain directory name`);
    }
    return {
        wiki: values.wiki,
        max,
        runsDir: resolve(values['runs-dir'] ?? join(homedir(), 'sweeps', values.wiki)),
        runId: values['run-id'] ?? null,
        resume: values.resume ?? null,
        deliverTier: values['deliver-tier'],
        rechecks,
        recheckWorkerBase: values['recheck-worker-base'],
        review: !values['no-review'],
        pickArgs: values['pick-arg'] ?? [],
        sweepArgs: values['sweep-arg'] ?? [],
        staleLockHours,
        dryRun: values['dry-run'],
    };
}

export async function main(argv = process.argv.slice(2), io = {}) {
    const { stdout = process.stdout, stderr = process.stderr } = io;
    let opts;
    try {
        opts = parseOptions(argv);
    } catch (error) {
        stderr.write(`run-periodic: ${error.message}\n\n${HELP_TEXT}`);
        return EXIT.USAGE;
    }
    if (opts.help) { stdout.write(HELP_TEXT); return EXIT.OK; }
    return runPeriodic(opts, io);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then(code => { process.exitCode = code; }, error => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    });
}
