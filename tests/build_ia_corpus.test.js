import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadContentByKey, buildRows } from '../service/build-ia-corpus.js';

test('loadContentByKey indexes NDJSON content records by key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-corpus-'));
    try {
        const contentPath = path.join(dir, 'content.ndjson');
        fs.writeFileSync(contentPath, [
            JSON.stringify({ key: 'k1', url: 'https://example.com/a', pageNum: null, content: 'Source URL: https://example.com/a\n\nSource Content:\ntext a' }),
            'not json',
            JSON.stringify({ key: 'k2', url: 'https://example.com/b', pageNum: 3, content: 'Source URL: https://example.com/b\n\nSource Content:\ntext b' }),
            '',
        ].join('\n'));

        const byKey = loadContentByKey(contentPath);
        assert.equal(byKey.size, 2);
        assert.equal(byKey.get('k1').url, 'https://example.com/a');
        assert.equal(byKey.get('k2').pageNum, 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('buildRows emits one row per (claim, source) pair and strips the source-fetch wrapper', () => {
    const tasks = [
        {
            key: 'k1',
            url: 'https://example.com/a',
            citations: [
                { pageId: 1, title: 'Article A', revisionId: 10, citationNumber: '1', claimText: 'The bridge opened in 1998.' },
                { pageId: 2, title: 'Article B', revisionId: 20, citationNumber: '1', claimText: 'The same bridge opened in 1998.' },
            ],
        },
        {
            key: 'k2',
            url: 'https://example.com/never-fetched',
            citations: [
                { pageId: 3, title: 'Article C', revisionId: 30, citationNumber: '4', claimText: 'Unrelated claim.' },
            ],
        },
    ];

    const contentByKey = new Map([
        ['k1', { content: 'Source URL: https://example.com/a\n\nSource Content:\nThe bridge is 500 meters long.' }],
    ]);

    const rows = buildRows(tasks, contentByKey);

    assert.equal(rows.length, 2, 'k2 was never fetched and contributes no rows');
    assert.equal(rows[0].claim_text, 'The bridge opened in 1998.');
    assert.equal(rows[0].source_text, 'The bridge is 500 meters long.', 'wrapper stripped via extractSourceText');
    assert.equal(rows[0].source_url, 'https://example.com/a');
    assert.equal(rows[0].dataset_version, 'ia-load-test');
    assert.equal(rows[0].extraction_status, 'complete');
    assert.equal(rows[0].needs_manual_review, false);
    assert.equal(rows[1].page_title, 'Article B');
    assert.notEqual(rows[0].id, rows[1].id);
});
