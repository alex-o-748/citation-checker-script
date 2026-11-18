import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTriage, resilientModel, unframeSource, HaltError } from '../feedback-loop/run-triage.js';

function caseRow(overrides = {}) {
    return {
        check_id: 'aaaa0001', rating: -1, corrected_verdict: 'SUPPORTED',
        last_feedback_at: '2026-11-01T10:00:00+00:00', kind: 'source',
        article_url: 'https://en.wikipedia.org/wiki/Drought', article_title: 'Drought', revision_id: 1369727979,
        citation_number: '13', source_url: 'https://example.org/drought', provider: 'huggingface', model: 'openai/gpt-oss-20b',
        verdict: 'NOT SUPPORTED', reason_type: 'omission', claim_text: 'Droughts will be more frequent.',
        llm_comments: 'The source does not mention droughts.', source_quote: null, quote_status: 'empty',
        ...overrides,
    };
}

const CASES = [
    caseRow(),
    caseRow({ check_id: 'up000001', rating: 1, corrected_verdict: null, verdict: 'SUPPORTED', reason_type: null,
        source_url: 'https://example.org/bridge', claim_text: 'The bridge opened in 2002.', last_feedback_at: '2026-11-02T00:00:00Z' }),
    caseRow({ check_id: 'dead0001', source_url: 'https://example.org/dead', claim_text: 'Something on a dead page.' }),
    caseRow({ check_id: 'grp00001', kind: 'group', source_url: null, citation_number: '4, 5' }),
];

const PAGES = {
    'https://example.org/drought': 'Source URL: https://example.org/drought\nTruncated: true\n\nSource Content:\nThe report warns that droughts will be more frequent in future decades.',
    'https://example.org/bridge': 'Source URL: https://example.org/bridge\n\nSource Content:\nThe bridge opened to traffic in 2002 after delays.',
};
const fetchSource = async url => (PAGES[url] ? { content: PAGES[url], error: null } : { content: null, error: 'HTTP 404' });

// Answers by claim, not by call order: cases run concurrently.
function stubModel({ fail } = {}) {
    const calls = [];
    const callModel = async ({ purpose, userContent }) => {
        calls.push(purpose);
        if (fail) throw new Error(fail);
        if (purpose === 'blind') {
            const answer = userContent.includes('bridge')
                ? { verdict: 'SUPPORTED', evidence_quote: 'The bridge opened to traffic in 2002', explanation: 'Stated.' }
                : { verdict: 'SUPPORTED', evidence_quote: 'droughts will be more frequent in future decades', explanation: 'Stated.' };
            return { text: JSON.stringify(answer), usage: { input: 50, output: 5 } };
        }
        return { text: JSON.stringify({ cause: 'missed_evidence', tool_verdict_correct: false, editor_correct: true, explanation: 'Missed.' }), usage: { input: 20, output: 5 } };
    };
    return { calls, callModel };
}

test('unframeSource separates the body from the fetch header', () => {
    assert.deepEqual(unframeSource(PAGES['https://example.org/drought']), {
        sourceText: 'The report warns that droughts will be more frequent in future decades.',
        sourceTruncated: true,
    });
    assert.equal(unframeSource(PAGES['https://example.org/bridge']).sourceTruncated, false);
    assert.equal(unframeSource('plain pasted text').sourceText, 'plain pasted text');
});

test('a run triages, fails and skips each case for the right reason', async () => {
    const { calls, callModel } = stubModel();
    const out = await runTriage({ caseRows: CASES, fetchSource, callModel, date: '2026-11-15', model: 'stub' });
    assert.deepEqual(out.results.map(r => r.case.checkId), ['aaaa0001', 'up000001'], 'disputed first');
    assert.deepEqual(out.failures.map(f => [f.case.checkId, f.stage, f.error]), [['dead0001', 'fetch', 'HTTP 404']]);
    assert.deepEqual(out.skipped.map(s => [s.case.checkId, s.reason]), [['grp00001', 'group']]);
    assert.equal(calls.filter(p => p === 'blind').length, 2);
    assert.equal(calls.filter(p => p === 'attribution').length, 1, 'the endorsed, agreed case needs no attribution');
    assert.equal(out.changed, true);
    assert.deepEqual(out.merged.added.sort(), ['aaaa0001', 'up000001']);
    const drought = out.merged.rows.find(r => r.field.check_id === 'aaaa0001');
    assert.equal(drought.source_truncated, true);
    assert.equal(drought.ground_truth, 'Supported');
    assert.equal(drought.needs_manual_review, false);
    assert.deepEqual(out.usage, { input: 120, output: 15, calls: 3 });
    assert.equal(out.accepted, 2, 'agreed rows are accepted as they land');
    assert.equal(out.held, 0);
    assert.match(out.report, /\*\*2\*\* cases triaged: \*\*2\*\* accepted/);
    assert.equal(out.halted, null);
});

