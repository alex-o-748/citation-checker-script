import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    generateUncitedSystemPrompt, generateUncitedUserPrompt, parseUncitedCheckResult, runUncitedCheck,
    locateExcerpt, rankUncitedFindings, uncitedChunkSize, withUncitedCommentLanguage,
    UNCITED_PROMPT_VERSION, UNCITED_PER_CALL_MAX, UNCITED_MAX_FINDINGS, UNCITED_CHUNK_SIZE_DEFAULT,
    UNCITED_CONTEXT_MAX_CHARS, UNCITED_VERDICT, UNCITED_REASON_TYPE,
} from '../core/uncited-check.js';
import { VERDICTS } from '../core/verdicts.js';

// Same contract as the PROMPT_VERSION, SEVERITY_PROMPT_VERSION and
// LEAD_PROMPT_VERSION pins: findings from two prompt revisions are not
// comparable, and the stored prompt version only tells them apart if it
// moves. On a deliberate prompt change: bump UNCITED_PROMPT_VERSION in
// core/uncited-check.js and replace EXPECTED_HASH with the reported value.
test('UNCITED_PROMPT_VERSION is bumped whenever the uncited-check prompt changes', () => {
    const EXPECTED_HASH = '3b17ed4b680b4c0c2c0f9f012486d97d800a948e282dd63c6059eaf1f20bcf5d';
    const actual = createHash('sha256').update(generateUncitedSystemPrompt(), 'utf8').digest('hex');
    assert.equal(actual, EXPECTED_HASH,
        `generateUncitedSystemPrompt() changed (hash now ${actual}) but UNCITED_PROMPT_VERSION is still ` +
        `"${UNCITED_PROMPT_VERSION}". Bump it and update EXPECTED_HASH.`);
});

test('the prompt asks for exceptions, few of them, and never for not knowing or for a missing citation', () => {
    const prompt = generateUncitedSystemPrompt();
    assert.match(prompt, /Report at most 3 statements/);
    assert.match(prompt, /Reporting none is a normal answer/);
    assert.match(prompt, /Never report a statement only because you do not know about it/);
    assert.match(prompt, /Never report a statement because it has no citation/);
    assert.match(prompt, /\{"issues": \[\]\}/);
    assert.equal(UNCITED_PER_CALL_MAX, 3);
    assert.doesNotMatch(prompt, /SUPPORTED|SOURCE UNAVAILABLE/, 'no verdict vocabulary: the model reports issues, not verdicts');
});

test('a finding is recorded in the shared verdict vocabulary', () => {
    assert.equal(UNCITED_VERDICT, VERDICTS.NOT_SUPPORTED);
    assert.equal(UNCITED_REASON_TYPE, 'doubtful');
});

const paragraphs = [
    { index: 0, sectionTitle: 'Early life', text: 'Maria was born in Warsaw. She was the youngest of five children. Her father taught mathematics.' },
    { index: 1, sectionTitle: 'Early life', text: 'It closed in 1990.' },
    { index: 2, sectionTitle: 'Career', text: 'She won the Nobel Prize in 1911. She founded the institute in 1920.' },
];
const sentences = [
    { index: 0, paragraphIndex: 0, sectionTitle: 'Early life', text: 'She was the youngest of five children.', start: 26 },
    { index: 1, paragraphIndex: 0, sectionTitle: 'Early life', text: 'Her father taught mathematics.', start: 65 },
    { index: 2, paragraphIndex: 1, sectionTitle: 'Early life', text: 'It closed in 1990.', start: 0 },
    { index: 3, paragraphIndex: 2, sectionTitle: 'Career', text: 'She won the Nobel Prize in 1911.', start: 0 },
    { index: 4, paragraphIndex: 2, sectionTitle: 'Career', text: 'She founded the institute in 1920.', start: 33 },
];
const uncited = { sentences, paragraphs, opening: 'Marie Curie was a physicist and chemist.' };

test('fixture offsets point at their sentences', () => {
    for (const s of sentences) assert.ok(paragraphs[s.paragraphIndex].text.slice(s.start).startsWith(s.text), s.text);
});

