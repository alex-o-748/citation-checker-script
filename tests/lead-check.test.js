import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    generateLeadSystemPrompt, generateLeadUserPrompt, parseLeadCheckResult, runLeadCheck,
    leadOutcomeFor, leadChunkSize, LEAD_OUTCOMES, LEAD_PROMPT_VERSION, LEAD_CHUNK_SIZE_DEFAULT,
    LEAD_BODY_MIN_CHARS,
} from '../core/lead-check.js';
import { fitBody } from '../core/lead.js';

// Same contract as the PROMPT_VERSION and SEVERITY_PROMPT_VERSION pins: lead
// verdicts from two prompt revisions are not comparable, and the stored
// prompt version only tells them apart if it moves. On a deliberate prompt
// change: bump LEAD_PROMPT_VERSION in core/lead-check.js and replace
// EXPECTED_HASH with the reported value.
test('LEAD_PROMPT_VERSION is bumped whenever the lead-check prompt changes', () => {
    const EXPECTED_HASH = 'f5e4afd9a2dee88adc66c0acd765f3876ae6e7255845ba64ae119c7a52a84b92';
    const actual = createHash('sha256').update(generateLeadSystemPrompt(), 'utf8').digest('hex');
    assert.equal(actual, EXPECTED_HASH,
        `generateLeadSystemPrompt() changed (hash now ${actual}) but LEAD_PROMPT_VERSION is still ` +
        `"${LEAD_PROMPT_VERSION}". Bump it and update EXPECTED_HASH.`);
});

test('the prompt keeps the body as the only evidence and the lead as context', () => {
    const prompt = generateLeadSystemPrompt();
    assert.match(prompt, /ONLY use the body text provided/);
    assert.match(prompt, /It is never evidence/);
    assert.match(prompt, /Specific details must actually appear in the body/);
    assert.doesNotMatch(prompt, /SOURCE UNAVAILABLE/, 'a body is never unavailable');
});

const sections = [
    { level: 2, heading: 'Early life', text: 'Maria was born in Warsaw in 1867.' },
    { level: 2, heading: 'Career', text: 'She shared the 1903 Nobel Prize in Physics with Pierre Curie.' },
];
const body = fitBody(sections);
const sentences = [
    { index: 0, paragraphIndex: 0, text: 'Marie Curie was born in Warsaw.' },
    { index: 1, paragraphIndex: 0, text: 'She won the 1903 Nobel Prize.' },
    { index: 2, paragraphIndex: 1, text: 'She founded an institute in 1920.' },
];

test('the user prompt numbers statements from 1 and gives the whole lead, by paragraph, as context', () => {
    const prompt = generateLeadUserPrompt({ articleTitle: 'Marie Curie', bodyText: body.text, leadSentences: sentences, statements: sentences.slice(1) });
    assert.equal(prompt, [
        'Article: Marie Curie',
        '',
        'Article body:',
        '== Early life ==\nMaria was born in Warsaw in 1867.\n\n== Career ==\nShe shared the 1903 Nobel Prize in Physics with Pierre Curie.',
        '',
        'The lead, for context only (it is never evidence):',
        'Marie Curie was born in Warsaw. She won the 1903 Nobel Prize.\n\nShe founded an institute in 1920.',
        '',
        'Statements from the lead to check:',
        '2. "She won the 1903 Nobel Prize."',
        '3. "She founded an institute in 1920."',
    ].join('\n'));
});

test('parseLeadCheckResult reads a bare, fenced or wrapped array and keeps only body verdicts', () => {
    const items = [
        { id: 1, verdict: 'SUPPORTED', support_score: 95, source_quote: ' Maria was born in Warsaw in 1867. ', section: 'Early life', comments: 'ok', reason_type: 'omission' },
        { id: '2', verdict: 'not supported', reason_type: 'Contradiction', support_score: '10' },
        { id: 3, verdict: 'SOURCE UNAVAILABLE' },
        { id: 'x', verdict: 'SUPPORTED' },
    ];
    for (const text of [
        JSON.stringify(items),
        'Here you go:\n```json\n' + JSON.stringify(items) + '\n```',
        JSON.stringify({ results: items }),
    ]) {
        const r = parseLeadCheckResult(text);
        assert.equal(r.ok, true);
        assert.deepEqual([...r.items.keys()], [1, 2]);
        assert.deepEqual(r.items.get(1), {
            verdict: 'SUPPORTED', reasonType: null, supportScore: 95,
            sourceQuote: 'Maria was born in Warsaw in 1867.', section: 'Early life', comments: 'ok',
        });
        assert.equal(r.items.get(2).verdict, 'NOT SUPPORTED');
        assert.equal(r.items.get(2).reasonType, 'contradiction');
        assert.equal(r.items.get(2).supportScore, 10);
        assert.equal(r.items.get(2).sourceQuote, '');
    }
    assert.deepEqual(parseLeadCheckResult('not json at all'), { ok: false, error: 'parse_error' });
    assert.deepEqual(parseLeadCheckResult('[{"id": 1, "verdict": "MAYBE"}]'), { ok: false, error: 'no_items' });
});

