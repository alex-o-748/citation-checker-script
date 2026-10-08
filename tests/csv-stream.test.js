import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCsvParser, streamCsvRows } from '../service/csv-stream.js';
import { parseCsv, rowsToCsv } from '../service/csv-report.js';

function parseInChunks(text, size) {
    const records = [];
    const parser = createCsvParser(r => records.push(r));
    for (let i = 0; i < text.length; i += size) parser.write(text.slice(i, i + size));
    const { unterminated } = parser.end();
    return { records, unterminated };
}

const tricky = 'a,b,c\n'
    + '"line one\nline two","say ""hi""",plain\r\n'
    + ',,"comma, inside"\n'
    + 'x,"",z';

test('createCsvParser agrees with parseCsv however the input is chunked', () => {
    const expected = parseCsv(tricky);
    for (const size of [1, 2, 3, 7, tricky.length]) {
        assert.deepEqual(parseInChunks(tricky, size).records, expected, `chunk size ${size}`);
    }
});

test('createCsvParser round-trips what csv-report.js writes, including multi-line prose', () => {
    const csv = rowsToCsv([
        { pageTitle: 'A', claimText: 'first\nsecond, with "quotes"', rationale: 'r' },
        { pageTitle: 'B', claimText: 'plain' },
    ]);
    assert.deepEqual(parseInChunks(csv, 5).records, parseCsv(csv).slice(0, 3));
});

test('createCsvParser reports a final record cut off inside a quoted field', () => {
    assert.equal(parseInChunks('a,b\n1,"never closed', 4).unterminated, true);
    assert.equal(parseInChunks('a,b\n1,"closed"', 4).unterminated, false);
});

test('streamCsvRows keys rows by header, strips a BOM, and sets malformed records aside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-stream-'));
    const path = join(dir, 'f.csv');
    writeFileSync(path, '﻿page_title,verdict\nA,SUPPORTED\n"B\nB",NOT SUPPORTED\nonly-one-field\n');
    const rows = [];
    const malformed = [];
    const read = await streamCsvRows(path, {
        onRow: (row, index) => rows.push([index, row]),
        onMalformed: (fields, index) => malformed.push([index, fields]),
    });
    assert.deepEqual(read.header, ['page_title', 'verdict']);
    assert.deepEqual(rows, [
        [1, { page_title: 'A', verdict: 'SUPPORTED' }],
        [2, { page_title: 'B\nB', verdict: 'NOT SUPPORTED' }],
    ]);
    assert.deepEqual(malformed, [[3, ['only-one-field']]]);
    assert.equal(read.lastIndex, 3);
    assert.equal(read.unterminated, false);
});
