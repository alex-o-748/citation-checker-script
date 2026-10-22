#!/usr/bin/env node
// Compares sweeps with each other, from their run records (service/sweep-runs.js).
//
// The post-run checks (service/sweep-checks.js) judge one run against fixed
// thresholds, which catches a run that broke. They cannot catch a slow drift,
// because every run along the way looks acceptable on its own: a publisher
// starting to refuse Toolforge, a model switch that moves the flag rate, ERROR
// rows creeping up. This report puts the runs of one wiki (or one scheduled
// series) side by side and compares the latest with the median of the runs
// before it.
//
// Only like is compared with like: the baseline is earlier runs that finished
// cleanly (status ok) with the same model and prompt version as the latest.
// A run after a model switch therefore says "not enough comparable runs" until
// the new model has a history, instead of reporting the switch as drift. The
// table still shows every run, so the switch itself is visible there.
//
// DRIFT_POINTS is a first guess, like sweep-checks.js's THRESHOLDS. Rates on
// a 25-article batch move by several points between runs on noise alone, so
// this only reports; nothing here changes an exit code. Recalibrate it once a
// series has a few months of runs.
//
// Usage:
//   node service/run-trends.js --wiki ruwiki                         # from ToolsDB (Toolforge)
//   node service/run-trends.js --wiki ruwiki --series ruwiki-weekly --limit 20
//   node service/run-trends.js --wiki ruwiki --from-dir sweeps       # from -run.json files, anywhere

import { parseArgs } from 'node:util';
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openToolsDbConnection } from './toolsdb.js';
import { makeQueryFn } from './replicas.js';
import { selectRecentRuns, RUN_STATUSES } from './sweep-runs.js';

export const DEFAULT_LIMIT = 12;
export const DEFAULT_BASELINE_SIZE = 5;
export const MIN_BASELINE = 3;
export const DRIFT_POINTS = 0.10;

const ratio = (num, den) => (Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : null);
const sum = (...values) => (values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null);

// The rates compared across runs. `drift: true` ones are compared with the
// baseline; the rest are shown only. Each denominator is the population the
// rate is about, so a run with more fetch failures doesn't look like a run
// with fewer flags.
export const RATES = Object.freeze([
    { key: 'flagged', label: 'flag', drift: true,
      of: r => ratio(sum(r.partially_supported, r.not_supported), sum(r.supported, r.partially_supported, r.not_supported)) },
    { key: 'notSupported', label: 'NS', drift: true,
      of: r => ratio(r.not_supported, sum(r.supported, r.partially_supported, r.not_supported)) },
    { key: 'unavailable', label: 'unav', drift: true, of: r => ratio(r.source_unavailable, r.rows_total) },
    { key: 'errors', label: 'err', drift: true, of: r => ratio(r.error_rows, r.rows_total) },
    { key: 'fetchFailed', label: 'fetchF', drift: true, of: r => ratio(r.fetch_failed, r.citations_with_url) },
    { key: 'ourFetchFailed', label: 'ourF', drift: true, of: r => ratio(r.our_fetch_failed, r.citations_with_url) },
    { key: 'truncated', label: 'trunc', drift: false, of: r => ratio(r.truncated, r.fetched) },
]);

/** Every rate for one run, null where the record can't support it. */
export function runRates(record) {
    const rates = Object.fromEntries(RATES.map(rate => [rate.key, rate.of(record)]));
    const started = record.started_at ? new Date(record.started_at) : null;
    const finished = record.finished_at ? new Date(record.finished_at) : null;
    return {
        ...rates,
        rowsPerArticle: ratio(record.rows_total, record.articles),
        tokensPerArticle: ratio(sum(record.tokens_in, record.tokens_out), record.articles),
        minutes: started && finished ? (finished - started) / 60000 : null,
    };
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const byStart = (a, b) => new Date(a.started_at) - new Date(b.started_at);

/**
 * Compares the newest finished run with the median of up to `baselineSize`
 * comparable runs before it. Returns { latest, baseline, drift, note }.
 */
export function compareToBaseline(records, {
    baselineSize = DEFAULT_BASELINE_SIZE, minBaseline = MIN_BASELINE, driftPoints = DRIFT_POINTS,
} = {}) {
    // A run still going, or one with nothing counted (a failed pick, checks
    // skipped), has no rates to compare; the table still shows it.
    const counted = records
        .filter(r => r.status !== RUN_STATUSES.RUNNING && Number.isFinite(r.rows_total))
        .sort(byStart);
    const latest = counted.at(-1) ?? null;
    if (!latest) return { latest: null, baseline: [], drift: [], note: 'no finished run with counts yet' };

    const baseline = counted.slice(0, -1)
        .filter(r => r.status === RUN_STATUSES.OK && r.model === latest.model && r.prompt_version === latest.prompt_version)
        .slice(-baselineSize);
    if (baseline.length < minBaseline) {
        return {
            latest, baseline, drift: [],
            note: `not enough comparable runs to judge drift (${baseline.length} of ${minBaseline} needed: `
                + 'earlier runs that finished ok on the same model and prompt version)',
        };
    }

    const latestRates = runRates(latest);
    const drift = [];
    for (const rate of RATES.filter(r => r.drift)) {
        const value = latestRates[rate.key];
        const typical = median(baseline.map(r => runRates(r)[rate.key]));
        if (value === null || typical === null) continue;
        if (Math.abs(value - typical) >= driftPoints) {
            drift.push({ key: rate.key, label: rate.label, latest: value, median: typical, delta: value - typical });
        }
    }
    return { latest, baseline, drift, note: null };
}

const pct = value => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value, digits = 0) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));
const when = value => (value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '—');

