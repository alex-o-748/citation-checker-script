// The run record: one row per sweep in ToolsDB's sweep_runs table
// (service/migrations/006-sweep-runs.sql), and the same record as JSON beside
// the findings CSV (<name>-run.json).
//
// Why it exists: a sweep's numbers used to live only in its job log and in
// the -checks.json beside its CSV, and no finding said which run wrote it. A
// single run could be read, but not compared with the run before it, which is
// the question a scheduled series keeps asking: did the flag rate move when
// the model changed, is a publisher starting to refuse Toolforge, are ERROR
// rows creeping up. service/run-trends.js reads these records.
//
// Two kinds of number, kept apart on purpose:
//
// - Whole-CSV counts (rows, verdicts, fetch failures, tokens) are copied from
//   the post-run checks' metrics (service/sweep-checks.js), which stream the
//   entire file. A run picked back up with --resume keeps its run id (read
//   from the -run.json) and so is one record, counted once.
// - Per-process counters (the funnel, timing, retries, ToolsDB writes) only
//   know what this process did. They go into `details`, not columns: they
//   are for reading one run, not for comparing many.
//
// Like findings-store.js, the SQL is built by pure functions and the I/O is a
// thin shim with an injected query function.

import { randomBytes } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUN_STATUSES = Object.freeze({
    RUNNING: 'running',
    OK: 'ok',
    CHECKS_FAILED: 'checks_failed',
    HALTED: 'halted',
    FAILED: 'failed',
    PICK_FAILED: 'pick_failed',
});

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A run id that sorts by time and names its wiki: ruwiki-20261027T031700Z-3f9a.
 * The random suffix keeps two runs started in the same second apart.
 */
export function newRunId(wiki, { now = new Date(), suffix = randomBytes(2).toString('hex') } = {}) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `${wiki}-${stamp}-${suffix}`;
}

/** Maps run-sweep.js's exit codes (see its HELP_TEXT) onto a status. */
export function statusForExitCode(code) {
    if (code === 0) return RUN_STATUSES.OK;
    if (code === 5) return RUN_STATUSES.CHECKS_FAILED;
    if (code === 3 || code === 4) return RUN_STATUSES.HALTED;
    return RUN_STATUSES.FAILED;
}

/** `<name>-run.json` beside the findings CSV, like run-checks.js's checksPaths(). */
export function runJsonPath(csvPath) {
    const extension = extname(csvPath);
    const base = extension ? csvPath.slice(0, -extension.length) : csvPath;
    return `${base}-run.json`;
}

/**
 * The commit the running code is at, read straight from .git so it needs no
 * git binary (a Toolforge job image may not have one). null when it can't be
 * told — a tarball deploy, an unusual ref layout — rather than a guess.
 */
export async function codeVersion({ repoDir = REPO_ROOT, readFile = fsReadFile } = {}) {
    const sha = /^[0-9a-f]{40}$/;
    try {
        const head = (await readFile(join(repoDir, '.git', 'HEAD'), 'utf8')).trim();
        if (sha.test(head)) return head;
        const ref = head.match(/^ref: (\S+)$/)?.[1];
        if (!ref) return null;
        try {
            const loose = (await readFile(join(repoDir, '.git', ref), 'utf8')).trim();
            if (sha.test(loose)) return loose;
        } catch { /* not a loose ref; try packed-refs */ }
        const packed = await readFile(join(repoDir, '.git', 'packed-refs'), 'utf8');
        for (const line of packed.split('\n')) {
            const [hash, name] = line.trim().split(' ');
            if (name === ref && sha.test(hash)) return hash;
        }
        return null;
    } catch {
        return null;
    }
}

const count = value => (Number.isFinite(value) ? value : null);

/**
 * Builds the record. `checks` is service/run-checks.js's result (or null when
 * the checks were skipped or could not run, which leaves the whole-CSV
 * columns null rather than zero — "not counted" must not read as "none").
 */