test('the user prompt numbers statements from 1, by paragraph, with the text before them as context', () => {
    const prompt = generateUncitedUserPrompt({ articleTitle: 'Marie Curie', opening: uncited.opening, paragraphs, statements: sentences });
    assert.equal(prompt, [
        'Article: Marie Curie',
        '',
        'Opening paragraph, for context:',
        'Marie Curie was a physicist and chemist.',
        '',
        'Section: Early life',
        'Earlier in the paragraph, for context:',
        'Maria was born in Warsaw.',
        'Statements to check:',
        '1. "She was the youngest of five children."',
        '2. "Her father taught mathematics."',
        '',
        'Statements to check:',
        '3. "It closed in 1990."',
        '',
        'Section: Career',
        'Statements to check:',
        '4. "She won the Nobel Prize in 1911."',
        '5. "She founded the institute in 1920."',
    ].join('\n'));
});

test('a chunk that starts mid-paragraph gets the earlier uncited sentences as context', () => {
    const prompt = generateUncitedUserPrompt({ paragraphs, statements: [sentences[1]] });
    assert.match(prompt, /Earlier in the paragraph, for context:\nMaria was born in Warsaw\. She was the youngest of five children\.\nStatements to check:\n2\. "Her father taught mathematics\."/);
    assert.doesNotMatch(prompt, /Article:|Opening paragraph/, 'both are optional');
});

test('long context keeps its end, closest to the statement', () => {
    const long = { index: 0, sectionTitle: null, text: `${'Earlier words here. '.repeat(200)}The statement itself.` };
    const prompt = generateUncitedUserPrompt({
        paragraphs: [long],
        statements: [{ index: 0, paragraphIndex: 0, text: 'The statement itself.', start: long.text.indexOf('The statement') }],
    });
    const context = prompt.split('\n')[1];
    assert.ok(context.startsWith('…'));
    assert.ok(context.length <= UNCITED_CONTEXT_MAX_CHARS + 1);
    assert.ok(context.endsWith('Earlier words here.'));
    assert.doesNotMatch(prompt, /Section:/, 'no heading for an article with none');
});

test('parse: the object form, a bare array, a fenced answer, string ids', () => {
    const issue = { id: '2', excerpt: 'mathematics', comments: 'He taught physics.', confidence: 'High' };
    for (const text of [
        JSON.stringify({ issues: [issue] }),
        JSON.stringify([issue]),
        '```json\n' + JSON.stringify({ issues: [issue] }) + '\n```',
        'Here you go: ' + JSON.stringify({ issues: [issue] }),
    ]) {
        assert.deepEqual(parseUncitedCheckResult(text), {
            ok: true,
            issues: [{ id: 2, excerpt: 'mathematics', comments: 'He taught physics.', confidence: 'high' }],
        }, text);
    }
});

test('parse: nothing found is a valid answer; low confidence and unusable ids are left out', () => {
    assert.deepEqual(parseUncitedCheckResult('{"issues": []}'), { ok: true, issues: [] });
    const parsed = parseUncitedCheckResult(JSON.stringify({ issues: [
        { id: 1, excerpt: 'a', comments: 'x', confidence: 'low' },
        { id: 'two', excerpt: 'b', comments: 'y', confidence: 'high' },
        { id: 3, excerpt: 'c', comments: 'z' },
        { id: 4, quote: 'd', problem: 'w', confidence: 'medium' },
    ] }));
    assert.deepEqual(parsed.issues, [{ id: 4, excerpt: 'd', comments: 'w', confidence: 'medium' }],
        'other field names are read too');
    assert.deepEqual(parseUncitedCheckResult('not json'), { ok: false, error: 'parse_error' });
    assert.deepEqual(parseUncitedCheckResult('{"verdict": "SUPPORTED"}'), { ok: false, error: 'parse_error' });
});

test('locateExcerpt: exact, normalized, not found, empty, and no minimum length inside a sentence', () => {
    const sentence = 'The tower was completed in 1899 for the “World’s Fair”.';
    assert.equal(locateExcerpt(sentence, 'completed in 1899'), 'exact');
    assert.equal(locateExcerpt(sentence, '1899'), 'exact', 'a short excerpt still means something in one sentence');
    assert.equal(locateExcerpt(sentence, 'COMPLETED IN 1899'), 'normalized');
    assert.equal(locateExcerpt(sentence, '"World\'s Fair"'), 'normalized');
    assert.equal(locateExcerpt(sentence, 'finished in 1899'), 'not-found');
    assert.equal(locateExcerpt(sentence, ''), 'empty');
    assert.equal(locateExcerpt(sentence, null), 'empty');
});

test('rank: high before medium, then article order', () => {
    const ranked = rankUncitedFindings([
        { index: 4, confidence: 'medium' }, { index: 2, confidence: 'high' },
        { index: 0, confidence: 'medium' }, { index: 3, confidence: 'high' },
    ]);
    assert.deepEqual(ranked.map(f => f.index), [2, 3, 0, 4]);
});

