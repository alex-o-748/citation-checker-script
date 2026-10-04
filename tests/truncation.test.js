// Truncation and exclusion flags on benchmark rows.
//
// Background: 48 of 189 dataset rows store a source cut short at the proxy's
// then 12,000-char cap (the Worker's cap is 100,000 now), and the extractor used to discard that fact — so a label made
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
import { isContentTruncated, WORKER_CONTENT_CAP } from '../core/worker.js';
import { excludedRowIds, partitionByTruncation } from '../benchmark/analyze_results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

test('isContentTruncated: the fetcher\'s own flag decides when it is present', () => {
    // tf-source-fetcher always sends the flag. A long whole page must not be
    // second-guessed into "truncated", and a short clamped one must not be
    // waved through for being short — its parse was cut before extraction.
    assert.equal(isContentTruncated({ truncated: false, content: 'x'.repeat(WORKER_CONTENT_CAP) }), false);
    assert.equal(isContentTruncated({ truncated: false, content: 'x'.repeat(60000) }), false);
    assert.equal(isContentTruncated({ truncated: true, content: 'x'.repeat(19777) }), true);
});

test('isContentTruncated: without a flag, only landing on the Worker cap counts', () => {
    // The Cloudflare Worker sends no flag and cuts at .substring(0, 100000).
    // The old rule, length >= 12000, marked every long-but-whole Worker source
    // as truncated once that cap rose from 12,000.
    assert.equal(isContentTruncated({ content: 'x'.repeat(WORKER_CONTENT_CAP) }), true);
    assert.equal(isContentTruncated({ content: 'x'.repeat(WORKER_CONTENT_CAP - 1) }), false);
    assert.equal(isContentTruncated({ content: 'x'.repeat(12000) }), false);
});

test('isContentTruncated: survives a malformed or empty response', () => {
    assert.equal(isContentTruncated(undefined), false);
    assert.equal(isContentTruncated({}), false);
    assert.equal(isContentTruncated({ content: null }), false);
    // A non-boolean flag is not a flag: fall back to the length rule.
    assert.equal(isContentTruncated({ truncated: 'yes', content: 'short' }), false);
});

test('the benchmark extractor applies the same rule as core/worker.js', () => {
    // These two used to hold separate copies of the threshold, kept in step by
    // a test that regex-matched worker.js's source. It is one function now.
    for (const data of [
        { content: 'x'.repeat(WORKER_CONTENT_CAP) },
        { content: 'x'.repeat(12000) },
        { truncated: true, content: 'short' },
        { truncated: false, content: 'x'.repeat(WORKER_CONTENT_CAP) },
    ]) {
        assert.equal(proxyContentTruncated(data), isContentTruncated(data));
    }
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
