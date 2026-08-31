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
    assert.equal(opts.concurrency, 1);
    assert.equal(opts.liveSourceFetch, false);
    assert.equal(opts.liveLlmRouter, false);
    assert.equal(opts.store, false);
    assert.equal(opts.out, 'findings.csv');
    assert.equal(opts.claimScope, 'sentence');
});

test('parseCliArgs applies --claim-scope', () => {
    const opts = parseCliArgs(['node', 'sweep.js', '--claim-scope', 'paragraph']);
    assert.equal(opts.claimScope, 'paragraph');
});

test('parseCliArgs applies --live-llm-router', () => {
    const opts = parseCliArgs(['node', 'sweep.js', '--live-llm-router']);
    assert.equal(opts.liveLlmRouter, true);
});

test('parseCliArgs applies overrides', () => {
    const opts = parseCliArgs([
        'node', 'sweep.js', '--criterion', 'citation-needed', '--max', '10',
        '--provider', 'claude', '--model', 'claude-opus-5', '--live-source-fetch',
        '--concurrency', '8', '--store', '--out', 'out.csv',
    ]);
    assert.equal(opts.criterion, 'citation-needed');
    assert.equal(opts.max, 10);
    assert.equal(opts.provider, 'claude');
    assert.equal(opts.model, 'claude-opus-5');
    assert.equal(opts.liveSourceFetch, true);
    assert.equal(opts.concurrency, 8);
    assert.equal(opts.store, true);
    assert.equal(opts.out, 'out.csv');
});

test('parseCliArgs applies --title', () => {
    const opts = parseCliArgs(['node', 'sweep.js', '--title', 'Asia']);
    assert.equal(opts.title, 'Asia');
});

test('parseCliArgs leaves --title undefined by default', () => {
    const opts = parseCliArgs(['node', 'sweep.js']);
    assert.equal(opts.title, undefined);
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

// An article with `n` independent solo citations [1]..[n], each pointing at
// its own https://x.example/<i> — for exercising the verify-stage pool with
// more parallel tasks than a single small article naturally has.
function articleWithSoloCitations(n) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const prose = `<p>${ids.map(id => `Sentence ${id}.@@${id}@@`).join(' ')}</p>`;
    const footnotes = Object.fromEntries(ids.map(id => [id, link(`https://x.example/${id}`)]));
    return article(prose, footnotes);
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
        text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
        usage: { input: 10, output: 5 },
    }),
    writeCsvReportFn: async () => {},
    stdout: { write() {} },
    stderr: { write() {} },
    ...overrides,
});

const baseOpts = (overrides = {}) => ({
    criterion: 'failed-verification', wiki: 'enwiki', max: 1,
    provider: 'liftwing', model: 'llm-qwen36-27b', delayMs: 0, concurrency: 1,
    liveSourceFetch: false, store: false, out: 'findings.csv', claimScope: 'sentence',
    ...overrides,
});

test('--live-llm-router routes the liftwing call through tf-llm-router instead of the Cloudflare worker default', async () => {
    let seenConfig;
    await runSweep(baseOpts({ liveLlmRouter: true }), baseIo({
        makeModelCallerFn: config => {
            seenConfig = config;
            return async () => ({
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            });
        },
    }));
    assert.equal(seenConfig.workerBase, 'https://llm-router.toolforge.org');
});

test('--live-llm-router is ignored (with a warning) for a provider other than liftwing', async () => {
    let seenConfig;
    const stderrChunks = [];
    await runSweep(baseOpts({ liveLlmRouter: true, provider: 'publicai', model: 'aisingapore/Qwen-SEA-LION-v4-32B-IT' }), baseIo({
        makeModelCallerFn: config => {
            seenConfig = config;
            return async () => ({
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            });
        },
        stderr: { write: s => stderrChunks.push(s) },
    }));
    assert.equal(seenConfig.workerBase, undefined);
    assert.match(stderrChunks.join(''), /only affects --provider liftwing/);
});