export function buildRunRecord({
    runId, series = null, wiki, status, exitCode = null, startedAt, finishedAt = null,
    provider = null, model = null, promptVersion = null, codeVersion: version = null,
    selection = null, outPath = null, articlesPlanned = null,
    checks = null, processStats = null,
}) {
    const m = checks?.metrics ?? null;
    const verdicts = m?.verdicts ?? {};
    const verdict = name => (m ? verdicts[name] ?? 0 : null);
    const flaggedChecks = (checks?.checks ?? [])
        .filter(c => c.level === 'fail' || c.level === 'warn')
        .map(c => `${c.level}:${c.id}`);
    return {
        run_id: runId,
        series,
        wiki,
        status,
        exit_code: exitCode,
        started_at: startedAt,
        finished_at: finishedAt,
        provider,
        model,
        prompt_version: promptVersion,
        code_version: version,
        selection,
        out_path: outPath,
        articles_planned: count(articlesPlanned),
        articles: count(m?.articles),
        rows_total: count(m?.rows),
        model_rows: count(m?.modelRows),
        supported: verdict('SUPPORTED'),
        partially_supported: verdict('PARTIALLY SUPPORTED'),
        not_supported: verdict('NOT SUPPORTED'),
        source_unavailable: verdict('SOURCE UNAVAILABLE'),
        error_rows: verdict('ERROR'),
        skipped_rows: verdict('SKIPPED'),
        citations_with_url: count(m?.citationsWithUrl),
        fetched: count(m?.fetched),
        fetch_failed: count(m?.fetchFailed),
        our_fetch_failed: count(m?.ourFetchFailed),
        truncated: count(m?.truncated),
        tokens_in: count(m?.tokenTotals?.in),
        tokens_out: count(m?.tokenTotals?.out),
        checks_status: checks?.status ?? null,
        checks_flagged: flaggedChecks.length ? flaggedChecks.join(' ') : null,
        details: {
            process: processStats,
            verdicts: m ? verdicts : null,
            errorReasons: m?.errorReasons ?? null,
            fetchFailureKinds: m?.fetchFailureKinds ?? null,
            checks: (checks?.checks ?? []).map(c => ({ id: c.id, level: c.level, summary: c.summary })),
        },
    };
}

// Column order for the INSERT; every column but run_id is updated on a
// duplicate, so the same call records a run's start and, later, its finish.
export const RUN_COLUMNS = Object.freeze([
    'run_id', 'series', 'wiki', 'status', 'exit_code', 'started_at', 'finished_at',
    'provider', 'model', 'prompt_version', 'code_version', 'selection', 'out_path',
    'articles_planned', 'articles', 'rows_total', 'model_rows',
    'supported', 'partially_supported', 'not_supported', 'source_unavailable', 'error_rows', 'skipped_rows',
    'citations_with_url', 'fetched', 'fetch_failed', 'our_fetch_failed', 'truncated',
    'tokens_in', 'tokens_out', 'checks_status', 'checks_flagged', 'details',
]);

// Accepts a Date or the ISO string a -run.json carries.
const asDate = value => (value === null || value === undefined ? null : new Date(value));

export function buildRunUpsertQuery(record) {
    const sql = `INSERT INTO sweep_runs (${RUN_COLUMNS.join(', ')})\n`
        + `VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})\n`
        + 'ON DUPLICATE KEY UPDATE\n'
        + RUN_COLUMNS.slice(1).map(c => `    ${c} = VALUES(${c})`).join(',\n');
    const params = RUN_COLUMNS.map(column => {
        if (column === 'started_at' || column === 'finished_at') return asDate(record[column]);
        if (column === 'details') return record.details ? JSON.stringify(record.details) : null;
        return record[column] ?? null;
    });
    return { sql, params };
}

export async function upsertRun(query, record) {
    const { sql, params } = buildRunUpsertQuery(record);
    return query(sql, params);
}

/** The most recent runs for a wiki (and series, when given), newest first. */
export async function selectRecentRuns(query, { wiki, series = null, limit = 20 }) {
    const where = series ? 'wiki = ? AND series = ?' : 'wiki = ?';
    const params = series ? [wiki, series] : [wiki];
    // LIMIT is inlined, not bound: mysql2's prepared statements reject a
    // bound LIMIT on some server versions. It is an integer we validated.
    const rows = await query(
        `SELECT * FROM sweep_runs WHERE ${where} ORDER BY started_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
        params,
    );
    return rows.map(recordFromRow);
}

// VARBINARY columns come back from mysql2 as Buffers; the record carries
// strings, and `details` its parsed JSON.
export function recordFromRow(row) {
    const record = {};
    for (const [key, value] of Object.entries(row)) {
        record[key] = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    }
    if (typeof record.details === 'string') {
        try { record.details = JSON.parse(record.details); } catch { record.details = null; }
    }
    return record;
}

/**
 * The schema check a storing sweep makes before doing any work: without
 * migration 006 every finding's write would fail (unknown column run_id), and
 * a sweep that keeps going regardless — the right call for a transient
 * database error — would store nothing for hours. Returns an error message
 * when the schema is missing, null otherwise. Any other error (a connection
 * blip) is not a missing schema, and is left to the per-write handling.
 */
export async function missingRunSchema(query) {
    for (const sql of [
        'SELECT run_id FROM citation_findings LIMIT 0',
        'SELECT run_id FROM sweep_runs LIMIT 0',
    ]) {
        try {
            await query(sql, []);
        } catch (error) {
            if (error?.code === 'ER_BAD_FIELD_ERROR' || error?.code === 'ER_NO_SUCH_TABLE'
                || /Unknown column|doesn't exist/i.test(error?.message ?? '')) {
                return `ToolsDB is missing the run columns (${error.message}); `
                    + 'apply service/migrations/006-sweep-runs.sql first, or pass --no-store';
            }
        }
    }
    return null;
}
