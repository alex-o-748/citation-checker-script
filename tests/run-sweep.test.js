import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCliArgs,
    splitCitations,
    runSweep,
    stubFetchSource,
    HELP_TEXT,
    main,
} from '../service/run-sweep.js';
import { ProviderAuthError } from '../service/verifier.js';

test('parseCliArgs defaults match run-replay.js\'s conventions (liftwing, no key needed)', () => {
    const opts = parseCliArgs(['node', 'sweep.js']);
    assert.equal(opts.criterion, 'failed-verification');
    assert.equal(opts.wiki, 'enwiki');
    assert.equal(opts.max, 5);
    assert.equal(opts.provider, 'liftwing');
    assert.equal(opts.model, 'llm-qwen36-27b');
    assert.equal(opts.delayMs, 1000);
    assert.equal(opts.liveSourceFetch, false);
    assert.equal(opts.store, false);
    assert.equal(opts.out, 'findings.csv');
});

test('parseCliArgs applies overrides', () => {
    const opts = parseCliArgs([
        'node', 'sweep.js', '--criterion', 'citation-needed', '--max', '10',
        '--provider', 'claude', '--model', 'claude-opus-5', '--live-source-fetch',
        '--store', '--out', 'out.csv',
    ]);
    assert.equal(opts.criterion, 'citation-needed');
    assert.equal(opts.max, 10);
    assert.equal(opts.provider, 'claude');
    assert.equal(opts.model, 'claude-opus-5');
    assert.equal(opts.liveSourceFetch, true);
    assert.equal(opts.store, true);
    assert.equal(opts.out, 'out.csv');
});

test('stubFetchSource never resolves content and names why', async () => {
    const result = await stubFetchSource('https://example.com', null);
    assert.equal(result.content, null);
    assert.match(result.error, /--live-source-fetch/);
});

test('splitCitations separates solo citations from adjacent groups, sorted by groupIndex', () => {
    const citations = [
        { citationNumber: '1', groupSize: 1 },
        { citationNumber: '3', groupId: 'g1', groupSize: 2, groupIndex: 1 },
        { citationNumber: '2', groupId: 'g1', groupSize: 2, groupIndex: 0 },
        { citationNumber: '4', groupSize: undefined },
    ];
    const { solos, groups } = splitCitations(citations);
    assert.deepEqual(solos.map(c => c.citationNumber), ['1', '4']);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map(c => c.citationNumber), ['2', '3'], 'sorted by groupIndex, not input order');
});

test('splitCitations handles an article with no groups at all', () => {
    const { solos, groups } = splitCitations([{ citationNumber: '1' }, { citationNumber: '2' }]);
    assert.equal(solos.length, 2);
    assert.equal(groups.length, 0);
});

// --- runSweep integration, with fakes for every external boundary ---

const link = url => `<a rel="nofollow" class="external text" href="${url}">source</a>`;

function article(prose, footnotes) {
    const body = prose.replace(/@@(\S+?)@@/g, (_, id) =>
        `<sup id="cite_ref-${id}" class="reference"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`
    );
    const list = Object.entries(footnotes)
        .map(([id, html]) => `<li id="cite_note-${id}">${html}</li>`)
        .join('');
    return `<!DOCTYPE html><body>${body}<ol class="references">${list}</ol></body>`;
}

// One solo citation [1] and one adjacent 2-member group [2][3].
const okArticleHtml = article(
    '<p>The bridge opened in 1998.@@1@@ It was built for $200 million.@@2@@@@3@@</p>',
    { 1: link('https://a.example/x'), 2: link('https://b.example/x'), 3: link('https://c.example/x') }
);

function fakeReplicaConnection(rows) {
    let calls = 0;
    return {
        execute: async () => { calls++; return calls === 1 ? [rows] : [[]]; },
        end: async () => {},
    };
}

function fakeToolsDbConnection() {
    const calls = [];
    let ended = false;
    return {
        calls,
        get ended() { return ended; },
        execute: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 1 }]; },
        end: async () => { ended = true; },
    };
}

const okCandidateRow = { pageId: 7, pageTitle: 'Test Article', revisionId: 123 };

