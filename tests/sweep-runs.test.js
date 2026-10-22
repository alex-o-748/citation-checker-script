import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    RUN_STATUSES,
    RUN_COLUMNS,
    newRunId,
    statusForExitCode,
    runJsonPath,
    codeVersion,
    buildRunRecord,
    buildRunUpsertQuery,
    upsertRun,
    selectRecentRuns,
    recordFromRow,
    missingRunSchema,
} from '../service/sweep-runs.js';

test('newRunId names the wiki and sorts by start time', () => {
    const id = newRunId('ruwiki', { now: new Date('2026-10-27T03:17:00.123Z'), suffix: '3f9a' });
    assert.equal(id, 'ruwiki-20261027T031700Z-3f9a');
    assert.match(newRunId('enwiki'), /^enwiki-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    const earlier = newRunId('ruwiki', { now: new Date('2026-10-20T03:17:00Z'), suffix: 'ffff' });
    assert.ok(earlier < id, 'string order is time order');
});

test('statusForExitCode follows run-sweep.js\'s exit codes', () => {
    assert.equal(statusForExitCode(0), RUN_STATUSES.OK);
    assert.equal(statusForExitCode(5), RUN_STATUSES.CHECKS_FAILED);
    assert.equal(statusForExitCode(3), RUN_STATUSES.HALTED);
    assert.equal(statusForExitCode(4), RUN_STATUSES.HALTED);
    assert.equal(statusForExitCode(1), RUN_STATUSES.FAILED);
    assert.equal(statusForExitCode(2), RUN_STATUSES.FAILED);
});

test('runJsonPath sits beside the CSV, like the checks files', () => {
    assert.equal(runJsonPath('sweeps/ruwiki/r1/findings.csv'), 'sweeps/ruwiki/r1/findings-run.json');
    assert.equal(runJsonPath('findings'), 'findings-run.json');
});

const fakeGit = files => async path => {
    const key = path.replace(/^.*\.git\//, '');
    if (!(key in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return files[key];
};
const SHA = 'a1e9759'.padEnd(40, '0');

test('codeVersion reads a branch head from a loose ref, a packed ref, or a detached HEAD', async () => {
    assert.equal(await codeVersion({ repoDir: '/r', readFile: fakeGit({
        HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${SHA}\n`,
    }) }), SHA);
    assert.equal(await codeVersion({ repoDir: '/r', readFile: fakeGit({
        HEAD: 'ref: refs/heads/main\n',
        'packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`,
    }) }), SHA);
    assert.equal(await codeVersion({ repoDir: '/r', readFile: fakeGit({ HEAD: `${SHA}\n` }) }), SHA);
});

test('codeVersion is null, not a guess, when it can\'t tell', async () => {
    assert.equal(await codeVersion({ repoDir: '/r', readFile: fakeGit({}) }), null);
    assert.equal(await codeVersion({ repoDir: '/r', readFile: fakeGit({ HEAD: 'ref: refs/heads/gone\n' }) }), null);
});

const base = {
    runId: 'ruwiki-r1', series: 'ruwiki-weekly', wiki: 'ruwiki',
    startedAt: new Date('2026-10-27T03:17:00Z'),
    provider: 'liftwing-safeguard', model: 'llm-gpt-oss-safeguard-20b', promptVersion: 'abc123',
    codeVersion: SHA, selection: 'titles-file:titles.txt', outPath: 'findings.csv', articlesPlanned: 25,
};

test('buildRunRecord before any counting leaves every count null, not zero', () => {
    const record = buildRunRecord({ ...base, status: RUN_STATUSES.RUNNING });
    assert.equal(record.status, 'running');
    assert.equal(record.articles_planned, 25);
    for (const column of ['articles', 'rows_total', 'supported', 'not_supported', 'error_rows', 'fetched', 'tokens_in']) {
        assert.equal(record[column], null, column);
    }
    assert.equal(record.checks_status, null);
    assert.equal(record.checks_flagged, null);
});

test('buildRunRecord copies the checks\' whole-CSV counts into columns', () => {
    const checks = {
        status: 'fail',
        checks: [
            { id: 'coverage', level: 'fail', summary: '3 titles missing' },
            { id: 'errors', level: 'warn', summary: '4%' },
            { id: 'language', level: 'pass', summary: 'ok' },
        ],
        metrics: {
            rows: 900, articles: 24, modelRows: 700,
            verdicts: { SUPPORTED: 500, 'PARTIALLY SUPPORTED': 90, 'NOT SUPPORTED': 80, 'SOURCE UNAVAILABLE': 190, ERROR: 30, SKIPPED: 10 },
            errorReasons: { retries_exhausted: 30 },
            citationsWithUrl: 850, fetched: 720, fetchFailed: 130, ourFetchFailed: 2, truncated: 40,
            fetchFailureKinds: { publisher: 128 },
            tokenTotals: { in: 1_200_000, out: 90_000 },
        },
    };
    const record = buildRunRecord({
        ...base, status: RUN_STATUSES.CHECKS_FAILED, exitCode: 5, finishedAt: new Date('2026-10-27T05:00:00Z'),
        checks, processStats: { funnel: { articles: 25 } },
    });
    assert.equal(record.rows_total, 900);
    assert.equal(record.articles, 24);
    assert.equal(record.model_rows, 700);
    assert.equal(record.supported, 500);
    assert.equal(record.partially_supported, 90);
    assert.equal(record.not_supported, 80);
    assert.equal(record.source_unavailable, 190);
    assert.equal(record.error_rows, 30);
    assert.equal(record.skipped_rows, 10);
    assert.equal(record.citations_with_url, 850);
    assert.equal(record.fetch_failed, 130);
    assert.equal(record.our_fetch_failed, 2);
    assert.equal(record.tokens_in, 1_200_000);
    assert.equal(record.tokens_out, 90_000);
    assert.equal(record.checks_status, 'fail');
    assert.equal(record.checks_flagged, 'fail:coverage warn:errors', 'only checks that warned or failed');
    assert.deepEqual(record.details.process, { funnel: { articles: 25 } });
    assert.equal(record.details.checks.length, 3, 'every check, for reading the run later');
});

test('buildRunRecord counts a verdict the run never produced as 0 once the checks ran', () => {
    const record = buildRunRecord({
        ...base, status: RUN_STATUSES.OK,
        checks: { status: 'pass', checks: [], metrics: { rows: 1, verdicts: { SUPPORTED: 1 } } },
    });
    assert.equal(record.not_supported, 0);
    assert.equal(record.tokens_in, null, 'a metric the checks did not report stays unknown');
});

test('buildRunUpsertQuery binds one value per column and updates everything but the key', () => {
    const record = buildRunRecord({ ...base, status: RUN_STATUSES.OK, exitCode: 0, finishedAt: '2026-10-27T05:00:00.000Z' });
    const { sql, params } = buildRunUpsertQuery(record);
    assert.equal((sql.match(/\?/g) || []).length, RUN_COLUMNS.length);
    assert.equal(params.length, RUN_COLUMNS.length);
    assert.match(sql, /^INSERT INTO sweep_runs \(run_id, series, wiki, status,/);
    assert.doesNotMatch(sql, /run_id = VALUES/, 'the key is never rewritten');
    assert.match(sql, /status = VALUES\(status\)/);
    assert.match(sql, /details = VALUES\(details\)/);
    assert.equal(params[0], 'ruwiki-r1');
    const at = column => params[RUN_COLUMNS.indexOf(column)];
    assert.ok(at('started_at') instanceof Date);
    assert.ok(at('finished_at') instanceof Date, 'an ISO string from a -run.json is bound as a Date');
    assert.equal(at('finished_at').toISOString(), '2026-10-27T05:00:00.000Z');
    assert.equal(typeof at('details'), 'string');
    assert.deepEqual(JSON.parse(at('details')).checks, []);
});

test('upsertRun hands the built query to the injected query function', async () => {
    const calls = [];
    await upsertRun(async (sql, params) => { calls.push({ sql, params }); }, buildRunRecord({ ...base, status: 'running' }));
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO sweep_runs/);
});

test('selectRecentRuns filters by wiki and series, newest first, and decodes VARBINARY', async () => {
    const calls = [];
    const runs = await selectRecentRuns(async (sql, params) => {
        calls.push({ sql, params });
        return [{ run_id: Buffer.from('ruwiki-r2'), wiki: Buffer.from('ruwiki'), details: '{"process":null}', rows_total: 10 }];
    }, { wiki: 'ruwiki', series: 'ruwiki-weekly', limit: 12 });
    assert.match(calls[0].sql, /WHERE wiki = \? AND series = \? ORDER BY started_at DESC LIMIT 12$/);
    assert.deepEqual(calls[0].params, ['ruwiki', 'ruwiki-weekly']);
    assert.equal(runs[0].run_id, 'ruwiki-r2');
    assert.deepEqual(runs[0].details, { process: null });
    assert.equal(runs[0].rows_total, 10);
});

test('recordFromRow survives a details column that isn\'t JSON', () => {
    assert.equal(recordFromRow({ details: 'not json' }).details, null);
});

test('missingRunSchema names the migration when a run column or table is missing', async () => {
    const missingColumn = async sql => {
        if (/citation_findings/.test(sql)) {
            throw Object.assign(new Error("Unknown column 'run_id' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
        }
        return [];
    };
    assert.match(await missingRunSchema(missingColumn), /apply service\/migrations\/006-sweep-runs\.sql/);

    const missingTable = async sql => {
        if (/sweep_runs/.test(sql)) {
            throw Object.assign(new Error("Table 's57953__source_verifier.sweep_runs' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
        }
        return [];
    };
    assert.match(await missingRunSchema(missingTable), /006-sweep-runs/);
});

test('missingRunSchema leaves other errors to the per-write handling', async () => {
    assert.equal(await missingRunSchema(async () => []), null);
    assert.equal(await missingRunSchema(async () => { throw new Error('Lost connection'); }), null,
        'a connection blip is not a missing schema');
});
