import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuote, normalizeForMatch, quoteExpectedFor } from '../core/quote.js';

const SOURCE = [
    'City Tribune - Local News',
    '',
    'The Morrison Bridge project broke ground in 1994 after years of planning.',
    'Construction faced multiple delays due to funding shortages. The bridge was',
    'finally opened to traffic in August 2002, four years behind schedule.',
    'Mayor Davis called it ‘a triumph of persistence’ — don’t forget the cost.',
].join('\n');

// --- normalizeForMatch ---

test('normalizeForMatch collapses whitespace and lowercases', () => {
    assert.equal(normalizeForMatch('  The   Bridge\n was\topened '), 'the bridge was opened');
});

test('normalizeForMatch folds curly quotes, dashes and exotic spaces', () => {
    assert.equal(
        normalizeForMatch('“a—b’s c”'),
        normalizeForMatch('"a-b\'s c"')
    );
});

test('normalizeForMatch tolerates null and undefined', () => {
    assert.equal(normalizeForMatch(null), '');
    assert.equal(normalizeForMatch(undefined), '');
});

// --- verifyQuote: the accepting cases ---

test('verbatim quote verifies as exact', () => {
    const out = verifyQuote(SOURCE, 'Construction faced multiple delays due to funding shortages.');
    assert.equal(out.verified, true);
    assert.equal(out.status, 'exact');
});

test('quote spanning a line break verifies after normalization', () => {
    // "The bridge was\nfinally opened" in the source, one line in the quote.
    const out = verifyQuote(SOURCE, 'The bridge was finally opened to traffic in August 2002');
    assert.equal(out.verified, true);
    assert.equal(out.status, 'normalized');
});

test('quote with swapped quote style and dash still verifies', () => {
    const out = verifyQuote(SOURCE, 'Mayor Davis called it "a triumph of persistence" - don\'t forget the cost.');
    assert.equal(out.verified, true);
});

test('quote wrapped in quotation marks by the model is unwrapped before matching', () => {
    const out = verifyQuote(SOURCE, '"Construction faced multiple delays due to funding shortages."');
    assert.equal(out.verified, true);
});

test('ellipsis-joined segments verify when both occur in order', () => {
    const out = verifyQuote(SOURCE, 'broke ground in 1994 ... opened to traffic in August 2002');
    assert.equal(out.verified, true);
    assert.equal(out.status, 'normalized');
    assert.deepEqual(out.segments.map(s => s.found), [true, true]);
});

test('unicode ellipsis and bracketed ellipsis are both accepted as joiners', () => {
    for (const joiner of ['…', '[...]', '[…]']) {
        const out = verifyQuote(SOURCE, `broke ground in 1994 ${joiner} four years behind schedule`);
        assert.equal(out.verified, true, `joiner ${JSON.stringify(joiner)} should verify`);
    }
});

// --- verifyQuote: the rejecting cases (the point of the module) ---

test('fabricated quote is not verified', () => {
    const out = verifyQuote(SOURCE, 'The bridge was completed in 1998 as originally planned.');
    assert.equal(out.verified, false);
    assert.equal(out.status, 'not-found');
});

test('paraphrase of a real sentence is not verified', () => {
    const out = verifyQuote(SOURCE, 'Construction was delayed several times because of a lack of funding.');
    assert.equal(out.verified, false);
});

test('segments out of order are reported as partial, not verified', () => {
    const out = verifyQuote(SOURCE, 'opened to traffic in August 2002 ... broke ground in 1994');
    assert.equal(out.verified, false);
    assert.equal(out.status, 'partial');
});

test('empty quote is reported as empty, not as a failure', () => {
    for (const empty of ['', '   ', null, undefined]) {
        const out = verifyQuote(SOURCE, empty);
        assert.equal(out.verified, false);
        assert.equal(out.status, 'empty');
    }
});

test('quote too short to be evidence is rejected even though it occurs', () => {
    const out = verifyQuote(SOURCE, '1994');
    assert.equal(out.verified, false);
    assert.equal(out.status, 'too-short');
});

test('missing source text yields no-source rather than a false negative', () => {
    const out = verifyQuote('', 'Construction faced multiple delays due to funding shortages.');
    assert.equal(out.verified, false);
    assert.equal(out.status, 'no-source');
});

test('a short trailing fragment after an ellipsis does not sink a real match', () => {
    // "in 1994" alone is below the evidence threshold; it should be ignored
    // rather than counted as a miss.
    const out = verifyQuote(SOURCE, 'Construction faced multiple delays due to funding shortages. ... in 1994');
    assert.equal(out.verified, true);
});

// --- quoteExpectedFor ---

test('quoteExpectedFor: supported and partial verdicts expect a quote', () => {
    assert.equal(quoteExpectedFor('SUPPORTED', null), true);
    assert.equal(quoteExpectedFor('PARTIALLY SUPPORTED', null), true);
});

test('quoteExpectedFor: contradiction expects a quote, omission does not', () => {
    assert.equal(quoteExpectedFor('NOT SUPPORTED', 'contradiction'), true);
    assert.equal(quoteExpectedFor('NOT SUPPORTED', 'omission'), false);
    assert.equal(quoteExpectedFor('NOT SUPPORTED', null), false);
});

test('quoteExpectedFor: source unavailable never expects a quote', () => {
    assert.equal(quoteExpectedFor('SOURCE UNAVAILABLE', null), false);
});