const baseIo = (overrides = {}) => ({
    env: {},
    connectReplicas: async () => fakeReplicaConnection([okCandidateRow]),
    fetchArticle: async () => ({ html: okArticleHtml, status: 200, error: null }),
    fetchSourceFn: async url => ({ content: `text of ${url}`, status: 200, error: null }),
    makeModelCallerFn: () => async () => ({
        text: JSON.stringify({ confidence: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
        usage: { input: 10, output: 5 },
    }),
    writeCsvReportFn: async () => {},
    stdout: { write() {} },
    stderr: { write() {} },
    ...overrides,
});

const baseOpts = (overrides = {}) => ({
    criterion: 'failed-verification', wiki: 'enwiki', max: 1,
    provider: 'liftwing', model: 'llm-qwen36-27b', delayMs: 0,
    liveSourceFetch: false, store: false, out: 'findings.csv',
    ...overrides,
});

test('a full sweep writes one finding per solo citation plus one per completed group', async () => {
    let written;
    const code = await runSweep(baseOpts(), baseIo({
        writeCsvReportFn: async (findings, path) => { written = { findings, path }; },
    }));

    assert.equal(code, 0);
    assert.equal(written.path, 'findings.csv');
    // 3 per-source findings (citations 1, 2, 3) + 1 collective for the group.
    assert.equal(written.findings.length, 4);
    assert.equal(written.findings.filter(f => f.isCollective).length, 1);
    assert.equal(written.findings.filter(f => !f.isCollective).length, 3);
    const collective = written.findings.find(f => f.isCollective);
    assert.equal(collective.citationNumber, '2, 3');
    assert.equal(collective.sourceUrl, 'https://b.example/x\nhttps://c.example/x');
});

test('the funnel counts citations, not verification calls, so it stays monotonic', async () => {
    const stderrChunks = [];
    await runSweep(baseOpts(), baseIo({ stderr: { write: s => stderrChunks.push(s) } }));
    const out = stderrChunks.join('');
    assert.match(out, /3 citation\(s\) seen -> 3 had a URL -> 3 fetched -> 3 verified -> 0 flagged -> 0 published/);
    assert.match(out, /adjacent-citation groups: 1 checked, 0 skipped .*, 0 flagged/);
});

test('a group with only one usable source is skipped and contributes no collective finding', async () => {
    let written;
    const code = await runSweep(baseOpts(), baseIo({
        fetchSourceFn: async url => (url === 'https://c.example/x'
            ? { content: null, status: 403, error: 'forbidden' }
            : { content: `text of ${url}`, status: 200, error: null }),
        writeCsvReportFn: async findings => { written = findings; },
    }));

    assert.equal(code, 0);
    assert.equal(written.filter(f => f.isCollective).length, 0);
    assert.equal(written.length, 3, 'still one per-source finding each for citations 1, 2, 3');
});

test('--store upserts every finding into ToolsDB and closes the connection', async () => {
    const conn = fakeToolsDbConnection();
    const code = await runSweep(baseOpts({ store: true }), baseIo({
        connectToolsDb: async () => conn,
    }));

    assert.equal(code, 0);
    assert.equal(conn.calls.length, 4, 'one upsert per finding, same count as the CSV');
    assert.equal(conn.ended, true);
});

test('without --store, ToolsDB is never touched', async () => {
    let connectCalled = false;
    await runSweep(baseOpts(), baseIo({
        connectToolsDb: async () => { connectCalled = true; return fakeToolsDbConnection(); },
    }));
    assert.equal(connectCalled, false);
});

test('a missing required API key is reported and nothing runs', async () => {
    let replicasCalled = false;
    const code = await runSweep(
        baseOpts({ provider: 'claude', model: 'claude-opus-5' }),
        baseIo({ connectReplicas: async () => { replicasCalled = true; return fakeReplicaConnection([]); } })
    );
    assert.equal(code, 2);
    assert.equal(replicasCalled, false);
});

test('a non-positive-integer --max is rejected before any connection is made', async () => {
    let connected = false;
    const code = await runSweep(
        baseOpts({ max: 0 }),
        baseIo({ connectReplicas: async () => { connected = true; return fakeReplicaConnection([]); } })
    );
    assert.equal(code, 2);
    assert.equal(connected, false);
});

test('a Wiki Replicas connection failure is a fatal error', async () => {
    const code = await runSweep(baseOpts(), baseIo({
        connectReplicas: async () => { throw new Error('ECONNREFUSED'); },
    }));
    assert.equal(code, 1);
});

test('a ProviderAuthError halts the sweep and still writes the CSV with what was computed so far', async () => {
    let attempts = 0;
    let written;
    const stderrChunks = [];
    const code = await runSweep(baseOpts(), baseIo({
        makeModelCallerFn: () => async () => {
            attempts++;
            throw new ProviderAuthError('publicai: insufficient wallet balance', { status: 402 });
        },
        writeCsvReportFn: async findings => { written = findings; },
        stderr: { write: s => stderrChunks.push(s) },
    }));

    assert.equal(code, 3);
    assert.equal(attempts, 1, 'the sweep stops at the first auth/billing error');
    assert.deepEqual(written, [], 'nothing was computed before the halt, so the CSV is written empty, not skipped');
    assert.match(stderrChunks.join(''), /halting/);
});

test('a ProviderAuthError still closes an open ToolsDB connection', async () => {
    const conn = fakeToolsDbConnection();
    const code = await runSweep(baseOpts({ store: true }), baseIo({
        connectToolsDb: async () => conn,
        makeModelCallerFn: () => async () => { throw new ProviderAuthError('x', { status: 401 }); },
    }));
    assert.equal(code, 3);
    assert.equal(conn.ended, true);
});

test('an article that fails to fetch is counted but contributes no citations', async () => {
    let written;
    const code = await runSweep(baseOpts(), baseIo({
        fetchArticle: async () => ({ html: null, status: 404, error: 'not found' }),
        writeCsvReportFn: async findings => { written = findings; },
    }));
    assert.equal(code, 0);
    assert.deepEqual(written, []);
});

test('--help prints usage and exits 0 without connecting to anything', async () => {
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await main(['node', 'sweep.js', '--help'], { stdout });
    assert.equal(code, 0);
    assert.equal(stdout.chunks.join(''), HELP_TEXT);
});
