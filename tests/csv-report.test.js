import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rowsToCsv, findingToCsvRow, writeCsvReport } from '../service/csv-report.js';

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
    confidence: 90,
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
        'check_id,page_title,page_id,revision_id,permalink,citation_number,ref_name,is_collective,group_id,claim_text,' +
        'source_url,verdict,confidence,reason_type,rationale,source_quote,quote_status,fetch_status,' +
        'source_truncated,provider,model,prompt_version,tokens_in,tokens_out,published'
    );
});

test('a named ref\'s recovered name appears in its own column', () => {
    const row = findingToCsvRow({ ...baseFinding(), refName: 'smith2001' });
    const refNameIndex = 6; // check_id, page_title, page_id, revision_id, permalink, citation_number, ref_name
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
    const permalinkIndex = 4; // check_id, page_title, page_id, revision_id, permalink
    assert.equal(row[permalinkIndex], 'https://en.wikipedia.org/w/index.php?curid=42&oldid=987654321');
});

test('a non-enwiki wiki database name derives a plausible domain', () => {
    const row = findingToCsvRow({ ...baseFinding(), wiki: 'frwiki' });
    assert.equal(row[4], 'https://fr.wikipedia.org/w/index.php?curid=42&oldid=987654321');
});

test('a missing page_id or revision_id yields an empty permalink rather than a broken URL', () => {
    const row = findingToCsvRow({ ...baseFinding(), revisionId: null });
    assert.equal(row[4], '');
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
        confidence: null,
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
    assert.equal(cells[8], ''); // group_id
    assert.equal(cells[13], ''); // reason_type
    assert.doesNotMatch(csv, /\bnull\b/, 'a raw null must never render as the string "null"');
    assert.doesNotMatch(csv, /\bundefined\b/);
});

test('is_collective and source_truncated render as 0/1, not true/false', () => {
    const row = findingToCsvRow({ ...baseFinding(), isCollective: true, sourceTruncated: true });
    assert.equal(row[7], 1);
    assert.equal(row[18], 1);
});

test('an internal identity hash is never a column', () => {
    const header = rowsToCsv([]).trim().split('\n')[0];
    assert.doesNotMatch(header, /hash/i);
});

// ---- check_id ---------------------------------------------------------

test('check_id is a 12-char lowercase hex string', () => {
    const row = findingToCsvRow(baseFinding());
    assert.match(row[0], /^[0-9a-f]{12}$/);
});

test('check_id is deterministic — the same finding always gets the same id', () => {
    const a = findingToCsvRow(baseFinding())[0];
    const b = findingToCsvRow(baseFinding())[0];
    assert.equal(a, b);
});

test('check_id does not depend on --store having run — two otherwise-identical findings from separate CSV-only runs get the same id', () => {
    // Simulates two independent runs of the same citation, never touching
    // ToolsDB: fields that vary run to run (fetchedAt, tokensIn/Out,
    // rationale wording) differ, but the identity fields don't.
    const runA = { ...baseFinding(), tokensIn: 100, tokensOut: 40, rationale: 'Direct match.' };
    const runB = { ...baseFinding(), tokensIn: 105, tokensOut: 38, rationale: 'A clear, direct match.' };
    assert.equal(findingToCsvRow(runA)[0], findingToCsvRow(runB)[0]);
});

test('check_id changes when any identity field changes', () => {
    const base = findingToCsvRow(baseFinding())[0];
    const variants = [
        { wiki: 'frwiki' },
        { pageId: 43 },
        { claimText: 'The bridge opened in 1999.' },
        { sourceUrl: 'https://example.com/b' },
        { provider: 'claude' },
        { promptVersion: 'v2' },
    ];
    for (const overrides of variants) {
        const id = findingToCsvRow({ ...baseFinding(), ...overrides })[0];
        assert.notEqual(id, base, `expected a different check_id when overriding ${JSON.stringify(overrides)}`);
    }
});

test('check_id changes when the model did not run (null provider) vs. did, even with identical claim/source', () => {
    const ran = findingToCsvRow(baseFinding())[0];
    const notRan = findingToCsvRow({ ...baseFinding(), provider: null, model: null })[0];
    assert.notEqual(ran, notRan);
});

test('check_id is stable for a collective (group) finding, whose sourceUrl is already the joined member-URL string', () => {
    const groupFinding = {
        ...baseFinding(),
        isCollective: true,
        groupId: 'g1',
        sourceUrl: 'https://a.example\nhttps://b.example',
    };
    const a = findingToCsvRow(groupFinding)[0];
    const b = findingToCsvRow({ ...groupFinding })[0];
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{12}$/);
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
