import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findingFromCsvRow, runImport, parseCliArgs } from '../service/run-import-findings.js';
import { parseCsv, rowsToCsv } from '../service/csv-report.js';
import { buildUpsertQuery } from '../service/findings-store.js';

// Findings as run-sweep.js writes them, read back as a CSV gives them.
function csvRows(findings) {
    const [header, ...records] = parseCsv(rowsToCsv(findings));
    return records.map(r => Object.fromEntries(header.map((name, i) => [name, r[i]])));
}

const FETCHED_AT = new Date('2026-10-14T12:00:00Z');
// A CSV from before run records has no -run.json beside it.
const noRunRecord = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

const verified = {
    wiki: 'ruwiki', pageId: 42, pageTitle: 'Африка', revisionId: 155504239,
    claimText: 'На континенте представлены большие объединения языков.', citationNumber: '69',
    refName: ':0', sourceUrl: 'https://example.org/book', groupId: 'cite_ref-:0_69-0', isCollective: false,
    verdict: 'NOT SUPPORTED', supportScore: 20, reasonType: 'omission', rationale: 'Источник об этом молчит.',
    sourceQuote: null, quoteStatus: 'empty', provider: 'liftwing', model: 'llm-qwen36-27b', promptVersion: 'v2',
    fetchStatus: 200, sourceTruncated: true, tokensIn: 900, tokensOut: 60, published: false,
};
const unavailable = {
    ...verified, citationNumber: '70', verdict: 'SOURCE UNAVAILABLE', supportScore: null, reasonType: null,
    rationale: null, quoteStatus: null, provider: null, model: null, tokensIn: null, tokensOut: null,
    fetchStatus: 404, sourceTruncated: false,
};

test('a verified row comes back as the finding the sweep stored, with fetched_at from the file', () => {
    const [row] = csvRows([verified]);
    const finding = findingFromCsvRow(row, { wiki: 'ruwiki', fetchedAt: FETCHED_AT });

    for (const key of ['pageId', 'pageTitle', 'revisionId', 'claimText', 'citationNumber', 'refName', 'sourceUrl',
        'groupId', 'isCollective', 'verdict', 'supportScore', 'reasonType', 'rationale', 'quoteStatus', 'provider',
        'model', 'promptVersion', 'fetchStatus', 'sourceTruncated', 'tokensIn', 'tokensOut', 'published']) {
        assert.deepEqual(finding[key], verified[key], key);
    }
    assert.equal(finding.wiki, 'ruwiki');
    assert.equal(finding.fetchedAt, FETCHED_AT);
    assert.equal(finding.expiresAt.toISOString(), '2026-11-13T12:00:00.000Z', '30 days after the fetch');
});

test('a row with no fetched source gets no fetched_at or expiry, and stores provider as empty', () => {
    const [row] = csvRows([unavailable]);
    const finding = findingFromCsvRow(row, { wiki: 'ruwiki', fetchedAt: FETCHED_AT });
    assert.equal(finding.fetchedAt, null);
    assert.equal(finding.expiresAt, null);
    assert.equal(finding.provider, null);
    assert.equal(buildUpsertQuery(finding).params[19], '', 'matches on re-import instead of duplicating');
});

test('a row whose title never resolved to a page id is skipped (page_id is NOT NULL)', () => {
    const [row] = csvRows([{ ...verified, pageId: null }]);
    assert.equal(findingFromCsvRow(row, { wiki: 'ruwiki', fetchedAt: FETCHED_AT }), null);
});

test('runImport upserts every row and reports the counts', async () => {
    const rows = csvRows([verified, unavailable, { ...verified, pageId: null }]);
    const executed = [];
    const out = [];
    let ended = false;
    const code = await runImport({ wiki: 'ruwiki', files: ['b4.csv'], dryRun: false }, {
        stderr: { write: s => out.push(s) },
        connectToolsDb: async () => ({
            execute: async (sql, params) => {
                if (/INSERT INTO citation_findings/.test(sql)) executed.push(params);
                return [{ affectedRows: 1 }];
            },
            end: async () => { ended = true; },
        }),
        streamRows: async (_file, { onRow }) => rows.forEach((r, i) => onRow(r, i + 1)),
        stat: async () => ({ mtime: FETCHED_AT }),
        readFile: noRunRecord,
    });
    assert.equal(code, 0);
    assert.equal(executed.length, 2);
    assert.equal(ended, true);
    assert.match(out.join(''), /b4\.csv: 2 row\(s\) written, 1 without a page id skipped, 0 malformed/);
});

