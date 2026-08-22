import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { runSweep, writeRecords, parseCliArgs } from '../service/store-findings.js';
import { SKIP_REASONS } from '../service/finding-record.js';

const parseHtml = html => new JSDOM(html).window.document;

// Same fixture shape as tests/pipeline.test.js: Parsoid-style anchors, no
// #mw-content-text wrapper.
function article(prose, footnotes) {
    const body = prose.replace(/@@(\S+?)@@/g, (_, id) =>
        `<sup id="cite_ref-${id}" class="reference"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`
    );
    const list = Object.entries(footnotes)
        .map(([id, html]) => `<li id="cite_note-${id}">${html}</li>`)
        .join('');
    return `<!DOCTYPE html><body>${body}<ol class="references">${list}</ol></body>`;
}

const link = url => `<a rel="nofollow" class="external text" href="${url}">source</a>`;

// One citation with a URL, one without (an offline book reference).
const mixedArticle = article(
    '<p>The bridge opened in 1998.@@1@@ It is 40 meters long.@@2@@</p>',
    { 1: link('https://example.com/a'), 2: 'Some Book, p. 5.' }
);

const groupArticle = article(
    '<p>The bridge opened in 1998.@@1@@@@2@@</p>',
    { 1: link('https://example.com/a'), 2: link('https://example.com/b') }
);

const candidate = { pageId: 7, title: 'Test Article', revisionId: 123 };

const fetchArticleOk = async () => ({ html: mixedArticle, status: 200, error: null });
const fetchSourceOk = async url => ({ content: `text of ${url}`, status: 200, error: null });
const fetchSourceStub = async () => ({ content: null, status: null, error: 'source fetching not wired up' });

async function fakeVerifyCitation() {
    return { verdict: 'SUPPORTED', confidence: 90, provider: 'publicai', model: 'qwen3-32b', tokensIn: 10, tokensOut: 5 };
}
async function fakeVerifyGroup() {
    return { verdict: 'PARTIALLY SUPPORTED', confidence: 60, provider: 'publicai', model: 'qwen3-32b', tokensIn: 30, tokensOut: 10 };
}

// --- parseCliArgs ---

test('parseCliArgs applies documented defaults', () => {
    const opts = parseCliArgs(['node', 'store-findings.js']);
    assert.equal(opts.criterion, 'failed-verification');
    assert.equal(opts.wiki, 'enwiki');
    assert.equal(opts.max, 3);
    assert.equal(opts.liveSourceFetch, false);
    assert.equal(opts.write, false, 'dry-run is the default — see the module header');
    assert.equal(opts.help, false);
});

test('parseCliArgs reads --write and --live-source-fetch as opt-in flags', () => {
    const opts = parseCliArgs(['node', 'store-findings.js', '--write', '--live-source-fetch', '--max', '10']);
    assert.equal(opts.write, true);
    assert.equal(opts.liveSourceFetch, true);
    assert.equal(opts.max, 10);
});

// --- runSweep: dry run (no connection) ---

test('runSweep in dry-run mode (no connection) computes records but writes nothing', async () => {
    const summary = await runSweep({
        candidates: [candidate],
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: fetchSourceOk,
        wiki: 'enwiki',
        sourceFetchEnabled: true,
        verifyCitation: fakeVerifyCitation,
        verifyGroup: fakeVerifyGroup,
        connection: null,
    });

    assert.equal(summary.articles, 1);
    // 1 URL citation (available) + 1 no-URL citation = 2 records, no group.
    assert.equal(summary.records, 2);
    assert.equal(summary.written, 0, 'dry run must never write');
    assert.deepEqual(summary.failed, []);
    assert.equal(summary.perArticle.length, 1);
    assert.equal(summary.perArticle[0].pageId, 7);
    assert.equal(summary.perArticle[0].records, 2);
});

test('a plain default run (no --live-source-fetch) never invokes the verifier — stage 4 gap does not block it', async () => {
    // Deliberately do NOT supply verifyCitation/verifyGroup — the built-in
    // "not implemented" defaults would throw if called. sourceFetchEnabled:
    // false must mean they're never reached.
    const summary = await runSweep({
        candidates: [candidate],
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: fetchSourceStub,
        wiki: 'enwiki',
        sourceFetchEnabled: false,
        connection: null,
    });

    assert.equal(summary.articles, 1);
    // The URL citation is stub-skipped; only the no-URL citation is stored.
    assert.equal(summary.records, 1);
    assert.equal(summary.skipped[SKIP_REASONS.STUB_SOURCE_FETCH], 1);
});

test('the default verifyCitation throws with a clear stage-4 message if actually invoked', async () => {
    await assert.rejects(
        runSweep({
            candidates: [candidate],
            parseHtml,
            fetchArticle: fetchArticleOk,
            fetchSource: fetchSourceOk,
            wiki: 'enwiki',
            sourceFetchEnabled: true,
            // No verifyCitation supplied — the built-in default must fire,
            // since fetchSourceOk gives the URL citation real content.
            connection: null,
        }),
        /stage 4 \(LLM verification\) isn't wired/
    );
});

// --- runSweep: with a group (collective row) ---