test('leadOutcomeFor maps verdicts onto what the editor is told', () => {
    assert.equal(leadOutcomeFor('SUPPORTED'), LEAD_OUTCOMES.COVERED);
    assert.equal(leadOutcomeFor('PARTIALLY SUPPORTED'), LEAD_OUTCOMES.NOT_COVERED);
    assert.equal(leadOutcomeFor('NOT SUPPORTED', 'omission'), LEAD_OUTCOMES.NOT_COVERED);
    assert.equal(leadOutcomeFor('NOT SUPPORTED', null), LEAD_OUTCOMES.NOT_COVERED);
    assert.equal(leadOutcomeFor('NOT SUPPORTED', 'contradiction'), LEAD_OUTCOMES.CONTRADICTED);
    assert.equal(leadOutcomeFor('SOURCE UNAVAILABLE'), null);
    assert.equal(leadOutcomeFor(null), null);
});

test('chunk sizes are per provider, with a default', () => {
    assert.equal(leadChunkSize('liftwing'), 3);
    assert.equal(leadChunkSize('claude'), 8);
    assert.equal(leadChunkSize('no-such-provider'), LEAD_CHUNK_SIZE_DEFAULT);
});

// A model that answers every statement it is asked about, from a script.
function scriptedModel(answer) {
    const calls = [];
    const callModel = async (systemPrompt, userContent, opts) => {
        calls.push({ systemPrompt, userContent, opts });
        const ids = [...userContent.matchAll(/^(\d+)\. "/gm)].map(m => Number(m[1]));
        return { text: JSON.stringify(ids.map(answer).filter(Boolean)), usage: { input: 100, output: 10 } };
    };
    return { callModel, calls };
}

test('runLeadCheck chunks the statements, maps answers back, and verifies each quote against the body', async () => {
    const { callModel, calls } = scriptedModel(id => ({
        1: { id, verdict: 'SUPPORTED', support_score: 90, source_quote: 'Maria was born in Warsaw in 1867.', section: 'Career' },
        2: { id, verdict: 'SUPPORTED', support_score: 90, source_quote: 'She shared the Nobel Prize in Chemistry.', section: 'Career' },
        3: { id, verdict: 'NOT SUPPORTED', reason_type: 'omission', support_score: 5, source_quote: '' },
    }[id]));
    const progress = [];
    const run = await runLeadCheck({ sentences, body, articleTitle: 'Marie Curie' }, {
        callModel, chunkSize: 2, onChunk: (done, total) => progress.push([done.length, total]),
    });

    assert.equal(calls.length, 2);
    assert.equal(run.calls, 2);
    assert.deepEqual(calls[0].opts, { kind: 'lead' }, 'the caller can raise the output budget for it');
    assert.deepEqual(progress, [[2, 3], [3, 3]]);
    assert.deepEqual(run.usage, { input: 200, output: 20 });
    assert.equal(run.promptVersion, LEAD_PROMPT_VERSION);
    assert.equal(run.bodyTruncated, false);

    const [a, b, c] = run.results;
    assert.equal(a.outcome, LEAD_OUTCOMES.COVERED);
    assert.equal(a.quoteStatus, 'exact');
    assert.equal(a.quoteText, 'Maria was born in Warsaw in 1867.');
    assert.equal(a.section, 'Early life', 'the section the quote is in beats the one the model named');
    assert.equal(b.quoteStatus, 'not-found');
    assert.equal(b.quoteText, null, 'an unlocated quote is never shown');
    assert.equal(b.section, 'Career', 'with no located quote, a real heading the model named is kept');
    assert.equal(c.outcome, LEAD_OUTCOMES.NOT_COVERED);
    assert.equal(c.error, null);
});

test('a statement the model skipped, or a chunk it answered unreadably, is recorded unchecked', async () => {
    let n = 0;
    const callModel = async () => {
        n++;
        return { text: n === 1 ? '[{"id": 1, "verdict": "SUPPORTED"}]' : 'I cannot help with that.', usage: null };
    };
    const run = await runLeadCheck({ sentences, body }, { callModel, chunkSize: 2 });
    assert.deepEqual(run.results.map(r => [r.index, r.verdict, r.error]), [
        [0, 'SUPPORTED', null],
        [1, null, 'missing_from_response'],
        [2, null, 'parse_error'],
    ]);
});

test('only: checks the named sentences, still sending the whole lead as context', async () => {
    const { callModel, calls } = scriptedModel(id => ({ id, verdict: 'SUPPORTED' }));
    const run = await runLeadCheck({ sentences, body, only: [2] }, { callModel });
    assert.deepEqual(run.results.map(r => r.index), [2]);
    assert.match(calls[0].userContent, /Marie Curie was born in Warsaw\. She won the 1903 Nobel Prize\./);
    assert.match(calls[0].userContent, /^3\. "She founded an institute in 1920\."$/m);
    assert.doesNotMatch(calls[0].userContent, /^1\. /m);
});

test('a prompt too long for the model is retried with the body halved, and later calls keep the smaller body', async () => {
    const big = fitBody(Array.from({ length: 8 }, (_, i) => ({ level: 2, heading: `S${i}`, text: `Section ${i} ${'text '.repeat(1000)}` })));
    assert.ok(big.chars > 4 * LEAD_BODY_MIN_CHARS);
    const lengths = [];
    const callModel = async (systemPrompt, userContent) => {
        lengths.push(userContent.length);
        if (userContent.length > big.chars * 0.6) throw new Error('Lift Wing API request failed (500): maximum context length is 8192 tokens');
        return { text: '[{"id": 1, "verdict": "SUPPORTED"}, {"id": 2, "verdict": "SUPPORTED"}, {"id": 3, "verdict": "SUPPORTED"}]', usage: null };
    };
    const run = await runLeadCheck({ sentences, body: big }, { callModel, chunkSize: 2, retry: { maxRetries: 1 } });
    assert.equal(lengths.length, 3, 'one rejected call, then one per chunk on the smaller body');
    assert.equal(run.bodyTruncated, true);
    assert.ok(run.bodyChars <= big.chars / 2);
    assert.deepEqual(run.results.map(r => [r.verdict, r.bodyTruncated]), [['SUPPORTED', true], ['SUPPORTED', true], ['SUPPORTED', true]]);
});

test('below the minimum body, the sentences are recorded as body_too_large; other errors are thrown', async () => {
    const tooLarge = async () => { throw new Error('API request failed (413): Request too large to send'); };
    const run = await runLeadCheck({ sentences, body }, { callModel: tooLarge, retry: { maxRetries: 1 } });
    assert.deepEqual(run.results.map(r => r.error), ['body_too_large', 'body_too_large', 'body_too_large']);

    const denied = async () => { throw new Error('API request failed (401): invalid key'); };
    await assert.rejects(runLeadCheck({ sentences, body }, { callModel: denied, retry: { maxRetries: 1 } }), /401/);
});

test('no body, or no sentences, means no model call', async () => {
    const callModel = async () => { throw new Error('must not be called'); };
    assert.deepEqual((await runLeadCheck({ sentences, body: fitBody([]) }, { callModel })).results, []);
    assert.deepEqual((await runLeadCheck({ sentences: [], body }, { callModel })).results, []);
    await assert.rejects(runLeadCheck({ sentences, body }, {}), /callModel/);
});

test('an answer that ran out of output budget is retried as two calls of half the sentences, down to one', async () => {
    const asked = [];
    const callModel = async (systemPrompt, userContent) => {
        const ids = [...userContent.matchAll(/^(\d+)\. "/gm)].map(m => Number(m[1]));
        asked.push(ids);
        // Thinks too long about more than one sentence, and about sentence 3 at all.
        if (ids.length > 1 || ids[0] === 3) {
            throw new Error('HuggingFace: the model ran out of output budget (16384 tokens) before answering');
        }
        return { text: JSON.stringify([{ id: ids[0], verdict: 'SUPPORTED' }]), usage: null };
    };
    const codes = [];
    const run = await runLeadCheck({ sentences, body }, {
        callModel, chunkSize: 3, retry: { maxRetries: 1 },
        onChunkError: error => { codes.push(error.message); return 'output_budget_exhausted'; },
    });
    assert.deepEqual(asked, [[1, 2, 3], [1, 2], [1], [2], [3]]);
    assert.deepEqual(run.results.map(r => [r.index, r.verdict, r.error]), [
        [0, 'SUPPORTED', null],
        [1, 'SUPPORTED', null],
        [2, null, 'output_budget_exhausted'],
    ], 'results stay in lead order; a single sentence that still runs out goes to the caller\'s policy');
    assert.equal(codes.length, 1);
});
