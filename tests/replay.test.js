import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCliArgs,
    extractOldid,
    toCitation,
    runReplay,
    HELP_TEXT,
} from '../service/replay.js';
import { ProviderAuthError } from '../service/verify.js';

test('extractOldid pulls the pinned revision out of the dataset URL form', () => {
    assert.equal(
        extractOldid('https://en.wikipedia.org/w/index.php?title=Foo&oldid=123456'),
        123456
    );
    assert.equal(extractOldid('https://en.wikipedia.org/w/index.php?title=Foo'), null);
    assert.equal(extractOldid('not a url'), null);
});

test('toCitation wraps a dataset row with stored source_text into the fetch-result shape', () => {
    const citation = toCitation({
        claim_text: 'The bridge opened in 1998.',
        citation_number: 3,
        source_url: 'https://example.com/a',
        source_text: 'The bridge opened to traffic in 1998.',
    });
    assert.equal(citation.claimText, 'The bridge opened in 1998.');
    assert.equal(citation.url, 'https://example.com/a');
    assert.match(citation.source.content, /Source URL: https:\/\/example\.com\/a/);
    assert.match(citation.source.content, /The bridge opened to traffic in 1998\./);
    assert.equal(citation.source.status, 200);
});

test('toCitation marks a row with no stored source_text as unavailable, not fetched', () => {
    const citation = toCitation({
        claim_text: 'claim',
        citation_number: 1,
        source_url: 'https://example.com/a',
        source_text: '',
    });
    assert.equal(citation.source.content, null);
    assert.equal(citation.source.unavailableReason, 'fetch_failed');
});

test('parseCliArgs defaults to liftwing — the Toolforge migration provider — with no key requirement and a 1000ms delay', () => {
    const opts = parseCliArgs(['node', 'replay.js']);
    assert.equal(opts.provider, 'liftwing');
    assert.equal(opts.model, 'llm-qwen36-27b');
    assert.equal(opts.delayMs, 1000);
    assert.equal(opts.dryRun, false);
    assert.equal(opts.limit, Infinity);
});

test('liftwing requires no API key, matching main.js\'s requiresKey: false', async () => {
    const code = await runReplay(
        { provider: 'liftwing', dataset: 'unused', wiki: 'enwiki', limit: 1, delayMs: 0, dryRun: true, model: 'llm-qwen36-27b' },
        { env: {}, readFile: fakeDataset([okRow]), resolvePageIdsFn: okPageIds, makeModelCallerFn: okModelCaller, stdout: { write() {} }, stderr: { write() {} } }
    );
    assert.equal(code, 0, 'no CLAUDE_API_KEY-style env var should be demanded for liftwing');
});

test('parseCliArgs applies --limit, --dry-run, and a provider-specific default model', () => {
    const opts = parseCliArgs(['node', 'replay.js', '--limit', '5', '--dry-run', '--provider', 'claude']);
    assert.equal(opts.limit, 5);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.model, 'claude-sonnet-4-6');
});

test('parseCliArgs --model overrides the provider default', () => {
    const opts = parseCliArgs(['node', 'replay.js', '--provider', 'claude', '--model', 'claude-opus-5']);
    assert.equal(opts.model, 'claude-opus-5');
});

function fakeDataset(rows) {
    return async () => JSON.stringify({ metadata: {}, rows });
}

const okRow = {
    id: 'row_1',
    article_url: 'https://en.wikipedia.org/w/index.php?title=Test_Article&oldid=111',
    article_title: 'Test Article',
    citation_number: 1,
    claim_text: 'The bridge opened in 1998.',
    source_url: 'https://example.com/a',
    source_text: 'The bridge opened to traffic in 1998.',
};

const okPageIds = async () => new Map([['Test Article', 42]]);
const okModelCaller = () => async () => ({
    text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: 'The bridge opened to traffic in 1998.', comments: 'match' }),
    usage: { input: 10, output: 5 },
});

function fakeConnection() {
    const calls = [];
    let ended = false;
    return {
        calls,
        get ended() { return ended; },
        execute: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 1 }]; },
        end: async () => { ended = true; },
    };
}

test('a missing required API key is reported and nothing runs', async () => {
    const code = await runReplay(
        { provider: 'claude', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: true, model: 'm' },
        { env: {}, readFile: fakeDataset([okRow]), resolvePageIdsFn: okPageIds, makeModelCallerFn: okModelCaller }
    );
    assert.equal(code, 2);
});

test('a dataset read failure is reported as a fatal error', async () => {
    const code = await runReplay(
        { provider: 'publicai', dataset: 'missing.json', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: true, model: 'm' },
        { readFile: async () => { throw new Error('ENOENT'); }, resolvePageIdsFn: okPageIds, makeModelCallerFn: okModelCaller }
    );
    assert.equal(code, 1);
});