/** A plain-text table, newest run last, then the drift verdict. */
export function renderTrends(records, comparison, { wiki, series = null } = {}) {
    const rows = records.slice().sort(byStart).map(r => {
        const rates = runRates(r);
        return [
            when(r.started_at), r.status ?? '—', r.model ?? '—', num(r.articles), num(r.rows_total),
            ...RATES.map(rate => pct(rates[rate.key])),
            num(rates.tokensPerArticle), num(rates.minutes),
        ];
    });
    const header = ['started (UTC)', 'status', 'model', 'art', 'rows', ...RATES.map(r => r.label), 'tok/art', 'min'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => String(row[i]).length)));
    const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();

    const out = [`Sweep runs: ${wiki}${series ? ` · series ${series}` : ''} · ${records.length} run(s)`, ''];
    if (!rows.length) return [...out, 'No runs recorded.'].join('\n') + '\n';
    out.push(line(header), line(widths.map(w => '-'.repeat(w))), ...rows.map(line), '');
    out.push('flag/NS: share of judged verdicts (S + PS + NS) flagged / NOT SUPPORTED · unav, err: share of rows ·');
    out.push('fetchF, ourF: share of citations with a URL whose fetch failed / failed in our own fetcher · trunc: share of fetched sources', '');

    const latest = comparison.latest ? `the run of ${when(comparison.latest.started_at)}` : null;
    if (comparison.note) {
        out.push(`Drift: ${comparison.note}${latest ? ` (comparing ${latest})` : ''}.`);
    } else if (!comparison.drift.length) {
        out.push(`Drift: none — ${latest} is within ${DRIFT_POINTS * 100} points of the median of the `
            + `${comparison.baseline.length} comparable run(s) before it on every rate.`);
    } else {
        out.push(`Drift: ${latest} differs from the median of the ${comparison.baseline.length} comparable run(s) before it:`);
        for (const d of comparison.drift) {
            out.push(`  ${d.label}: ${pct(d.latest)} vs ${pct(d.median)} (${d.delta > 0 ? '+' : ''}${(d.delta * 100).toFixed(1)} points)`);
        }
    }
    return out.join('\n') + '\n';
}

/**
 * Reads every *-run.json under `dir`, for a run made off Toolforge or a look
 * at runs without ToolsDB. Walks the tree itself rather than relying on
 * readdir's `recursive` option, which older Node 18 images lack.
 */
export async function loadRunsFromDir(dir, { wiki, series = null, readdir = fsReaddir, readFile = fsReadFile } = {}) {
    const records = [];
    const walk = async path => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
            const full = join(path, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith('-run.json')) {
                try {
                    records.push(JSON.parse(await readFile(full, 'utf8')));
                } catch {
                    // a half-written or foreign file; one bad record shouldn't hide the rest
                }
            }
        }
    };
    await walk(dir);
    return records.filter(r => r.wiki === wiki && (!series || r.series === series));
}

export const HELP_TEXT = `usage: node service/run-trends.js --wiki <db> [options]

Shows recent sweeps side by side (verdict shares, fetch failures, ERROR rows,
tokens per article, duration) and compares the latest finished run with the
median of the comparable runs before it. Reads the run records run-sweep.js
writes: from ToolsDB's sweep_runs table by default, or from -run.json files.

Options:
  --wiki <db>          Wiki database name, e.g. ruwiki. Required.
  --series <name>      Only runs of this scheduled series, e.g. ruwiki-weekly.
  --limit <n>          How many recent runs to show (default: ${DEFAULT_LIMIT}).
  --from-dir <path>    Read *-run.json files under this directory instead of
                        ToolsDB, e.g. the scheduled job's --out-dir.
  --help, -h           Show this help and exit.

Drift is reported when a rate moved ${DRIFT_POINTS * 100} or more points from the median of up to
${DEFAULT_BASELINE_SIZE} earlier runs that finished ok on the same model and prompt version (at least
${MIN_BASELINE} needed). It is a report, not a check: the exit code is 0 either way.
`;

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            wiki: { type: 'string' },
            series: { type: 'string' },
            limit: { type: 'string', default: String(DEFAULT_LIMIT) },
            'from-dir': { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });
    return {
        help: values.help,
        wiki: values.wiki,
        series: values.series ?? null,
        limit: Number(values.limit),
        fromDir: values['from-dir'] ?? null,
    };
}

export async function runTrends(opts, {
    stdout = process.stdout,
    stderr = process.stderr,
    connectToolsDb = openToolsDbConnection,
    loadFromDir = loadRunsFromDir,
} = {}) {
    if (!opts.wiki) {
        stderr.write('trends: --wiki is required\n');
        return 2;
    }
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
        stderr.write('trends: --limit must be a positive integer\n');
        return 2;
    }

    let records;
    try {
        if (opts.fromDir) {
            records = (await loadFromDir(opts.fromDir, { wiki: opts.wiki, series: opts.series }))
                .sort(byStart).slice(-opts.limit);
        } else {
            const connection = await connectToolsDb();
            try {
                records = await selectRecentRuns(makeQueryFn(connection), {
                    wiki: opts.wiki, series: opts.series, limit: opts.limit,
                });
            } finally {
                await connection.end();
            }
        }
    } catch (error) {
        stderr.write(`trends: could not read run records: ${error.message}\n`);
        return 1;
    }

    stdout.write(renderTrends(records, compareToBaseline(records), { wiki: opts.wiki, series: opts.series }));
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const opts = parseCliArgs(process.argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
    } else {
        process.exitCode = await runTrends(opts);
    }
}
