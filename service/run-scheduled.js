#!/usr/bin/env node
// The scheduled sweep: one command a Toolforge cron job can run unattended
// (service/jobs.yaml). It picks a fresh batch, sweeps it, and prints how the
// run compares with the ones before it:
//
//   lock -> run-pick-pilot.js -> run-sweep.js -> run-trends.js -> unlock
//
// Every run gets its own directory, named by its run id, holding everything
// it produced:
//
//   <out-dir>/<wiki>/<run-id>/
//     titles.txt, scores.json        the pick (what was chosen, and why)
//     findings.csv, -clean.csv       the sweep's findings
//     findings-checks.md/.json, findings-review.csv   the post-run checks
//     findings-run.json              the run record (also in ToolsDB's sweep_runs)
//     run.log                        this run's whole log
//
// Nothing here decides which articles to check. run-pick-pilot.js leaves out
// every article ToolsDB already has findings for, and run-sweep.js stores
// every finding, so consecutive runs cover new ground on their own.
//
// The lock. The Toolforge jobs framework documents nothing that stops a
// scheduled run from starting while the previous one is still going (checked
// against Help:Toolforge/Running_jobs, 2026-10-22), and two overlapping runs
// would pick the same articles (neither has stored its findings yet). So a
// run takes <out-dir>/<wiki>/scheduled.lock first and exits 6 if another run
// holds it. A lock older than --lock-stale-hours is taken over: that is a run
// killed by the job timeout or an OOM, which never got to release it. Keep
// --lock-stale-hours above the job's timeout.
//
// Exit codes, so `emails: onfailure` mails about anything worth reading:
//   0  the sweep finished and passed its checks
//   1  pick or sweep failed outright (unreachable service, I/O)
//   2  bad arguments
//   3  the model returned an auth/billing error (run-sweep.js)
//   4  the model service kept failing (run-sweep.js)
//   5  the sweep finished but a post-run check failed: read findings-checks.md
//   6  another scheduled run on this wiki still holds the lock
// The pick's own failure codes pass through too: it exits 1 when nothing is
// left to pick, which is also worth an email.
//
// Usage (in the tool's home directory, where Toolforge jobs start):
//   ./citation-checker-script/service/run-scheduled.js --wiki ruwiki \
//       --provider liftwing-safeguard --series ruwiki-weekly --max 25

import { parseArgs } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile, unlink as fsUnlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPickPilot, parseCliArgs as parsePickArgs } from './run-pick-pilot.js';
import { runSweep, parseCliArgs as parseSweepArgs } from './run-sweep.js';
import { runTrends } from './run-trends.js';
import {
    RUN_STATUSES, newRunId, codeVersion, buildRunRecord, upsertRun, runJsonPath,
} from './sweep-runs.js';
import { openToolsDbConnection } from './toolsdb.js';
import { makeQueryFn } from './replicas.js';
import { PROVIDER_MODELS } from './provider-config.js';
import { DEFAULT_FETCH_CONCURRENCY } from './host-pool.js';
import { PROMPT_VERSION } from '../core/prompts.js';

export const LOCK_BUSY = 6;
export const DEFAULT_MAX = 25;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_LOCK_STALE_HOURS = 24;
const TREND_RUNS = 8;

export const HELP_TEXT = `usage: service/run-scheduled.js --wiki <db> --provider <name> [options]

Picks a batch of articles not checked before, sweeps it with live source
fetching, stores the findings and the run's record in ToolsDB, and prints how
the run compares with earlier ones. Made for a Toolforge cron job
(service/jobs.yaml); needs Wiki Replicas and ToolsDB, so it runs on Toolforge
only.

Options:
  --wiki <db>              Wiki database name, e.g. ruwiki. Required.
  --provider <name>        Model provider, one of: ${Object.keys(PROVIDER_MODELS).join(', ')}.
                            Required, so a change to run-sweep.js's default
                            can't swap the model in the middle of a series.
  --model <id>             Override the provider's default model.
  --worker-base <url>      Passed to run-sweep.js.
  --series <name>          The series this run belongs to (default: <wiki>-scheduled).
                            run-trends.js compares runs within a series.
  --max <n>                Articles per run (default: ${DEFAULT_MAX}).
  --concurrency <n>        Model calls at once (default: ${DEFAULT_CONCURRENCY}).
  --fetch-concurrency <n>  Sources fetched at once, one per host (default: ${DEFAULT_FETCH_CONCURRENCY}).
  --severity               Run the severity pass on flagged findings.
  --out-dir <path>         Where run directories go (default: sweeps). Relative
                            paths resolve from the working directory, which for
                            a Toolforge job is the tool's home.
  --lock-stale-hours <n>   Take over a lock older than this (default: ${DEFAULT_LOCK_STALE_HOURS}).
                            Keep it above the job's timeout.
  --help, -h               Show this help and exit.

Exit codes: 0 ok; 1 pick or sweep failed (including "nothing left to pick");
2 bad arguments; 3 model auth/billing error; 4 model service down; 5 a post-run
check failed; 6 another run on this wiki holds the lock.
`;

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            wiki: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            'worker-base': { type: 'string' },
            series: { type: 'string' },
            max: { type: 'string', default: String(DEFAULT_MAX) },
            concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
            'fetch-concurrency': { type: 'string', default: String(DEFAULT_FETCH_CONCURRENCY) },
            severity: { type: 'boolean', default: false },
            'out-dir': { type: 'string', default: 'sweeps' },
            'lock-stale-hours': { type: 'string', default: String(DEFAULT_LOCK_STALE_HOURS) },
            help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });
    return {
        help: values.help,
        wiki: values.wiki,
        provider: values.provider,
        model: values.model,
        workerBase: values['worker-base'],
        series: values.series ?? (values.wiki ? `${values.wiki}-scheduled` : undefined),
        max: Number(values.max),
        concurrency: Number(values.concurrency),
        fetchConcurrency: Number(values['fetch-concurrency']),
        severity: values.severity,
        outDir: values['out-dir'],
        lockStaleHours: Number(values['lock-stale-hours']),
    };
}