test('dry-run verifies and prints findings without connecting to ToolsDB', async () => {
    let dbConnectCalled = false;
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    const stderr = { chunks: [], write(s) { this.chunks.push(s); } };

    const code = await runReplay(
        { provider: 'publicai', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: true, model: 'm' },
        {
            readFile: fakeDataset([okRow]),
            resolvePageIdsFn: okPageIds,
            makeModelCallerFn: okModelCaller,
            connectToolsDb: async () => { dbConnectCalled = true; return fakeConnection(); },
            stdout, stderr,
        }
    );

    assert.equal(code, 0);
    assert.equal(dbConnectCalled, false, 'dry-run must never touch ToolsDB');
    const printed = JSON.parse(stdout.chunks[0]);
    assert.equal(printed.finding.verdict, 'SUPPORTED');
    assert.equal(printed.finding.published, false);
    assert.equal(printed.finding.pageId, 42);
});

test('a real run writes each finding via upsertFinding and closes the connection', async () => {
    const conn = fakeConnection();
    const code = await runReplay(
        { provider: 'publicai', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: false, model: 'm' },
        {
            readFile: fakeDataset([okRow]),
            resolvePageIdsFn: okPageIds,
            makeModelCallerFn: okModelCaller,
            connectToolsDb: async () => conn,
            stdout: { write() {} }, stderr: { write() {} },
        }
    );

    assert.equal(code, 0);
    assert.equal(conn.calls.length, 1, 'one INSERT ... ON DUPLICATE KEY UPDATE for the one row');
    assert.match(conn.calls[0].sql, /INSERT INTO citation_findings/);
    assert.equal(conn.ended, true, 'the connection is always closed');
});

test('a row whose title cannot be resolved to a page ID is skipped, not fatal', async () => {
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await runReplay(
        { provider: 'publicai', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: true, model: 'm' },
        {
            readFile: fakeDataset([okRow]),
            resolvePageIdsFn: async () => new Map(), // nothing resolves
            makeModelCallerFn: okModelCaller,
            stdout, stderr: { write() {} },
        }
    );
    assert.equal(code, 0);
    assert.equal(stdout.chunks.length, 0, 'no finding printed for an unresolved row');
});

test('a row with no oldid in its article_url is skipped, not fatal', async () => {
    const badRow = { ...okRow, article_url: 'https://en.wikipedia.org/w/index.php?title=Test_Article' };
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await runReplay(
        { provider: 'publicai', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: true, model: 'm' },
        {
            readFile: fakeDataset([badRow]),
            resolvePageIdsFn: okPageIds,
            makeModelCallerFn: okModelCaller,
            stdout, stderr: { write() {} },
        }
    );
    assert.equal(code, 0);
    assert.equal(stdout.chunks.length, 0);
});

test('a ProviderAuthError halts the run at exit code 3 and processes no further rows', async () => {
    const rows = [okRow, { ...okRow, id: 'row_2' }, { ...okRow, id: 'row_3' }];
    let callCount = 0;
    const authFailingCaller = () => async () => {
        callCount++;
        throw new ProviderAuthError('publicai: insufficient wallet balance', { status: 402 });
    };
    const stderr = { chunks: [], write(s) { this.chunks.push(s); } };

    const code = await runReplay(
        { provider: 'publicai', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: true, model: 'm' },
        {
            readFile: fakeDataset(rows),
            resolvePageIdsFn: okPageIds,
            makeModelCallerFn: authFailingCaller,
            stdout: { write() {} }, stderr,
        }
    );

    assert.equal(code, 3);
    assert.equal(callCount, 1, 'the run stops at the first auth/billing error, not after all rows');
    assert.match(stderr.chunks.join(''), /halting/);
});

test('a real run still closes the ToolsDB connection even when halted mid-run', async () => {
    const rows = [okRow, { ...okRow, id: 'row_2' }];
    const conn = fakeConnection();
    const authFailingCaller = () => async () => { throw new ProviderAuthError('x', { status: 401 }); };

    const code = await runReplay(
        { provider: 'publicai', dataset: 'unused', wiki: 'enwiki', limit: Infinity, delayMs: 0, dryRun: false, model: 'm' },
        {
            readFile: fakeDataset(rows),
            resolvePageIdsFn: okPageIds,
            makeModelCallerFn: authFailingCaller,
            connectToolsDb: async () => conn,
            stdout: { write() {} }, stderr: { write() {} },
        }
    );

    assert.equal(code, 3);
    assert.equal(conn.ended, true, 'the connection must close even on a halt, not just the happy path');
});

test('--help prints usage and exits 0 without touching the dataset', async () => {
    const { main } = await import('../service/replay.js');
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await main(['node', 'replay.js', '--help'], { stdout });
    assert.equal(code, 0);
    assert.equal(stdout.chunks.join(''), HELP_TEXT);
});
