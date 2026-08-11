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

// --- PDF / OCR line-break hyphenation -----------------------------------
//
// Regression for a real First Baptist Church (Las Vegas, NM) check against an
// NRHP nomination PDF. The text layer breaks words across lines and leaves the
// hyphen behind; the model copied one such artifact verbatim ("two- story")
// and silently repaired another ("school-like"), so the quote came back
// 'partial' and the panel showed nothing.

const PDF_SOURCE = [
    'Three-story rectangular shape with symmetrical two-',
    'story wings; brick construction with stone trim.',
    '',
    'This utilitarian, school-',
    'like building reflected the practical values and emphasis on education',
    'of this congregation.',
].join('\n');

test('a quote matches whether the model kept or repaired a line-break hyphen', () => {
    // Kept as the source has it.
    assert.equal(verifyQuote(PDF_SOURCE, 'symmetrical two- story wings').verified, true);
    // Repaired into the ordinary spelling.
    assert.equal(verifyQuote(PDF_SOURCE, 'symmetrical two-story wings').verified, true);
    assert.equal(verifyQuote(PDF_SOURCE, 'This utilitarian, school-like building').verified, true);
});

test('a multi-fragment quote over hyphenated PDF text verifies whole', () => {
    const out = verifyQuote(PDF_SOURCE,
        'Three-story rectangular shape with symmetrical two- story wings;'
        + ' ... This utilitarian, school-like building reflected the practical values');
    assert.equal(out.verified, true);
    assert.equal(out.status, 'normalized');
});

test('hyphen folding does not make an unrelated passage match', () => {
    assert.equal(verifyQuote(PDF_SOURCE, 'a four-story steel and glass tower').verified, false);
});

// --- verifiedText: what a renderer is allowed to show --------------------

test('verifiedText is the whole quote when it verifies', () => {
    const out = verifyQuote(SOURCE, 'Construction faced multiple delays due to funding shortages.');
    assert.equal(out.verifiedText, 'Construction faced multiple delays due to funding shortages.');
});

test('verifiedText drops the fragments that were not located', () => {
    const out = verifyQuote(SOURCE,
        'broke ground in 1994 ... a passage that never appears anywhere ... four years behind schedule');
    assert.equal(out.status, 'partial');
    assert.ok(out.verifiedText.includes('broke ground in 1994'));
    assert.ok(out.verifiedText.includes('four years behind schedule'));
    assert.ok(!out.verifiedText.includes('never appears'), 'must not offer unlocated text for display');
});

test('verifiedText is empty when nothing was located', () => {
    assert.equal(verifyQuote(SOURCE, 'An entirely invented sentence about nothing.').verifiedText, '');
    assert.equal(verifyQuote(SOURCE, '').verifiedText, '');
    assert.equal(verifyQuote('', 'some long quoted passage').verifiedText, '');
});

test('a forgiven short fragment is never offered for display', () => {
    // "in 1994" is below the evidence threshold, so it does not fail the
    // quote — but it was not located either, and must not be shown.
    const out = verifyQuote(SOURCE, 'Construction faced multiple delays due to funding shortages. ... zz99');
    assert.equal(out.verified, true);
    assert.ok(!out.verifiedText.includes('zz99'));
});
