// Truncation and exclusion flags on benchmark rows.
//
// Background: 48 of 189 dataset rows store a source cut short at the proxy's
// 12,000-char cap, and the extractor used to discard that fact — so a label made
// by a human reading the whole page was scored against a fragment, and nothing
// in the data said so. These tests pin the two halves of the fix: the extractor
// recording truncation at fetch time, and the analyzer refusing to guess when
// the flag is absent. See docs/benchmark-ground-truth-audit-2026-09-06.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { proxyContentTruncated } from '../benchmark/extract_dataset.js';
import { excludedRowIds, partitionByTruncation } from '../benchmark/analyze_results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('proxyContentTruncated: trusts the proxy flag when it is set', () => {
    assert.equal(proxyContentTruncated({ truncated: true, content: 'short' }), true);
    assert.equal(proxyContentTruncated({ truncated: false, content: 'short' }), false);
});

test('proxyContentTruncated: treats landing on the cap as truncated even unflagged', () => {
    // The proxy does not always set `truncated`, which is the whole reason
    // core/worker.js has the length fallback too.
    assert.equal(proxyContentTruncated({ content: 'x'.repeat(12000) }), true);
    assert.equal(proxyContentTruncated({ content: 'x'.repeat(11999) }), false);
});

test('proxyContentTruncated: survives a malformed or empty proxy response', () => {
    assert.equal(proxyContentTruncated(undefined), false);
    assert.equal(proxyContentTruncated({}), false);
    assert.equal(proxyContentTruncated({ content: null }), false);
});

test('proxyContentTruncated: agrees with the rule core/worker.js applies', () => {
    // The bug this whole change exists to prevent is these two drifting apart.
    // If worker.js's threshold moves, this fails and names the reason.
    const workerSrc = fs.readFileSync(path.join(repoRoot, 'core', 'worker.js'), 'utf-8');
    const match = workerSrc.match(/data\.truncated === true \|\| data\.content\.length >= (\d+)/);
    assert.ok(match, 'core/worker.js no longer has the truncation check this mirrors');
    const workerCap = Number(match[1]);
    assert.equal(proxyContentTruncated({ content: 'x'.repeat(workerCap) }), true,
        `benchmark cap disagrees with core/worker.js's ${workerCap}`);
    assert.equal(proxyContentTruncated({ content: 'x'.repeat(workerCap - 1) }), false,
        `benchmark cap disagrees with core/worker.js's ${workerCap}`);
});

const rows = (...ids) => ids.map(id => ({ entry_id: id }));

test('partitionByTruncation: splits results by the dataset flag', () => {
    const dataset = [
        { id: 'row_1', source_truncated: true },
        { id: 'row_2', source_truncated: false },
        { id: 'row_3', source_truncated: true },
    ];
    const split = partitionByTruncation(rows('row_1', 'row_2', 'row_3'), dataset);
    assert.deepEqual(split.truncated.map(r => r.entry_id), ['row_1', 'row_3']);
    assert.deepEqual(split.full.map(r => r.entry_id), ['row_2']);
});

test('partitionByTruncation: returns null when no row carries the flag', () => {
    // Absent is not false. A pre-flag dataset (dataset_v1.json) would otherwise
    // report every row as "full" — a confidently wrong answer rather than an
    // error. The caller is expected to refuse on null.
    const dataset = [{ id: 'row_1' }, { id: 'row_2' }];
    assert.equal(partitionByTruncation(rows('row_1', 'row_2'), dataset), null);
});

test('partitionByTruncation: a single flagged row is enough to classify the rest', () => {
    // Once the dataset demonstrably carries the flag, a row without it is
    // genuinely untruncated rather than unknown.
    const dataset = [{ id: 'row_1', source_truncated: true }, { id: 'row_2' }];
    const split = partitionByTruncation(rows('row_1', 'row_2'), dataset);
    assert.deepEqual(split.truncated.map(r => r.entry_id), ['row_1']);
    assert.deepEqual(split.full.map(r => r.entry_id), ['row_2']);
});

test('partitionByTruncation: drops results whose entry_id has no dataset row', () => {
    // A stale entry_id (the row_<csv_line> shift) can't be classified either
    // way; silently filing it under "full" would inflate that bucket.
    const dataset = [{ id: 'row_1', source_truncated: false }];
    const split = partitionByTruncation(rows('row_1', 'row_999'), dataset);
    assert.deepEqual(split.full.map(r => r.entry_id), ['row_1']);
    assert.deepEqual(split.truncated, []);
});

test('excludedRowIds: collects rows carrying an exclusion reason', () => {
    const dataset = [
        { id: 'row_1', excluded_reason: 'bot-block page - source never retrieved' },
        { id: 'row_2' },
        { id: 'row_3', excluded_reason: '' },
    ];
    assert.deepEqual([...excludedRowIds(dataset)], ['row_1']);
});

test('dataset.json: every excluded row names a reason, and ids stay CSV-aligned', () => {
    const dataset = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'benchmark', 'dataset.json'), 'utf-8')
    ).rows;
    const csv = fs.readFileSync(path.join(repoRoot, 'Benchmarking_data_Citations.csv'), 'utf-8')
        .trim().split(/\r?\n/);

    assert.ok(csv[0].includes('Exclude reason'), 'CSV lost its Exclude reason column');

    for (const row of dataset) {
        assert.equal(typeof row.source_truncated, 'boolean',
            `${row.id} is missing source_truncated`);
        if ('excluded_reason' in row) {
            assert.ok(row.excluded_reason.trim().length > 0,
                `${row.id} has an empty excluded_reason`);
        }
        // Ids are row_<csv_line>. Excluding by deleting CSV lines would shift
        // every id after the deletion and silently misalign results.json — the
        // failure CLAUDE.md documents. This catches it.
        const line = csv[Number(row.id.slice(4)) - 1];
        assert.ok(line && line.includes(row.article_url),
            `${row.id} no longer maps to its CSV line — ids have shifted`);
    }
});
