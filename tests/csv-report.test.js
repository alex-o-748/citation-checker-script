import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    rowsToCsv,
    findingToCsvRow,
    writeCsvReport,
    csvHeaderLine,
    findingToCsvLine,
    appendFinding,
    csvPageTitles,
} from '../service/csv-report.js';

const baseFinding = () => ({
    wiki: 'enwiki',
    pageId: 42,
    pageTitle: 'Test Article',
    revisionId: 987654321,
    claimText: 'The bridge opened in 1998.',
    citationNumber: '3',
    refName: null,
    sourceUrl: 'https://example.com/a',
    groupId: null,
    isCollective: false,
    verdict: 'SUPPORTED',
    supportScore: 90,
    reasonType: null,
    rationale: 'Direct match.',
    sourceQuote: 'The bridge opened to traffic in 1998.',
    quoteStatus: 'exact',
    provider: 'publicai',
    model: 'qwen3-32b',
    promptVersion: 'v1',
    fetchStatus: 200,
    sourceTruncated: false,
    tokensIn: 100,
    tokensOut: 40,
    published: false,
});

test('rowsToCsv emits the header row', () => {
    const csv = rowsToCsv([]);
    const [header] = csv.trim().split('\n');
    assert.equal(
        header,
        'page_title,page_id,revision_id,permalink,citation_number,ref_name,is_collective,group_id,claim_text,' +
        'source_url,verdict,support_score,reason_type,rationale,source_quote,quote_status,fetch_status,' +
        'source_truncated,provider,model,prompt_version,tokens_in,tokens_out,published'
    );
});

test('a named ref\'s recovered name appears in its own column', () => {
    const row = findingToCsvRow({ ...baseFinding(), refName: 'smith2001' });
    const refNameIndex = 5; // page_title, page_id, revision_id, permalink, citation_number, ref_name
    assert.equal(row[refNameIndex], 'smith2001');
});

test('a finding round-trips its plain fields into CSV columns', () => {
    const csv = rowsToCsv([baseFinding()]);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 2, 'header + one row');
    assert.match(lines[1], /Test Article/);
    assert.match(lines[1], /SUPPORTED/);
    assert.match(lines[1], /987654321/);
});

test('the permalink is derived from page_id, revision_id, and the wiki', () => {
    const row = findingToCsvRow(baseFinding());
    const permalinkIndex = 3; // page_title, page_id, revision_id, permalink
    assert.equal(row[permalinkIndex], 'https://en.wikipedia.org/w/index.php?curid=42&oldid=987654321');
});

test('a non-enwiki wiki database name derives a plausible domain', () => {
    const row = findingToCsvRow({ ...baseFinding(), wiki: 'frwiki' });
    assert.equal(row[3], 'https://fr.wikipedia.org/w/index.php?curid=42&oldid=987654321');
});

test('a missing page_id or revision_id yields an empty permalink rather than a broken URL', () => {
    const row = findingToCsvRow({ ...baseFinding(), revisionId: null });
    assert.equal(row[3], '');
});

test('claim text containing a comma, quote, and newline is escaped per RFC4180', () => {
    const finding = { ...baseFinding(), claimText: 'He said, "it opened in 1998,"\nand nothing more.' };
    const csv = rowsToCsv([finding]);
    // The cell round-trips through a naive CSV split: quoted, commas inside
    // stay inside the quotes, and the embedded quote is doubled.
    assert.match(csv, /"He said, ""it opened in 1998,""\nand nothing more\."/);
});

test('a no-model-ran row (no URL, no verdict fields) is still included, not dropped', () => {
    const finding = {
        ...baseFinding(),
        verdict: 'SOURCE UNAVAILABLE',
        supportScore: null,
        rationale: null,
        sourceQuote: null,
        quoteStatus: null,
        provider: null,
        model: null,
        fetchStatus: null,
        sourceUrl: null,
        tokensIn: null,
        tokensOut: null,
    };
    const csv = rowsToCsv([finding]);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /SOURCE UNAVAILABLE/);
});

