import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    CONFLICT_PROMPT_VERSION, generateConflictSystemPrompt, generateConflictUserPrompt,
    parseConflictResult, locateSpan, checkConflict,
} from '../service/cards/conflict.js';

// Same contract as the other prompt pins: cards cache decisions per prompt
// version, so a prompt change that keeps the version would reuse answers to
// a different question.
const EXPECTED_HASH = '797fc689d4b8d1fab39b198f0386d9b20ded8c77fadf1fc05d1d437a1a1150b6';

test('CONFLICT_PROMPT_VERSION is bumped whenever the conflict prompt changes', () => {
    const actual = createHash('sha256').update(generateConflictSystemPrompt(), 'utf8').digest('hex');
    assert.equal(actual, EXPECTED_HASH,
        `generateConflictSystemPrompt() changed (hash now ${actual}) but CONFLICT_PROMPT_VERSION is still ` +
        `"${CONFLICT_PROMPT_VERSION}". Bump it and update EXPECTED_HASH.`);
});

// benchmark row_186
const CZW = {
    claim: 'Combat Zone Wrestling (CZW) is an American independent professional wrestling promotion founded in 1999 by John Zandig.',
    quote: 'CZW was born in a simpler time, way back in 1998, by John Zandig in Philadelphia',
};

test('a real contradiction is kept, with both spans located in the texts', () => {
    const r = parseConflictResult(
        '{"claim_span": "1999", "quote_span": "1998", "both_can_be_true": false, "reason": "A company is founded once."}',
        CZW,
    );
    assert.equal(r.ok, true);
    assert.equal(r.keep, true);
    assert.equal(CZW.claim.slice(r.claimSpan.start, r.claimSpan.end), '1999');
    assert.equal(CZW.quote.slice(r.quoteSpan.start, r.quoteSpan.end), '1998');
    assert.equal(r.reason, 'A company is founded once.');
});

test('"both can be true" drops the card: a moving figure is not an error (row_104)', () => {
    const r = parseConflictResult(
        '```json\n{"claim_span": "six", "quote_span": "5", "both_can_be_true": true, "reason": "Store counts change."}\n```',
        { claim: 'The company operates six locations.', quote: 'Only 5 locations are still in operation' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.keep, false);
    assert.equal(r.claimSpan, null);
});

test('a span the model invented drops the card rather than highlighting nothing', () => {
    const r = parseConflictResult('{"claim_span": "2001", "quote_span": "1998", "both_can_be_true": false}', CZW);
    assert.deepEqual(r, { ok: false, error: 'claim_span_not_found' });
    const q = parseConflictResult('{"claim_span": "1999", "quote_span": "in 1997", "both_can_be_true": false}', CZW);
    assert.deepEqual(q, { ok: false, error: 'quote_span_not_found' });
});

test('spans that say the same thing, empty spans and unparseable answers are errors', () => {
    assert.equal(parseConflictResult('{"claim_span": "John Zandig", "quote_span": "John Zandig", "both_can_be_true": false}', CZW).error, 'spans_identical');
    assert.equal(parseConflictResult('{"claim_span": "", "quote_span": "1998", "both_can_be_true": false}', CZW).error, 'empty_span');
    assert.equal(parseConflictResult('not json', CZW).error, 'parse_error');
    assert.equal(parseConflictResult('{"claim_span": "1999", "quote_span": "1998"}', CZW).error, 'no_both_can_be_true');
});

test('a span covering most of the sentence points at nothing and is rejected', () => {
    const r = parseConflictResult(JSON.stringify({ claim_span: CZW.claim.slice(0, 100), quote_span: '1998', both_can_be_true: false }), CZW);
    assert.equal(r.error, 'claim_span_too_long');
});

test('locateSpan folds quote style, dashes, case and whitespace, and maps back to original offsets', () => {
    const text = 'His record stands at 6–5 and he said “it’s  over”.';
    const dash = locateSpan(text, '6-5');
    assert.equal(text.slice(dash.start, dash.end), '6–5');
    const quoted = locateSpan(text, '"It\'s over"');
    assert.equal(text.slice(quoted.start, quoted.end), '“it’s  over”');
    assert.equal(locateSpan(text, '6-4'), null);
    assert.equal(locateSpan(text, ''), null);
});

test('locateSpan keeps offsets right after a character whose lowercase is longer', () => {
    const text = 'İstanbul was founded in 660 BC';
    const at = locateSpan(text, '660 bc');
    assert.equal(text.slice(at.start, at.end), '660 BC');
});

test('checkConflict sends the claim and quote and returns the parsed decision', async () => {
    let seen;
    const r = await checkConflict(
        { articleTitle: 'Combat Zone Wrestling', ...CZW, sourceLabel: 'lastwordonsports.com' },
        {
            callModel: async args => {
                seen = args;
                return { text: '{"claim_span":"1999","quote_span":"1998","both_can_be_true":false,"reason":"x"}', usage: { input: 1, output: 1 } };
            },
        },
    );
    assert.equal(r.keep, true);
    assert.equal(r.promptVersion, CONFLICT_PROMPT_VERSION);
    assert.match(seen.userContent, /Sentence: Combat Zone Wrestling/);
    assert.match(seen.userContent, /Passage \(from lastwordonsports\.com\): CZW was born/);
    assert.equal(seen.systemPrompt, generateConflictSystemPrompt());
});

test('the user prompt never carries a verdict or a rationale, only the texts', () => {
    const prompt = generateConflictUserPrompt({ articleTitle: 'A', claim: 'B', quote: 'C' });
    assert.equal(prompt, 'Article: A\nSentence: B\nPassage: C');
});