function validate(opts, stderr) {
    if (!opts.wiki) return stderr.write('scheduled: --wiki is required\n'), false;
    if (!opts.provider) return stderr.write('scheduled: --provider is required\n'), false;
    if (!(opts.provider in PROVIDER_MODELS)) {
        return stderr.write(`scheduled: unknown --provider ${opts.provider}\n`), false;
    }
    for (const [flag, value] of [['max', opts.max], ['concurrency', opts.concurrency],
        ['fetch-concurrency', opts.fetchConcurrency]]) {
        if (!Number.isInteger(value) || value < 1) {
            return stderr.write(`scheduled: --${flag} must be a positive integer\n`), false;
        }
    }
    if (!(opts.lockStaleHours > 0)) return stderr.write('scheduled: --lock-stale-hours must be positive\n'), false;
    return true;
}

/**
 * Takes the per-wiki lock. Returns { acquired: true, tookOver } or
 * { acquired: false, holder }. Created with O_EXCL ('wx'), which NFS (the
 * tool's home) honours, so two runs racing for it can't both win.
 */
export async function acquireLock(path, {
    runId, now = () => new Date(), staleMs,
    writeFile = fsWriteFile, readFile = fsReadFile,
}) {
    const body = JSON.stringify({ runId, startedAt: now().toISOString(), host: hostname(), pid: process.pid }) + '\n';
    try {
        await writeFile(path, body, { flag: 'wx' });
        return { acquired: true, tookOver: null };
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try {
        holder = JSON.parse(await readFile(path, 'utf8'));
    } catch {
        holder = null; // unreadable: treat as stale rather than block every run forever
    }
    const startedAt = holder?.startedAt ? new Date(holder.startedAt) : null;
    const age = startedAt && !Number.isNaN(startedAt.getTime()) ? now() - startedAt : Infinity;
    if (age < staleMs) return { acquired: false, holder };
    await writeFile(path, body);
    return { acquired: true, tookOver: holder ?? {} };
}

/** Removes the lock, but only if it is still this run's. */
export async function releaseLock(path, { runId, readFile = fsReadFile, unlink = fsUnlink }) {
    try {
        const holder = JSON.parse(await readFile(path, 'utf8'));
        if (holder.runId !== runId) return false;
        await unlink(path);
        return true;
    } catch {
        return false;
    }
}

// Writes every line to the job's own stream and to the run's log file.
function tee(stream, log) {
    return { write: chunk => { stream.write(chunk); log.write(chunk); return true; } };
}

export async function runScheduled(opts, {
    stdout = process.stdout,
    stderr = process.stderr,
    now = () => new Date(),
    mkdir = fsMkdir,
    writeFile = fsWriteFile,
    readFile = fsReadFile,
    unlink = fsUnlink,
    // A log that can't be written (a full disk) must not take the run down
    // with an unhandled 'error' event: the job's own output still has it all.
    openLog = path => createWriteStream(path, { flags: 'a' }).on('error', () => {}),
    pickFn = runPickPilot,
    sweepFn = runSweep,
    trendsFn = runTrends,
    connectToolsDb = openToolsDbConnection,
    codeVersionFn = codeVersion,
} = {}) {
    if (!validate(opts, stderr)) return 2;

    const startedAt = now();
    const runId = newRunId(opts.wiki, { now: startedAt });
    const wikiDir = join(opts.outDir, opts.wiki);
    const runDir = join(wikiDir, runId);
    const paths = {
        lock: join(wikiDir, 'scheduled.lock'),
        titles: join(runDir, 'titles.txt'),
        scores: join(runDir, 'scores.json'),
        findings: join(runDir, 'findings.csv'),
        log: join(runDir, 'run.log'),
    };

    await mkdir(wikiDir, { recursive: true });
    const lock = await acquireLock(paths.lock, {
        runId, now, staleMs: opts.lockStaleHours * 3600_000, writeFile, readFile,
    });
    if (!lock.acquired) {
        stderr.write(
            `scheduled: another run holds ${paths.lock} (${lock.holder?.runId ?? 'unknown run'}, `
            + `started ${lock.holder?.startedAt ?? 'at an unknown time'}); not starting. If that run is `
            + `still going, the schedule is shorter than a run; if it died, the lock is taken over once it is `
            + `${opts.lockStaleHours}h old.\n`
        );
        return LOCK_BUSY;
    }

    // A pick that fails still leaves a record, so "the batch didn't happen"
    // shows in sweep_runs and run-trends.js, not only in an email.
    async function recordPickFailure({ pickCode }) {
        const record = buildRunRecord({
            runId, series: opts.series, wiki: opts.wiki,
            status: RUN_STATUSES.PICK_FAILED, exitCode: pickCode, startedAt, finishedAt: now(),
            provider: opts.provider, model: opts.model ?? PROVIDER_MODELS[opts.provider],
            promptVersion: PROMPT_VERSION, codeVersion: await codeVersionFn(),
            selection: 'run-pick-pilot.js', outPath: paths.findings,
        });
        try {
            await writeFile(runJsonPath(paths.findings), JSON.stringify(record, null, 2) + '\n', 'utf8');
        } catch (error) {
            err.write(`scheduled: could not write the run record: ${error.message}\n`);
        }
        let connection = null;
        try {
            connection = await connectToolsDb();
            await upsertRun(makeQueryFn(connection), record);
        } catch (error) {
            err.write(`scheduled: could not record run ${runId} in ToolsDB: ${error.message}\n`);
        } finally {
            if (connection) await connection.end().catch(() => {});
        }
    }

    await mkdir(runDir, { recursive: true });
    const log = openLog(paths.log);
    const out = tee(stdout, log);
    const err = tee(stderr, log);
    let code;
    try {
        err.write(`scheduled: run ${runId} — ${opts.wiki}, series ${opts.series}, ${opts.max} article(s), `
            + `provider ${opts.provider}; files in ${runDir}\n`);
        if (lock.tookOver) {
            err.write(`scheduled: took over a stale lock from ${lock.tookOver.runId ?? 'an unknown run'} `
                + `(started ${lock.tookOver.startedAt ?? 'at an unknown time'}): that run was killed before it finished\n`);
        }

        // Each stage's own CLI parser builds its options, so a stage's
        // defaults are the same here as on the command line.
        const pickOpts = parsePickArgs([
            'node', 'run-pick-pilot.js', '--wiki', opts.wiki, '--max', String(opts.max),
            '--out', paths.titles, '--json-out', paths.scores,
        ]);
        const pickCode = await pickFn(pickOpts, { stdout: out, stderr: err });
        if (pickCode !== 0) {
            err.write(`scheduled: the pick exited ${pickCode}; no sweep this time\n`);
            await recordPickFailure({ pickCode });
            code = pickCode;
            return code;
        }

        const sweepOpts = parseSweepArgs([
            'node', 'run-sweep.js', '--wiki', opts.wiki, '--titles-file', paths.titles,
            '--live-source-fetch', '--provider', opts.provider,
            ...(opts.model ? ['--model', opts.model] : []),
            ...(opts.workerBase ? ['--worker-base', opts.workerBase] : []),
            '--concurrency', String(opts.concurrency), '--fetch-concurrency', String(opts.fetchConcurrency),
            ...(opts.severity ? ['--severity'] : []),
            '--run-id', runId, '--series', opts.series, '--out', paths.findings,
        ]);
        code = await sweepFn(sweepOpts, { stdout: out, stderr: err });

        // How this run sits among the series' earlier runs. A report only:
        // whatever it says, and whether it can be read at all, the exit code
        // is the sweep's.
        try {
            err.write('\n');
            await trendsFn({ wiki: opts.wiki, series: opts.series, limit: TREND_RUNS, fromDir: null },
                { stdout: out, stderr: err });
        } catch (error) {
            err.write(`scheduled: trends unavailable: ${error.message}\n`);
        }
        return code;
    } catch (error) {
        err.write(`scheduled: ${error.stack ?? error.message}\n`);
        code = 1;
        return code;
    } finally {
        err.write(`scheduled: run ${runId} finished with exit code ${code}; files in ${runDir}\n`);
        await releaseLock(paths.lock, { runId, readFile, unlink });
        await new Promise(resolve => (typeof log.end === 'function' ? log.end(resolve) : resolve()));
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const opts = parseCliArgs(process.argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
    } else {
        // process.exit rather than exitCode, as run-sweep.js's own entry point
        // does: a keep-alive socket left open by a stage must not keep a
        // finished job's pod running.
        runScheduled(opts).then(code => process.exit(code));
    }
}