test('null and undefined fields render as empty cells, not the string "null"', () => {
    const csv = rowsToCsv([{ ...baseFinding(), groupId: null, reasonType: undefined }]);
    const cells = csv.trim().split('\n')[1].split(',');
    assert.equal(cells[7], ''); // group_id
    assert.equal(cells[12], ''); // reason_type
    assert.doesNotMatch(csv, /\bnull\b/, 'a raw null must never render as the string "null"');
    assert.doesNotMatch(csv, /\bundefined\b/);
});

test('is_collective and source_truncated render as 0/1, not true/false', () => {
    const row = findingToCsvRow({ ...baseFinding(), isCollective: true, sourceTruncated: true });
    assert.equal(row[6], 1);
    assert.equal(row[17], 1);
});

test('an internal identity hash is never a column', () => {
    const header = rowsToCsv([]).trim().split('\n')[0];
    assert.doesNotMatch(header, /hash/i);
});

test('writeCsvReport writes the same content rowsToCsv produces, via the injected writeFile', async () => {
    let written;
    await writeCsvReport([baseFinding()], '/tmp/findings.csv', {
        writeFile: async (path, content, encoding) => {
            written = { path, content, encoding };
        },
    });
    assert.equal(written.path, '/tmp/findings.csv');
    assert.equal(written.content, rowsToCsv([baseFinding()]));
    assert.equal(written.encoding, 'utf8');
});

// --- Incremental writing and resume ---

test('rowsToCsv is built from the same header and row helpers the appender uses', () => {
    const finding = { pageTitle: 'A', citationNumber: '1', verdict: 'SUPPORTED' };
    assert.equal(rowsToCsv([finding]), csvHeaderLine() + findingToCsvLine(finding));
});

test('appendFinding appends exactly one row and no header', async () => {
    const writes = [];
    await appendFinding('out.csv', { pageTitle: 'A', verdict: 'SUPPORTED' }, {
        appendFile: async (path, text) => writes.push({ path, text }),
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, 'out.csv');
    assert.ok(writes[0].text.startsWith('A,'));
    assert.ok(writes[0].text.endsWith('\n'));
    assert.ok(!writes[0].text.includes('page_title'));
});

test('csvPageTitles reads back the titles a written CSV contains, skipping the header', () => {
    const csv = rowsToCsv([
        { pageTitle: 'Hurricane Lowell (2026)' },
        { pageTitle: 'Cape Verde bus crash' },
        { pageTitle: 'Hurricane Lowell (2026)' },
    ]);
    assert.deepEqual([...csvPageTitles(csv)].sort(),
        ['Cape Verde bus crash', 'Hurricane Lowell (2026)']);
    assert.ok(!csvPageTitles(csv).has('page_title'), 'the header row is not a title');
});

// The reason this is a quote-aware scan rather than a split on newlines:
// claim_text and rationale are arbitrary prose, and csvCell() quotes an
// embedded newline rather than stripping it. A naive parser would treat the
// claim's second line as a new record and take a fragment of prose for an
// article title -- which on resume would fail to skip a finished article and
// silently redo it.
test('csvPageTitles is not fooled by newlines, commas or quotes inside a claim', () => {
    const csv = rowsToCsv([
        { pageTitle: 'Nepal-Tibet floods', claimText: 'First line.\nSecond line, with a comma.' },
        { pageTitle: 'Yemen offensive', claimText: 'He said "it collapsed", per the report.' },
    ]);
    assert.deepEqual([...csvPageTitles(csv)].sort(), ['Nepal-Tibet floods', 'Yemen offensive']);
});

test('csvPageTitles handles a title needing quoting, CRLF, and an empty file', () => {
    const csv = rowsToCsv([{ pageTitle: 'Smith, John "Jack"' }]);
    assert.deepEqual([...csvPageTitles(csv)], ['Smith, John "Jack"']);
    assert.deepEqual([...csvPageTitles(csv.replace(/\n/g, '\r\n'))], ['Smith, John "Jack"']);
    assert.deepEqual([...csvPageTitles('')], []);
    assert.deepEqual([...csvPageTitles(csvHeaderLine())], [], 'a header-only file has no titles');
});
