import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    knowledgeStatements, runKnowledgeCheck, isKnowledgeDoubted,
    KNOWLEDGE_OUTCOMES, KNOWLEDGE_OUTCOME_LIST, KNOWLEDGE_PROMPT_VERSION,
} from '../core/knowledge-check.js';
import { generateUncitedSystemPrompt, UNCITED_PROMPT_VERSION } from '../core/uncited-check.js';

const PARAGRAPH = 'The tower was designed by Koechlin. It was completed in 1899 as the entrance arch.';

const claims = [
    { key: 'a', claimText: 'It was completed in 1899 as the entrance arch.', sectionTitle: 'History', paragraphText: PARAGRAPH },
    { key: 'b', claimText: 'Its lifts were replaced in 1983.', sectionTitle: 'Lifts', paragraphText: 'Its lifts were replaced in 1983.' },
];

test('one prompt: the knowledge check is the uncited check under its own version', () => {
    assert.equal(KNOWLEDGE_PROMPT_VERSION, UNCITED_PROMPT_VERSION);
    assert.equal(UNCITED_PROMPT_VERSION, 'u2');
    const prompt = generateUncitedSystemPrompt();
    // u2 is true of cited statements too: it never says they have no citation.
    assert.doesNotMatch(prompt, /None of them has/);
    assert.match(prompt, /whether or not the article cites a source for it/);
    assert.match(prompt, /Never report a statement because of whether it has a citation/);
});

test('outcomes are doubted / not doubted / error, never "true"', () => {
    assert.deepEqual([...KNOWLEDGE_OUTCOME_LIST].sort(), ['doubted', 'error', 'not_doubted']);
});

test('knowledgeStatements: the text before the claim in its paragraph is its context', () => {
    const { uncited, keysByIndex } = knowledgeStatements(claims, { opening: 'The Eiffel Tower is a tower.' });
    assert.equal(uncited.opening, 'The Eiffel Tower is a tower.');
    assert.equal(uncited.sentences.length, 2);
    const [first] = uncited.sentences;
    assert.equal(uncited.paragraphs[first.paragraphIndex].text, PARAGRAPH);
    assert.equal(PARAGRAPH.slice(0, first.start).trim(), 'The tower was designed by Koechlin.');
    assert.deepEqual(keysByIndex, [['a'], ['b']]);
});

test('knowledgeStatements: claims sharing a text are one statement reported under every key', () => {
    const { uncited, keysByIndex } = knowledgeStatements([claims[0], { ...claims[0], key: 'a2' }, claims[1]]);
    assert.equal(uncited.sentences.length, 2);
    assert.deepEqual(keysByIndex[0], ['a', 'a2']);
});

test('knowledgeStatements: a claim not found in its paragraph gets no borrowed context', () => {
    const { uncited } = knowledgeStatements([{ key: 'x', claimText: 'Something else entirely.', paragraphText: PARAGRAPH }]);
    const [s] = uncited.sentences;
    assert.equal(uncited.paragraphs[s.paragraphIndex].text, 'Something else entirely.');
    assert.equal(s.start, 0);
});

test('the model is shown the claims and context, never a source, verdict or rationale', async () => {
    const seen = [];
    await runKnowledgeCheck({ claims, articleTitle: 'Eiffel Tower', opening: 'The Eiffel Tower is a tower.' }, {
        callModel: async (system, user) => { seen.push(user); return { text: '{"issues": []}', usage: { input: 1, output: 1 } }; },
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /Article: Eiffel Tower/);
    assert.match(seen[0], /1\. "It was completed in 1899 as the entrance arch\."/);
    assert.match(seen[0], /Earlier in the paragraph, for context:\nThe tower was designed by Koechlin\./);
    assert.doesNotMatch(seen[0], /SUPPORTED|source|rationale/i);
});

test('runKnowledgeCheck: a reported claim is doubted, the rest of the call not doubted', async () => {
    const run = await runKnowledgeCheck({ claims, articleTitle: 'Eiffel Tower' }, {
        callModel: async () => ({
            text: '{"issues": [{"id": 1, "excerpt": "completed in 1899", "comments": "It was completed in 1889.", "confidence": "high"}]}',
            usage: { input: 10, output: 5 },
        }),
    });
    const a = run.results.get('a');
    assert.equal(a.outcome, KNOWLEDGE_OUTCOMES.DOUBTED);
    assert.equal(a.confidence, 'high');
    assert.equal(a.comment, 'It was completed in 1889.');
    assert.equal(a.excerpt, 'completed in 1899');
    assert.equal(a.excerptStatus, 'exact');
    assert.ok(isKnowledgeDoubted(a));
    assert.equal(run.results.get('b').outcome, KNOWLEDGE_OUTCOMES.NOT_DOUBTED);
    assert.ok(!isKnowledgeDoubted(run.results.get('b')));
    assert.equal(run.promptVersion, 'u2');
    assert.deepEqual(run.usage, { input: 10, output: 5 });
});

test('runKnowledgeCheck: every doubted claim is kept, past the uncited check\'s per-article limit', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ key: i, claimText: `Statement number ${i} is here.` }));
    let call = 0;
    const run = await runKnowledgeCheck({ claims: many }, {
        chunkSize: 3,
        callModel: async () => {
            const base = call++ * 3;
            const issues = [0, 1, 2].map(j => ({ id: base + j + 1, excerpt: '', comments: 'wrong', confidence: 'high' }));
            return { text: JSON.stringify({ issues }), usage: {} };
        },
    });
    assert.equal([...run.results.values()].filter(isKnowledgeDoubted).length, 6);
});

test('runKnowledgeCheck: a failed call leaves its claims as error, not as not doubted', async () => {
    const run = await runKnowledgeCheck({ claims }, {
        chunkSize: 1,
        retry: { maxRetries: 1 },
        callModel: async (s, user) => {
            if (user.includes('1899')) throw new Error('boom');
            return { text: '{"issues": []}', usage: {} };
        },
        onChunkError: () => 'retries_exhausted',
    });
    assert.equal(run.results.get('a').outcome, KNOWLEDGE_OUTCOMES.ERROR);
    assert.equal(run.results.get('a').error, 'retries_exhausted');
    assert.equal(run.results.get('b').outcome, KNOWLEDGE_OUTCOMES.NOT_DOUBTED);
});

test('runKnowledgeCheck: a run stopped early has no result for the claims it never reached', async () => {
    let calls = 0;
    const run = await runKnowledgeCheck({ claims }, {
        chunkSize: 1,
        shouldAbort: () => calls >= 1,
        callModel: async () => { calls++; return { text: '{"issues": []}', usage: {} }; },
    });
    assert.equal(run.results.get('a').outcome, KNOWLEDGE_OUTCOMES.NOT_DOUBTED);
    assert.equal(run.results.has('b'), false);
});

test('runKnowledgeCheck: no claims, no call', async () => {
    const run = await runKnowledgeCheck({ claims: [] }, { callModel: async () => { throw new Error('called'); } });
    assert.equal(run.results.size, 0);
    assert.equal(run.calls, 0);
});
