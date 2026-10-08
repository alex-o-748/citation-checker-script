import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, runChecksOnFile, checksPaths } from '../service/run-checks.js';
import { rowsToCsv, parseCsv } from '../service/csv-report.js';
import { STUB_FETCH_ERROR } from '../core/worker.js';

const finding = (n, overrides = {}) => ({
    wiki: 'enwiki', pageId: 1, revisionId: 2, pageTitle: 'A', citationNumber: n, claimText: 'The bridge opened in 1998.',
    sourceUrl: `https://h${n}.example/`, verdict: 'SUPPORTED', supportScore: 90, rationale: `Stated directly (${n}).`,
    provider: 'liftwing', model: 'm', promptVersion: 'p', tokensIn: 100, checkId: `c${n}`, ...overrides,
});

function tempCsv(findings) {
    const dir = mkdtempSync(join(tmpdir(), 'run-checks-'));
    const path = join(dir, 'batch-findings.csv');
    writeFileSync(path, rowsToCsv(findings));
    return path;
}

const silent = { write() {} };

test('checksPaths puts the three reports beside the CSV', () => {
    assert.deepEqual(checksPaths('out/ru-findings.csv'), {
        md: 'out/ru-findings-checks.md', json: 'out/ru-findings-checks.json', review: 'out/ru-findings-review.csv',
    });
});

test('runChecksOnFile writes the report, the metrics and a review CSV with every original column', async () => {
    const path = tempCsv([finding(1), finding(2, { claimText: 'Opened {{citation needed}}' })]);
    const { result, paths } = await runChecksOnFile(path, { titles: ['A', 'B'] });
    assert.match(readFileSync(paths.md, 'utf8'), /^# Sweep checks: FAIL/);
    const json = JSON.parse(readFileSync(paths.json, 'utf8'));
    assert.equal(json.status, result.status);
    assert.deepEqual(json.metrics.rowsPerArticle, { A: 2 });
    const [header, ...rows] = parseCsv(readFileSync(paths.review, 'utf8'));
    assert.deepEqual(header.slice(0, 4), ['review_reason', 'review_detail', 'record', 'page_title']);
    assert.ok(header.includes('check_id'));
    assert.ok(rows.some(r => r[0].includes('suspect:junk_in_claim') && r[2] === '2'));
});

test('main exits 1 when a check fails, 0 when none does', async () => {
    const failing = tempCsv([finding(1), finding(2, { verdict: 'SOURCE UNAVAILABLE', reasonType: 'fetch_failed', fetchError: STUB_FETCH_ERROR, provider: null, tokensIn: null })]);
    assert.equal(await main(['node', 'run-checks.js', failing], { stdout: silent, stderr: silent }), 1);
    const passing = tempCsv([finding(1), finding(2)]);
    assert.equal(await main(['node', 'run-checks.js', passing], { stdout: silent, stderr: silent }), 0);
});

test('main reads --titles-file for the coverage check', async () => {
    const path = tempCsv([finding(1)]);
    let seen;
    const code = await main(['node', 'run-checks.js', path, '--titles-file', 'list.txt', '--wiki', 'ruwiki'], {
        stdout: silent, stderr: silent,
        readTitlesFile: async () => '# header\nA\n\nB\n',
        runChecks: async (csv, options) => { seen = options; return { result: { status: 'pass', checks: [] }, paths: checksPaths(csv), markdown: '' }; },
    });
    assert.equal(code, 0);
    assert.deepEqual(seen.titles, ['A', 'B']);
    assert.equal(seen.wiki, 'ruwiki');
});

test('main exits 2 on a missing file or bad arguments', async () => {
    assert.equal(await main(['node', 'run-checks.js', '/nonexistent/x.csv'], { stdout: silent, stderr: silent }), 2);
    assert.equal(await main(['node', 'run-checks.js'], { stdout: silent, stderr: silent }), 2);
    assert.equal(await main(['node', 'run-checks.js', 'a.csv', '--bogus'], { stdout: silent, stderr: silent }), 2);
});
