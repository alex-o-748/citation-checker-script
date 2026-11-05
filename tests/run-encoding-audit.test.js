import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodingDamage, classifyFetch, summarize } from '../service/run-encoding-audit.js';
import { UNDECODABLE_SOURCE_ERROR } from '../core/worker.js';

// The start of what the Worker returned for the crjs.ru Wayback snapshot
// cited by Еврейские беженцы [62] (2026-11-05): Windows-1251 decoded as UTF-8.
const GARBLED = 'XIX ����������� �������� �������������� ��������� ������� � ��������. ������, �������, 25-29 ���� 2010 �. '.repeat(5);
const CLEAN = 'Одна из русскоязычных газет Германии переслала мне письмо своей читательницы. '.repeat(5);

test('a page decoded with the wrong charset is garbled', () => {
    const d = encodingDamage(GARBLED);
    assert.equal(d.garbled, true);
    assert.ok(d.share > 0.5);
});

test('clean Cyrillic is not garbled', () => {
    assert.equal(encodingDamage(CLEAN).garbled, false);
});

test('a stray replacement character in a long page is not garbled', () => {
    assert.equal(encodingDamage(CLEAN + '�' + CLEAN).garbled, false);
});

test('UTF-8 read as Latin-1 is garbled too', () => {
    const mojibake = Buffer.from(CLEAN, 'utf8').toString('latin1');
    assert.equal(encodingDamage(mojibake).garbled, true);
});

test('classifyFetch separates failed, clean and garbled fetches', () => {
    assert.equal(classifyFetch({ content: null, error: 'HTTP 404' }).status, 'fetch_failed');
    assert.equal(classifyFetch({ content: CLEAN }).status, 'clean');
    assert.equal(classifyFetch({ content: GARBLED }).status, 'garbled');
    assert.equal(classifyFetch({ content: null, error: UNDECODABLE_SOURCE_ERROR }).status, 'garbled');
});

test('summarize joins URL results back onto rows and counts verdicts', () => {
    const rows = [
        { url: 'https://a.ru/1', verdict: 'NOT SUPPORTED' },
        { url: 'https://a.ru/1', verdict: 'SOURCE UNAVAILABLE' },
        { url: 'https://b.org/2', verdict: 'SUPPORTED' },
        { url: '', verdict: 'SOURCE UNAVAILABLE' },
    ];
    const byUrl = new Map([
        ['https://a.ru/1', classifyFetch({ content: GARBLED })],
        ['https://b.org/2', classifyFetch({ content: CLEAN })],
    ]);
    const s = summarize(rows, byUrl);
    assert.equal(s.distinct_urls, 2);
    assert.equal(s.rows_without_url, 1);
    assert.deepEqual(s.rows_by_status, { garbled: 2, clean: 1 });
    assert.deepEqual(s.garbled_rows_by_verdict, { 'NOT SUPPORTED': 1, 'SOURCE UNAVAILABLE': 1 });
    assert.deepEqual(s.garbled_hosts, { 'a.ru': 2 });
});