test('without --live-llm-router, liftwing gets no workerBase override (defaults to the Cloudflare worker in core/providers.js)', async () => {
    let seenConfig;
    await runSweep(baseOpts(), baseIo({
        makeModelCallerFn: config => {
            seenConfig = config;
            return async () => ({
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            });
        },
    }));
    assert.equal(seenConfig.workerBase, undefined);
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

test('a ruwiki sweep localizes the system prompt for every model call, solo and group alike', async () => {
    const seenSystemPrompts = [];
    const code = await runSweep(baseOpts({ wiki: 'ruwiki' }), baseIo({
        makeModelCallerFn: () => async (systemPrompt) => {
            seenSystemPrompts.push(systemPrompt);
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
    }));

    assert.equal(code, 0);
    // Every citation gets its own per-source call (3, for [1][2][3]) plus one
    // collective call for the [2][3] group — same 4-call shape the plain
    // "full sweep" test above asserts on for findings.
    assert.equal(seenSystemPrompts.length, 4);
    for (const prompt of seenSystemPrompts) {
        assert.match(prompt, /Russian \(русский\)/, 'ruwiki sweep must localize every model call, not just some');
    }
});

test('an enwiki sweep leaves the system prompt in English (no langCode wired for the default wiki)', async () => {
    const seenSystemPrompts = [];
    await runSweep(baseOpts(), baseIo({
        makeModelCallerFn: () => async (systemPrompt) => {
            seenSystemPrompts.push(systemPrompt);
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
    }));

    for (const prompt of seenSystemPrompts) {
        assert.doesNotMatch(prompt, /LANGUAGE:/);
    }
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

test('a non-positive-integer --concurrency is rejected before any connection is made', async () => {
    let connected = false;
    const code = await runSweep(
        baseOpts({ concurrency: 0 }),
        baseIo({ connectReplicas: async () => { connected = true; return fakeReplicaConnection([]); } })
    );
    assert.equal(code, 2);
    assert.equal(connected, false);
});

test('an invalid --claim-scope is rejected before any connection is made', async () => {
    let connected = false;
    const code = await runSweep(
        baseOpts({ claimScope: 'article' }),
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

test('--title skips Wiki Replicas entirely and runs against exactly the resolved article', async () => {
    let replicasConnected = false;
    let resolvedWith;
    const code = await runSweep(baseOpts({ title: 'Asia', max: undefined }), baseIo({
        connectReplicas: async () => { replicasConnected = true; return fakeReplicaConnection([]); },
        resolveArticleRefFn: async title => {
            resolvedWith = title;
            return { pageId: 815, title: 'Asia', revisionId: 1234567 };
        },
    }));
    assert.equal(code, 0);
    assert.equal(replicasConnected, false, '--title must never touch Wiki Replicas');
    assert.equal(resolvedWith, 'Asia');
});

test('--title bypasses --max validation, even with no --max or an invalid one', async () => {
    const code = await runSweep(baseOpts({ title: 'Asia', max: 0 }), baseIo({
        resolveArticleRefFn: async () => ({ pageId: 815, title: 'Asia', revisionId: 1234567 }),
    }));
    assert.equal(code, 0);
});

test('--title reports a fatal error when the article does not resolve', async () => {
    const code = await runSweep(baseOpts({ title: 'Not A Real Article Title Xyz' }), baseIo({
        resolveArticleRefFn: async () => null,
    }));
    assert.equal(code, 1);
});

test('--title reports a fatal error when resolution itself fails', async () => {
    const code = await runSweep(baseOpts({ title: 'Asia' }), baseIo({
        resolveArticleRefFn: async () => { throw new Error('Wikipedia API returned HTTP 503'); },
    }));
    assert.equal(code, 1);
});

test('--title resolves against the --wiki-derived host, not always en.wikipedia.org', async () => {
    let seenOptions;
    const code = await runSweep(baseOpts({ wiki: 'ruwiki', title: 'Азия', max: undefined }), baseIo({
        resolveArticleRefFn: async (title, options) => {
            seenOptions = options;
            return { pageId: 1, title: 'Азия', revisionId: 1 };
        },
    }));
    assert.equal(code, 0);
    assert.equal(seenOptions.host, 'ru.wikipedia.org');
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

test('a non-auth, non-retryable error also halts and still writes the CSV, at exit code 4', async () => {
    // A message that does not match core/retry.js's RETRYABLE_STATUS /
    // RETRYABLE_NETWORK patterns, so it throws on the first attempt with no
    // backoff delay — this test is about the runner's halt behavior, not
    // withRetry's (covered separately by tests/retry.test.js). A retryable
    // 429 reaches this same catch block after withRetry exhausts its
    // attempts; the halt path doesn't care which kind of error it was.
    let attempts = 0;
    let written;
    const stderrChunks = [];
    const code = await runSweep(baseOpts(), baseIo({
        makeModelCallerFn: () => async () => {
            attempts++;
            throw new Error('Lift Wing: unexpected response shape');
        },
        writeCsvReportFn: async findings => { written = findings; },
        stderr: { write: s => stderrChunks.push(s) },
    }));

    assert.equal(code, 4);
    assert.equal(attempts, 1, 'the sweep stops at the first unrecoverable error');
    assert.deepEqual(written, [], 'nothing was computed before the halt, so the CSV is written empty, not skipped');
    assert.match(stderrChunks.join(''), /halting/);
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('--concurrency N actually runs up to N model calls at once, not more', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const code = await runSweep(baseOpts({ concurrency: 3 }), baseIo({
        fetchArticle: async () => ({ html: articleWithSoloCitations(6), status: 200, error: null }),
        makeModelCallerFn: () => async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await sleep(15);
            inFlight--;
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
    }));

    assert.equal(code, 0);
    assert.equal(maxInFlight, 3, 'exactly the configured concurrency should overlap, not 1 (serial) or 6 (unbounded)');
});

test('a context-length-exceeded failure records an ERROR finding and does NOT halt the sweep', async () => {
    let written;
    const code = await runSweep(baseOpts({ concurrency: 1 }), baseIo({
        fetchArticle: async () => ({ html: articleWithSoloCitations(3), status: 200, error: null }),
        makeModelCallerFn: () => async (systemPrompt, userContent) => {
            // Only the 2nd citation's source is "too big" — the other two
            // should still succeed normally, proving the run kept going
            // rather than halting on the one bad citation.
            if (userContent.includes('https://x.example/2')) {
                throw new Error(
                    'Lift Wing API request failed (500): VLLMValidationError: maximum context length is 32768 tokens'
                );
            }
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
        writeCsvReportFn: async findings => { written = findings; },
    }));

    assert.equal(code, 0, 'a context-length failure must not halt the sweep the way an unrecognized error does');
    assert.equal(written.length, 3, 'all 3 citations got a recorded finding, including the errored one');
    const verdicts = written.map(f => f.verdict).sort();
    assert.deepEqual(verdicts, ['ERROR', 'SUPPORTED', 'SUPPORTED']);
});

test('halting stops new dispatch but keeps findings already in flight when the halt was detected', async () => {
    let attempts = 0;
    let written;
    const code = await runSweep(baseOpts({ concurrency: 2 }), baseIo({
        fetchArticle: async () => ({ html: articleWithSoloCitations(6), status: 200, error: null }),
        makeModelCallerFn: () => async (systemPrompt, userContent) => {
            attempts++;
            // The 2nd citation fails immediately (no delay); the other 5
            // would succeed after a delay long enough that the immediate
            // failure is guaranteed to set `halted` well before any of them
            // resolve, so this deterministically exercises "in-flight work
            // present when halted flips still gets recorded."
            if (userContent.includes('https://x.example/2')) {
                throw new Error('Lift Wing: unexpected response shape');
            }
            await sleep(15);
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
        writeCsvReportFn: async findings => { written = findings; },
    }));

    assert.equal(code, 4);
    assert.ok(attempts < 6, `expected new dispatch to stop after halting, got ${attempts} attempts out of 6 possible`);
    assert.equal(written.length, 1, 'only the one call already in flight when the halt was detected should have completed and been recorded');
});

test('halting stops the producer from fetching further articles, not just further verifying', async () => {
    const candidates = [
        { pageId: 1, pageTitle: 'A', revisionId: 1 },
        { pageId: 2, pageTitle: 'B', revisionId: 2 },
        { pageId: 3, pageTitle: 'C', revisionId: 3 },
    ];
    let fetchCount = 0;
    const code = await runSweep(baseOpts({ max: 3, concurrency: 1 }), baseIo({
        connectReplicas: async () => fakeReplicaConnection(candidates),
        fetchArticle: async () => {
            fetchCount++;
            return { html: articleWithSoloCitations(1), status: 200, error: null };
        },
        makeModelCallerFn: () => async () => {
            throw new Error('Lift Wing: unexpected response shape');
        },
    }));

    assert.equal(code, 4);
    assert.equal(fetchCount, 1, 'article B and C should never be fetched once article A\'s only citation halted the run');
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

test('the timing summary reports real fetch and verify durations, not zeros', async () => {
    const stderrChunks = [];
    const code = await runSweep(baseOpts({ concurrency: 1 }), baseIo({
        fetchArticle: async () => {
            await sleep(30);
            return { html: articleWithSoloCitations(2), status: 200, error: null };
        },
        makeModelCallerFn: () => async () => {
            await sleep(20);
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
        stderr: { write: s => stderrChunks.push(s) },
    }));
    assert.equal(code, 0);

    const output = stderrChunks.join('');
    const timingLine = output.match(/sweep: timing — fetch \(serial, wall-clock\): ([\d.]+)s\. verify: (\d+) call\(s\), ([\d.]+)s/);
    assert.ok(timingLine, `expected a timing summary line, got:\n${output}`);

    const [, fetchSec, verifyCalls, verifySec] = timingLine;
    assert.ok(Number(fetchSec) >= 0.025, `fetch should reflect the ~30ms artificial delay, got ${fetchSec}s`);
    assert.equal(Number(verifyCalls), 2, 'both solo citations should have gone through a verify call');
    assert.ok(Number(verifySec) >= 0.035, `2 calls at ~20ms each should sum to at least ~40ms, got ${verifySec}s`);
});

test('the retries summary reports backoff time separately from verify time, distinguishing it from genuine model latency', async () => {
    let attempts = 0;
    const stderrChunks = [];
    const code = await runSweep(baseOpts({ concurrency: 1 }), baseIo({
        fetchArticle: async () => ({ html: articleWithSoloCitations(1), status: 200, error: null }),
        makeModelCallerFn: () => async () => {
            attempts++;
            if (attempts === 1) throw new Error('Lift Wing API request failed (503): temporarily unavailable');
            return {
                text: JSON.stringify({ support_score: 90, verdict: 'SUPPORTED', source_quote: '', comments: 'ok' }),
                usage: { input: 10, output: 5 },
            };
        },
        stderr: { write: s => stderrChunks.push(s) },
    }));
    assert.equal(code, 0);
    assert.equal(attempts, 2, 'the transient 503 should have been retried once, then succeeded');

    const output = stderrChunks.join('');
    const retriesLine = output.match(/sweep: retries — (\d+) failed attempt\(s\) across (\d+) call\(s\) retried at least once, ([\d.]+)s spent sleeping in backoff/);
    assert.ok(retriesLine, `expected a retries summary line, got:\n${output}`);

    const [, failedAttempts, callsRetried, backoffSec] = retriesLine;
    assert.equal(Number(failedAttempts), 1);
    assert.equal(Number(callsRetried), 1);
    // core/retry.js's default minBackoffMs is 1000 — the one retry here pays
    // at least that much in real backoff, which should now be visible as its
    // own number rather than hidden inside a generic "verify was slow".
    assert.ok(Number(backoffSec) >= 1.0, `expected at least ~1s of real backoff, got ${backoffSec}s`);
});

test('--help prints usage and exits 0 without connecting to anything', async () => {
    const stdout = { chunks: [], write(s) { this.chunks.push(s); } };
    const code = await main(['node', 'sweep.js', '--help'], { stdout });
    assert.equal(code, 0);
    assert.equal(stdout.chunks.join(''), HELP_TEXT);
});