test('--dry-run converts and counts without connecting to ToolsDB', async () => {
    let connected = false;
    const out = [];
    const code = await runImport({ wiki: 'ruwiki', files: ['b4.csv'], dryRun: true }, {
        stderr: { write: s => out.push(s) },
        connectToolsDb: async () => { connected = true; },
        streamRows: async (_file, { onRow }) => csvRows([verified]).forEach((r, i) => onRow(r, i + 1)),
        stat: async () => ({ mtime: FETCHED_AT }),
        readFile: noRunRecord,
    });
    assert.equal(code, 0);
    assert.equal(connected, false);
    assert.match(out.join(''), /1 row\(s\) would be written/);
});

test('a failed upsert is counted and makes the import exit non-zero', async () => {
    const out = [];
    const code = await runImport({ wiki: 'ruwiki', files: ['b4.csv'], dryRun: false }, {
        stderr: { write: s => out.push(s) },
        connectToolsDb: async () => ({ execute: async () => { throw new Error('Data too long'); }, end: async () => {} }),
        streamRows: async (_file, { onRow }) => csvRows([verified]).forEach((r, i) => onRow(r, i + 1)),
        stat: async () => ({ mtime: FETCHED_AT }),
        readFile: noRunRecord,
    });
    assert.equal(code, 1);
    assert.match(out.join(''), /1 failed \(first: Data too long\)/);
});

test('--wiki is required, since the CSV does not record it', async () => {
    const code = await runImport({ files: ['b4.csv'], dryRun: true }, { stderr: { write() {} } });
    assert.equal(code, 2);
    assert.deepEqual(parseCliArgs(['node', 'x', 'a.csv', 'b.csv', '--wiki', 'ruwiki']).files, ['a.csv', 'b.csv']);
});

test('a row\'s run_id comes back from the CSV; an old CSV without the column gives null', () => {
    const [row] = csvRows([{ ...verified, runId: 'ruwiki-20261027T031700Z-3f9a' }]);
    assert.equal(findingFromCsvRow(row, { wiki: 'ruwiki', fetchedAt: FETCHED_AT }).runId, 'ruwiki-20261027T031700Z-3f9a');
    const { run_id: _dropped, ...oldRow } = row;
    assert.equal(findingFromCsvRow(oldRow, { wiki: 'ruwiki', fetchedAt: FETCHED_AT }).runId, null);
});

test('the CSV\'s -run.json is loaded into sweep_runs alongside its rows', async () => {
    const runWrites = [];
    const out = [];
    const record = { run_id: 'ruwiki-r1', wiki: 'ruwiki', status: 'ok', started_at: '2026-10-27T03:17:00.000Z', details: null };
    const code = await runImport({ wiki: 'ruwiki', files: ['sweeps/r1/findings.csv'], dryRun: false }, {
        stderr: { write: s => out.push(s) },
        connectToolsDb: async () => ({
            execute: async (sql, params) => {
                if (/INSERT INTO sweep_runs/.test(sql)) runWrites.push(params);
                return [{ affectedRows: 1 }];
            },
            end: async () => {},
        }),
        streamRows: async (_file, { onRow }) => csvRows([verified]).forEach((r, i) => onRow(r, i + 1)),
        stat: async () => ({ mtime: FETCHED_AT }),
        readFile: async path => {
            assert.equal(path, 'sweeps/r1/findings-run.json');
            return JSON.stringify(record);
        },
    });
    assert.equal(code, 0);
    assert.equal(runWrites.length, 1);
    assert.equal(runWrites[0][0], 'ruwiki-r1');
    assert.match(out.join(''), /run ruwiki-r1 recorded/);
});

test('an import against a table without migration 006 stops before writing anything', async () => {
    const writes = [];
    const out = [];
    const code = await runImport({ wiki: 'ruwiki', files: ['b4.csv'], dryRun: false }, {
        stderr: { write: s => out.push(s) },
        connectToolsDb: async () => ({
            execute: async (sql, params) => {
                if (/SELECT run_id/.test(sql)) {
                    throw Object.assign(new Error("Unknown column 'run_id'"), { code: 'ER_BAD_FIELD_ERROR' });
                }
                writes.push(params);
                return [{ affectedRows: 1 }];
            },
            end: async () => {},
        }),
        streamRows: async (_file, { onRow }) => csvRows([verified]).forEach((r, i) => onRow(r, i + 1)),
        stat: async () => ({ mtime: FETCHED_AT }),
        readFile: noRunRecord,
    });
    assert.equal(code, 1);
    assert.equal(writes.length, 0);
    assert.match(out.join(''), /apply service\/migrations\/006-sweep-runs\.sql first\n/);
});