test('when spot-checks keep failing, agreed rows are held for the owner', async () => {
    // Two of the owner's recent spot-checks found wrong labels.
    const audited = ['old00001', 'old00002', 'old00003'].map((id, i) => ({
        id: `field_${id}`, ground_truth: 'Supported', needs_manual_review: false,
        field: { check_id: id, label: { status: 'owner', proposed_ground_truth: 'Supported' },
            audit: { result: i < 2 ? 'wrong' : 'ok', at: `2026-11-1${i}T00:00:00Z` } },
    }));
    const out = await runTriage({ caseRows: CASES, fieldRows: audited, fetchSource, callModel: stubModel().callModel, date: '2026-11-15' });
    assert.equal(out.autoAccept.paused, true);
    assert.equal(out.accepted, 0);
    assert.equal(out.held, 2);
    const drought = out.merged.rows.find(r => r.field.check_id === 'aaaa0001');
    assert.equal(drought.needs_manual_review, true);
    assert.match(drought.field.label.reasons.join(' '), /auto-accept is paused \(2 of the last 3 spot-checks were wrong\)/);
});

test('running again over the merged set triages nothing new', async () => {
    const first = await runTriage({ caseRows: CASES, fetchSource, callModel: stubModel().callModel, date: '2026-11-15' });
    const { calls, callModel } = stubModel();
    const second = await runTriage({ caseRows: CASES, fieldRows: first.merged.rows, fetchSource, callModel, date: '2026-11-16' });
    assert.equal(second.changed, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(second.results, []);
    assert.deepEqual(second.failures.map(f => f.case.checkId), ['dead0001'], 'a failed fetch is retried each run');
    assert.equal(second.skipped.filter(s => s.reason === 'already_triaged').length, 2);
});

test('a dry run fetches and tags but calls no model and changes nothing', async () => {
    const out = await runTriage({ caseRows: CASES, fetchSource, dryRun: true, date: '2026-11-15' });
    assert.equal(out.changed, false);
    assert.equal(out.results.length, 2);
    assert.ok(out.results.every(r => r.adjudication === null && Array.isArray(r.hints)));
    assert.match(out.report, /dry run: no model calls/);
});

test('an auth failure halts the run, keeps what was done and defers the rest', async () => {
    const { callModel } = stubModel({ fail: 'API request failed (401): invalid x-api-key' });
    const out = await runTriage({ caseRows: CASES, fetchSource, callModel: resilientModel(callModel, { sleep: async () => {} }), concurrency: 1, date: '2026-11-15' });
    assert.match(out.halted, /\(401\)/);
    assert.equal(out.changed, false);
    assert.ok(out.deferred.length >= 1, 'cases not reached are deferred, not dropped');
});

test('runTriage refuses to run without a model unless it is a dry run', async () => {
    await assert.rejects(runTriage({ caseRows: CASES, fetchSource, date: 'x' }), /needs callModel/);
});

test('resilientModel retries overloads, gives up on other errors, halts on billing', async () => {
    let attempts = 0;
    const flaky = resilientModel(async () => {
        attempts++;
        if (attempts < 3) throw new Error('API request failed (529): overloaded');
        return { text: 'ok' };
    }, { sleep: async () => {} });
    assert.deepEqual(await flaky({}), { text: 'ok' });
    assert.equal(attempts, 3);

    let badRequests = 0;
    const bad = resilientModel(async () => { badRequests++; throw new Error('API request failed (400): bad'); }, { sleep: async () => {} });
    await assert.rejects(bad({}), /\(400\)/);
    assert.equal(badRequests, 1, 'a 400 is not retried');

    const broke = resilientModel(async () => { throw new Error('API request failed (402): credit balance too low'); }, { sleep: async () => {} });
    await assert.rejects(broke({}), HaltError);
});
