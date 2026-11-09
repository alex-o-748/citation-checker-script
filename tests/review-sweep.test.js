import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { findingToCsvLine, csvHeaderLine } from '../service/csv-report.js';
import {
    matchKey, unescapeMariadb, readOldFindings, reviewSweep, renderReport, renderSample,
} from '../scripts/review-sweep.js';

const base = {
    wiki: 'ruwiki', pageTitle: 'Еврейские беженцы', pageId: 1604689, revisionId: 155423036,
    provider: 'liftwing-safeguard', model: 'llm-gpt-oss-safeguard-20b', promptVersion: 'v2', fetchStatus: 200,
};
const FINDINGS = [
    // The citation that started this: was NOT SUPPORTED on a garbled source.
    { ...base, citationNumber: '62', claimText: 'Евреям, покинувшим Россию, было запрещено возвращаться обратно',
      sourceUrl: 'https://web.archive.org/web/20111103160153/http://www.crjs.ru/publish/book080a.php',
      verdict: 'SUPPORTED', rationale: 'В источнике прямо сказано, что евреям, покинувшим Россию, запрещалось возвращаться.',
      sourceQuote: 'Евреям, покинувшим Россию, было запрещено возвращаться обратно.', quoteStatus: 'exact' },
    { ...base, citationNumber: '63', claimText: 'Claim with a book source', sourceUrl: null,
      verdict: 'SOURCE UNAVAILABLE', reasonType: 'no_url', provider: '', model: '', fetchStatus: null },
    { ...base, citationNumber: '64', claimText: 'Claim with a dead link', sourceUrl: 'https://dead.example.ru/x',
      verdict: 'SOURCE UNAVAILABLE', reasonType: 'fetch_failed', provider: '', model: '', fetchStatus: 404 },
    { ...base, citationNumber: '65', claimText: 'Model ducked', sourceUrl: 'https://ok.example.ru/y',
      verdict: 'SOURCE UNAVAILABLE', rationale: 'Источник не содержит нужной информации о событии.' },
    { ...base, citationNumber: '66', claimText: 'Huge page', sourceUrl: 'https://big.example.ru/z',
      verdict: 'ERROR', reasonType: 'source_too_large', provider: '', model: '' },
    { ...base, citationNumber: '67', claimText: 'English rationale', sourceUrl: 'https://ok.example.ru/w',
      verdict: 'NOT SUPPORTED', rationale: 'The source does not mention this event at all, nor the year.', quoteStatus: 'empty' },
];

async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'review-sweep-'));
    const csv = join(dir, 'new.csv');
    await writeFile(csv, csvHeaderLine() + FINDINGS.map(findingToCsvLine).join(''));
    // `mariadb -B` output: tabs, \n escaped, NULL for nulls.
    const old = [
        'page_id\tpage_title\tclaim_text\tsource_url\tverdict\treason_type\trationale\tmodel',
        `1604689\tЕврейские беженцы\tЕвреям, покинувшим Россию, было запрещено возвращаться обратно\thttps://web.archive.org/web/20111103160153/http://www.crjs.ru/publish/book080a.php\tNOT SUPPORTED\tomission\tВ источнике не упоминается запрет\\nна возвращение.\tllm-gpt-oss-safeguard-20b`,
        `1604689\tЕврейские беженцы\tEnglish rationale\thttps://ok.example.ru/w\tSUPPORTED\tNULL\tok\tllm-gpt-oss-safeguard-20b`,
    ].join('\n') + '\n';
    const oldPath = join(dir, 'old.tsv.gz');
    await writeFile(oldPath, gzipSync(old));
    return { csv, oldPath };
}

test('mariadb -B escapes are undone, and NULL is null', () => {
    assert.equal(unescapeMariadb('a\\nb\\tc\\\\d'), 'a\nb\tc\\d');
    assert.equal(unescapeMariadb('NULL'), null);
});

test('match keys ignore whitespace differences in the claim', () => {
    assert.equal(matchKey(1, 'a  b\n c', 'u'), matchKey('1', 'a b c', 'u'));
    assert.notEqual(matchKey(1, 'a', 'u'), matchKey(1, 'a', 'v'));
});

test('review: SOURCE UNAVAILABLE is split by cause, and old verdicts are joined', async () => {
    const { csv, oldPath } = await fixture();
    const old = await readOldFindings(oldPath);
    assert.equal(old.size, 2);
    const { summary, sample } = await reviewSweep(csv, { old });

    assert.equal(summary.rows, 6);
    assert.deepEqual(summary.unavailable, { fetch_failed: 1, no_url: 1, model_on_fetched: 1, other: 0 });
    assert.equal(summary.tooLarge, 1);
    assert.equal(summary.nonCyrillicRationales, 1);
    assert.equal(summary.old.matched, 2);
    assert.deepEqual(summary.old.transitions, { 'NOT SUPPORTED → SUPPORTED': 1, 'SUPPORTED → NOT SUPPORTED': 1 });

    const cats = sample.map(x => x.category);
    assert.ok(cats.includes('was-not-supported-now-supported'));
    assert.ok(cats.includes('was-supported-now-not-supported'));
    assert.ok(cats.includes('unavailable-but-fetched'));
    assert.ok(cats.includes('english-rationale'));

    const report = renderReport(summary);
    assert.match(report, /NOT SUPPORTED → SUPPORTED \| 1/);
    const sampleCsv = renderSample(sample);
    assert.match(sampleCsv, /на возвращение/, 'old rationale, with its escaped newline restored');
});
