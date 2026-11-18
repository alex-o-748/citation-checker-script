import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    keptByRecheck, sourceUrls, recheckRow, scoreAgainstLabels, renderScore, runRecheck, RECHECK_COLUMNS,
} from '../service/run-recheck.js';
import { parseCsv } from '../service/csv-report.js';

const answer = (verdict, extra = {}) => ({
    text: JSON.stringify({ verdict, confidence: 80, comments: 'Источник говорит иначе.', reason_type: extra.reason_type ?? null, source_quote: '' }),
    usage: null,
});

test('a flag survives only if the second model also says NOT SUPPORTED', () => {
    assert.equal(keptByRecheck({ verdict: 'NOT SUPPORTED' }), true);
    assert.equal(keptByRecheck({ verdict: 'PARTIALLY SUPPORTED' }), false);
    assert.equal(keptByRecheck({ verdict: 'SUPPORTED' }), false);
});

test('a multi-line source_url is a group row', () => {
    assert.deepEqual(sourceUrls({ source_url: 'https://a.ru/1\nhttps://b.ru/2\n' }), ['https://a.ru/1', 'https://b.ru/2']);
});

test('a single-source row is re-verified against the freshly fetched source', async () => {
    const seen = [];
    const result = await recheckRow(
        { claim_text: 'Евреям, покинувшим Россию, было запрещено возвращаться обратно', source_url: 'https://a.ru/1' },
        {
            fetchSource: async url => ({ content: `Source URL: ${url}\n\nSource Content:\nтекст источника`, status: 200 }),
            callModel: async (system, user) => { seen.push(user); return answer('SUPPORTED'); },
            articleLangCode: 'ru',
        },
    );
    assert.equal(result.verdict, 'SUPPORTED');
    assert.match(seen[0], /текст источника/);
});

test('a group row goes through the collective check', async () => {
    let kind = null;
    const result = await recheckRow(
        { claim_text: 'Утверждение, подкреплённое двумя источниками сразу', source_url: 'https://a.ru/1\nhttps://b.ru/2', citation_number: '3, 4' },
        {
            fetchSource: async url => ({ content: `Source Content:\nтекст ${url}`, status: 200 }),
            callModel: async (s, u, opts) => { kind = opts?.kind; return answer('NOT SUPPORTED', { reason_type: 'contradiction' }); },
        },
    );
    assert.equal(kind, 'group');
    assert.equal(result.verdict, 'NOT SUPPORTED');
});

test('scoring against hand labels counts kept and removed per label', () => {
    const table = scoreAgainstLabels([
        { label: 'genuine', kept: true }, { label: 'genuine', kept: false },
        { label: 'wrong', kept: false }, { label: 'wrong', kept: false }, { label: 'wrong', kept: true },
        { label: 'wrong', kept: false, error: true },
    ]);
    assert.deepEqual(table.genuine, { kept: 1, removed: 1, error: 0 });
    assert.deepEqual(table.wrong, { kept: 1, removed: 2, error: 1 });
    assert.match(renderScore(table), /1 genuine of 2 kept \(50%\)/);
});

test('runRecheck writes input plus recheck columns, and --resume skips what is done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recheck-'));
    const input = join(dir, 'in.csv');
    await writeFile(input, 'label,claim_text,source_url\n'
        + 'genuine,"Первое утверждение, достаточно длинное",https://a.ru/1\n'
        + 'wrong,"Второе утверждение, тоже длинное",https://a.ru/2\n');
    const out = join(dir, 'out.csv');
    let calls = 0;
    const io = {
        stderr: { write() {} }, stdout: { write() {} },
        fetchOne: async url => ({ content: `Source Content:\nтекст ${url}`, status: 200 }),
        callModel: async (s, u) => { calls++; return answer(u.includes('Первое') ? 'NOT SUPPORTED' : 'SUPPORTED'); },
    };
    const opts = { input, out, provider: 'stub', model: 'stub-1', wiki: 'ruwiki', concurrency: 1, limit: 1, resume: false };
    assert.equal(await runRecheck(opts, io), 0);
    assert.equal(await runRecheck({ ...opts, limit: null, resume: true }, io), 0);
    assert.equal(calls, 2, 'the resumed run did only the second row');
    const records = parseCsv(await readFile(out, 'utf8'));
    assert.deepEqual(records[0], ['label', 'claim_text', 'source_url', ...RECHECK_COLUMNS]);
    const kept = records[0].indexOf('recheck_kept');
    assert.deepEqual(records.slice(1).map(r => r[kept]), ['1', '0']);
    const keptRows = parseCsv(await readFile(join(dir, 'out-kept.csv'), 'utf8'));
    assert.equal(keptRows.length, 2, 'header plus the one row both models flagged');
    assert.match(keptRows[1][1], /Первое/);
});