// A model stub: answers each call with `answer(statementNumbers)`, and
// records the prompts.
function stubModel(answer, { usage = { input: 100, output: 10 } } = {}) {
    const calls = [];
    const callModel = async (systemPrompt, userContent, opts) => {
        const numbers = [...userContent.matchAll(/^(\d+)\. "/gm)].map(m => Number(m[1]));
        calls.push({ systemPrompt, userContent, opts, numbers });
        return { text: JSON.stringify({ issues: answer(numbers) }), usage };
    };
    return { callModel, calls };
}

test('runUncitedCheck: findings carry the sentence, its section, the excerpt\'s status, and a share of tokens', async () => {
    const { callModel, calls } = stubModel(() => [
        { id: 4, excerpt: '1911', comments: 'Her second prize was in 1911; this is right, but say 1903 for the first.', confidence: 'medium' },
        { id: 5, excerpt: 'in 1920', comments: 'The Radium Institute was founded in 1909.', confidence: 'high' },
    ]);
    const run = await runUncitedCheck({ uncited, articleTitle: 'Marie Curie' }, { callModel });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts, { kind: 'uncited' });
    assert.deepEqual(run.findings.map(f => [f.index, f.sectionTitle, f.excerptStatus, f.confidence]), [
        [4, 'Career', 'exact', 'high'],
        [3, 'Career', 'exact', 'medium'],
    ]);
    assert.equal(run.findings[0].text, 'She founded the institute in 1920.');
    assert.equal(run.findings[0].comments, 'The Radium Institute was founded in 1909.');
    assert.equal(run.checked, 5);
    assert.deepEqual(run.unchecked, []);
    assert.deepEqual(run.usage, { input: 100, output: 10 });
    assert.equal(run.findings.reduce((n, f) => n + f.usage.input, 0), 100, 'shares sum to the call');
    assert.equal(run.promptVersion, UNCITED_PROMPT_VERSION);
});

test('runUncitedCheck: an empty answer is a check that found nothing', async () => {
    const { callModel } = stubModel(() => []);
    const run = await runUncitedCheck({ uncited }, { callModel });
    assert.deepEqual(run.findings, []);
    assert.equal(run.checked, 5);
    assert.equal(run.dropped, 0);
});

test('runUncitedCheck: chunks number statements globally, and the article keeps only its best findings', async () => {
    const { callModel, calls } = stubModel(numbers => numbers.map(n => ({
        id: n, excerpt: '', comments: `doubt ${n}`, confidence: n % 2 ? 'medium' : 'high',
    })));
    const run = await runUncitedCheck({ uncited }, { callModel, chunkSize: 2 });
    assert.deepEqual(calls.map(c => c.numbers), [[1, 2], [3, 4], [5]]);
    assert.equal(run.findings.length, UNCITED_MAX_FINDINGS);
    assert.deepEqual(run.findings.map(f => [f.index + 1, f.confidence]), [[2, 'high'], [4, 'high'], [1, 'medium']]);
    assert.equal(run.dropped, 2);

    const all = await runUncitedCheck({ uncited }, { callModel: stubModel(n => n.map(id => ({ id, confidence: 'high' }))).callModel, maxFindings: 10 });
    assert.equal(all.findings.length, 3, 'still at most UNCITED_PER_CALL_MAX from one call');
});

test('runUncitedCheck: an excerpt in a different statement moves the issue there; an issue for no statement is dropped', async () => {
    const { callModel } = stubModel(() => [
        // Off by one: id 1, but the words are statement 2's.
        { id: 1, excerpt: 'taught mathematics', comments: 'x', confidence: 'high' },
        // Not in the call at all, but its excerpt names statement 3.
        { id: 9, excerpt: 'closed in 1990', comments: 'y', confidence: 'high' },
        // Not in the call and nothing to go on.
        { id: 12, excerpt: 'nowhere', comments: 'z', confidence: 'high' },
    ]);
    const run = await runUncitedCheck({ uncited }, { callModel, maxFindings: 10 });
    assert.deepEqual(run.findings.map(f => [f.index + 1, f.excerptStatus]), [[2, 'exact'], [3, 'exact']]);
});

test('runUncitedCheck: an excerpt found nowhere stays on its id, recorded as not-found; a repeated statement counts once', async () => {
    const { callModel } = stubModel(() => [
        { id: 5, excerpt: 'opened a hospital', comments: 'x', confidence: 'high' },
        { id: 5, excerpt: '1920', comments: 'again', confidence: 'high' },
    ]);
    const run = await runUncitedCheck({ uncited }, { callModel });
    assert.deepEqual(run.findings.map(f => [f.index + 1, f.excerptStatus, f.comments]), [[5, 'not-found', 'x']]);
});

test('runUncitedCheck: an answer out of output budget is retried in halves, down to one statement', async () => {
    const calls = [];
    const callModel = async (systemPrompt, userContent) => {
        const numbers = [...userContent.matchAll(/^(\d+)\. "/gm)].map(m => Number(m[1]));
        calls.push(numbers);
        if (numbers.length > 2) throw new Error('HF: the model ran out of output budget (4096 tokens) before answering');
        return { text: '{"issues": []}', usage: { input: 1, output: 1 } };
    };
    const run = await runUncitedCheck({ uncited }, { callModel, chunkSize: 5 });
    assert.deepEqual(calls, [[1, 2, 3, 4, 5], [1, 2, 3], [1, 2], [3], [4, 5]]);
    assert.equal(run.checked, 5);
    assert.equal(run.calls, 5);
});

test('runUncitedCheck: a single statement too large is recorded; other failures go to onChunkError or throw', async () => {
    const tooLarge = async () => { throw new Error('API request failed (400): maximum context length exceeded'); };
    const big = await runUncitedCheck({ uncited: { ...uncited, sentences: sentences.slice(0, 1) } }, { callModel: tooLarge });
    assert.deepEqual(big.unchecked.map(u => u.error), ['source_too_large']);

    let n = 0;
    const flaky = async () => {
        n++;
        if (n === 1) throw new Error('API request failed (503): unavailable');
        return { text: '{"issues": []}', usage: { input: 1, output: 1 } };
    };
    const seen = [];
    const run = await runUncitedCheck({ uncited }, {
        callModel: flaky, chunkSize: 3, retry: { maxRetries: 1 },
        onChunkError: error => { seen.push(error.message); return 'retries_exhausted'; },
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(run.unchecked.map(u => [u.index, u.error]), [[0, 'retries_exhausted'], [1, 'retries_exhausted'], [2, 'retries_exhausted']]);
    assert.equal(run.checked, 2, 'the next call still ran');

    const failing = async () => { throw new Error('API request failed (503): unavailable'); };
    await assert.rejects(runUncitedCheck({ uncited }, { callModel: failing, retry: { maxRetries: 1 } }), /503/,
        'with no policy for it, the failure is thrown');
});

test('runUncitedCheck: an unreadable answer leaves its statements unchecked', async () => {
    const callModel = async () => ({ text: 'I think statement 2 is wrong.', usage: { input: 5, output: 5 } });
    const run = await runUncitedCheck({ uncited }, { callModel });
    assert.equal(run.checked, 0);
    assert.deepEqual([...new Set(run.unchecked.map(u => u.error))], ['parse_error']);
    assert.equal(run.unchecked.length, 5);
});

test('runUncitedCheck: nothing to check makes no call; callModel is required', async () => {
    const callModel = async () => { throw new Error('must not be called'); };
    const run = await runUncitedCheck({ uncited: { sentences: [], paragraphs: [] } }, { callModel });
    assert.equal(run.calls, 0);
    await assert.rejects(() => runUncitedCheck({ uncited }, {}), TypeError);
});

test('chunk sizes are per provider, with a default', () => {
    assert.ok(uncitedChunkSize('liftwing') < uncitedChunkSize('claude'));
    assert.equal(uncitedChunkSize('nonexistent'), UNCITED_CHUNK_SIZE_DEFAULT);
});

test('the language directive keeps the excerpt verbatim and English untouched', () => {
    const base = generateUncitedSystemPrompt();
    assert.equal(withUncitedCommentLanguage(base, { articleLangCode: 'en' }), base);
    assert.equal(withUncitedCommentLanguage(base, {}), base);
    const ru = withUncitedCommentLanguage(base, { lang: 'ru', articleLangCode: 'ru' });
    assert.match(ru, /Write the "comments" field in Russian \(русский\)\./);
    assert.match(ru, /"excerpt" field is an exception/);
    const de = withUncitedCommentLanguage(base, { lang: 'de', articleLangCode: 'de' });
    assert.match(de, /same language as the statements, not in English/);
});