test('runSweep produces per-source and collective records for a citation group', async () => {
    const summary = await runSweep({
        candidates: [candidate],
        parseHtml,
        fetchArticle: async () => ({ html: groupArticle, status: 200, error: null }),
        fetchSource: fetchSourceOk,
        wiki: 'enwiki',
        sourceFetchEnabled: true,
        verifyCitation: fakeVerifyCitation,
        verifyGroup: fakeVerifyGroup,
        connection: null,
    });

    assert.equal(summary.articles, 1);
    assert.equal(summary.records, 3, '2 per-source + 1 collective');
});

// --- runSweep: skipped counts aggregate across articles ---

test('runSweep aggregates skip reasons across multiple articles', async () => {
    const blockedArticle = article('<p>Claim one.@@1@@</p>', { 1: link('https://example.com/blocked') });
    const candidates = [candidate, { pageId: 8, title: 'Second', revisionId: 456 }];
    let call = 0;
    const fetchArticleAlternating = async () => {
        call++;
        return { html: call === 1 ? mixedArticle : blockedArticle, status: 200, error: null };
    };
    const fetchSourceMixed = async (url) => {
        if (url.includes('blocked')) return { content: null, status: 403, error: 'Forbidden' };
        return { content: `text of ${url}`, status: 200, error: null };
    };

    const summary = await runSweep({
        candidates,
        parseHtml,
        fetchArticle: fetchArticleAlternating,
        fetchSource: fetchSourceMixed,
        wiki: 'enwiki',
        sourceFetchEnabled: true,
        verifyCitation: fakeVerifyCitation,
        verifyGroup: fakeVerifyGroup,
        connection: null,
    });

    assert.equal(summary.articles, 2);
    assert.equal(summary.skipped[SKIP_REASONS.BLOCKED_FETCH], 1);
});

// --- writeRecords: transaction + fallback ---

function fakeConnection({ failOn = null } = {}) {
    const calls = { execute: [], beginTransaction: 0, commit: 0, rollback: 0 };
    return {
        calls,
        beginTransaction: async () => { calls.beginTransaction++; },
        commit: async () => { calls.commit++; },
        rollback: async () => { calls.rollback++; },
        execute: async (sql, params) => {
            calls.execute.push({ sql, params });
            if (failOn && failOn(sql, params, calls.execute.length)) throw new Error('simulated write failure');
            return [{ affectedRows: 1 }];
        },
    };
}

function record(overrides = {}) {
    return {
        wiki: 'enwiki', pageId: 1, pageTitle: 'T', revisionId: 1,
        claimText: 'A claim', citationNumber: 1, refName: null,
        sourceUrl: 'https://example.com', fetchedAt: new Date(), groupId: null, isCollective: false,
        verdict: 'SUPPORTED', confidence: 90, reasonType: null, rationale: 'ok',
        provider: 'publicai', model: 'x', promptVersion: 'v1',
        fetchStatus: 200, sourceTruncated: false, tokensIn: 1, tokensOut: 1,
        expiresAt: new Date(), published: false,
        ...overrides,
    };
}

test('writeRecords with no records is a no-op — no transaction opened', async () => {
    const conn = fakeConnection();
    const result = await writeRecords(conn, []);
    assert.deepEqual(result, { written: 0, failed: [] });
    assert.equal(conn.calls.beginTransaction, 0);
});

test('writeRecords commits the whole batch in one transaction on success', async () => {
    const conn = fakeConnection();
    const records = [record({ pageId: 1 }), record({ pageId: 2 })];
    const result = await writeRecords(conn, records);

    assert.equal(result.written, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(conn.calls.beginTransaction, 1);
    assert.equal(conn.calls.commit, 1);
    assert.equal(conn.calls.rollback, 0);
});

test('writeRecords rolls back and falls back to per-row writes on a batch failure', async () => {
    // A 2-row bulk statement has 52 params; a per-row fallback statement has
    // 26. Fail only the bulk call so the fallback path is what's exercised.
    const conn = fakeConnection({ failOn: (sql, params) => params.length > 26 });
    const records = [record({ pageId: 1 }), record({ pageId: 2 })];
    const result = await writeRecords(conn, records);

    assert.equal(conn.calls.rollback, 1);
    assert.equal(result.written, 2, 'both rows succeed individually after the fallback');
    assert.deepEqual(result.failed, []);
    assert.ok(result.batchError);
});

test('writeRecords\' per-row fallback isolates one failing row without losing the others', async () => {
    const conn = fakeConnection({
        failOn: (sql, params) => {
            // Fail the bulk statement (forces fallback), then fail only the
            // per-row statement whose claim_text is 'BAD'.
            if (params.length > 26) return true; // multi-row bulk call
            return params.includes('BAD');
        },
    });
    const records = [record({ pageId: 1, claimText: 'GOOD' }), record({ pageId: 2, claimText: 'BAD' })];
    const result = await writeRecords(conn, records);

    assert.equal(result.written, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].record.claimText, 'BAD');
});

// --- runSweep + writeRecords wired together ---

test('runSweep writes through the connection when one is supplied', async () => {
    const conn = fakeConnection();
    const summary = await runSweep({
        candidates: [candidate],
        parseHtml,
        fetchArticle: fetchArticleOk,
        fetchSource: fetchSourceOk,
        wiki: 'enwiki',
        sourceFetchEnabled: true,
        verifyCitation: fakeVerifyCitation,
        verifyGroup: fakeVerifyGroup,
        connection: conn,
    });

    assert.equal(summary.written, 2);
    assert.equal(conn.calls.beginTransaction, 1);
    assert.equal(conn.calls.commit, 1);
});
