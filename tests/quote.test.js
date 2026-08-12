import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    verifyQuote,
    normalizeForMatch,
    quoteExpectedFor,
    QUOTE_STATUSES,
    QUOTE_STATUS_LIST,
    VERIFIED_STATUSES,
} from '../core/quote.js';

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

// --- the status vocabulary ----------------------------------------------
//
// quote_status leaves the client and is validated against a hardcoded copy of
// this list in the Cloudflare Worker (alex-o-748/public-ai-proxy,
// src/index.js), which stores NULL for anything it does not recognize. The
// copy cannot be imported across repos, so these tests exist to make a change
// here impossible to make silently.

test('QUOTE_STATUS_LIST is exactly this set — changing it is a two-repo change', () => {
    // If this fails you have added or renamed a status. Update
    // QUOTE_STATUS_VALUES in the Worker's src/index.js in the same breath, or
    // the new value will be written to the database as NULL.
    assert.deepEqual([...QUOTE_STATUS_LIST].sort(), [
        'empty', 'exact', 'no-source', 'normalized', 'not-found', 'partial', 'too-short',
    ]);
});

test('every status verifyQuote can return is in QUOTE_STATUS_LIST', () => {
    const cases = [
        [SOURCE, ''],                                                        // empty
        ['',     'a quote with no source to check'],                         // no-source
        [SOURCE, '1994'],                                                    // too-short
        [SOURCE, 'Construction faced multiple delays due to funding shortages.'], // exact
        [SOURCE, 'The bridge was finally opened to traffic in August 2002'],  // normalized
        [SOURCE, 'broke ground in 1994 ... nothing like this appears here'],  // partial
        [SOURCE, 'An entirely invented sentence about nothing.'],             // not-found
    ];
    const seen = new Set();
    for (const [source, quote] of cases) {
        const { status } = verifyQuote(source, quote);
        assert.ok(QUOTE_STATUS_LIST.includes(status), `undeclared status: ${status}`);
        seen.add(status);
    }
    // Both directions: no undeclared status escapes, and no declared status is
    // dead weight that the Worker is validating against for nothing.
    assert.deepEqual([...seen].sort(), [...QUOTE_STATUS_LIST].sort(),
        'every declared status should be reachable');
});

test('verified is true exactly for the VERIFIED_STATUSES', () => {
    const cases = [
        [SOURCE, 'Construction faced multiple delays due to funding shortages.'],
        [SOURCE, 'The bridge was finally opened to traffic in August 2002'],
        [SOURCE, 'An entirely invented sentence about nothing.'],
        [SOURCE, 'broke ground in 1994 ... nothing like this appears here'],
        [SOURCE, '1994'],
        [SOURCE, ''],
        ['',     'a quote with no source to check'],
    ];
    for (const [source, quote] of cases) {
        const { verified, status } = verifyQuote(source, quote);
        assert.equal(verified, VERIFIED_STATUSES.includes(status),
            `verified/${status} disagree`);
    }
});

test('the status constants are frozen', () => {
    assert.throws(() => { QUOTE_STATUSES.EXACT = 'nope'; }, TypeError);
    assert.throws(() => { QUOTE_STATUS_LIST.push('nope'); }, TypeError);
});

// --- HTML entities surviving upstream extraction -------------------------
//
// Regression for a real Harmon Killebrew check against twincities.com. The
// Worker's extractText() decodes only &nbsp; &amp; &lt; &gt;, so a WordPress
// page reaches the model as "the mall&#8217;s amusement park". The model reads
// that as an apostrophe and quotes it back decoded, and the raw entity then
// failed to match the character it denotes.

const ENTITY_SOURCE = 'Only one is honored at the Mall of America, where a stadium seat '
    + 'mounted in the mall&#8217;s amusement park marks the spot where his long homer '
    + 'landed in the upper deck.';

test('a quote matches source text that still carries a numeric entity', () => {
    const out = verifyQuote(ENTITY_SOURCE,
        "Only one is honored at the Mall of America, where a stadium seat mounted in "
        + "the mall's amusement park marks the spot where his long homer landed in the upper deck.");
    assert.equal(out.verified, true);
    assert.equal(out.status, QUOTE_STATUSES.NORMALIZED);
});

test('numeric, hex and named entity forms all fold to the same character', () => {
    const quote = "the mall's amusement park marks the spot";
    for (const form of ['&#8217;', '&#x2019;', '&#X2019;', '&rsquo;', '’', "'"]) {
        const source = `the mall${form}s amusement park marks the spot`;
        assert.equal(verifyQuote(source, quote).verified, true, `form ${form} should match`);
    }
});

test('entity decoding runs in the other direction too', () => {
    // A model that copies the entity verbatim from the source must also match
    // against a source that has the real character.
    assert.equal(
        verifyQuote('the mall’s amusement park marks the spot',
                    'the mall&#8217;s amusement park marks the spot').verified,
        true
    );
});

test('common punctuation entities are decoded', () => {
    const source = 'He said &ldquo;yes&rdquo; &mdash; then left&hellip; and never came back';
    assert.equal(verifyQuote(source, 'He said "yes" — then left… and never came back').verified, true);
});

test('a malformed or unknown entity is left alone rather than mangled', () => {
    // &notareal; is not an entity; it must not silently vanish or throw.
    assert.equal(normalizeForMatch('a &notareal; b'), 'a &notareal; b');
    assert.equal(normalizeForMatch('a &#99999999999; b'), 'a &#99999999999; b');
    assert.equal(normalizeForMatch('a &#xD800; b'), 'a &#xd800; b');
    assert.equal(normalizeForMatch('50% off & more'), '50% off & more');
});

test('entity decoding does not make an unrelated passage match', () => {
    assert.equal(verifyQuote(ENTITY_SOURCE, 'a completely different sentence about hockey').verified, false);
});

// --- the rest of the extraction-artifact sweep ---------------------------
//
// Found by probing the known text manglers (worker extractText, PDF text
// layers, model reformatting) against quotes that are genuinely correct.

test('Latin-1 letter entities decode, so accented names match', () => {
    const source = 'Jos&eacute; Mart&iacute;nez and Hans M&uuml;ller signed in Stra&szlig;e';
    assert.equal(verifyQuote(source, 'José Martínez and Hans Müller signed in Straße').verified, true);
});

test('the Latin-1 entity table covers the whole U+00C0..U+00FF block', () => {
    for (let code = 0xc0; code <= 0xff; code++) {
        const char = String.fromCharCode(code);
        // Round-trip through the table by finding the entity that yields it.
        assert.equal(
            normalizeForMatch(`padding text ${char} padding text`).includes(normalizeForMatch(char)),
            true,
            `U+${code.toString(16)} should survive normalization`
        );
    }
});

test('PDF ligatures match their spelled-out form', () => {
    assert.equal(
        verifyQuote('the oﬃce conﬁrmed the ﬁnal ﬂight had been delayed',
                    'the office confirmed the final flight had been delayed').verified,
        true
    );
});

test('the modifier-letter apostrophe folds with the ordinary one', () => {
    assert.equal(
        verifyQuote('the Hawaiʻi delegation arrived early that morning',
                    "the Hawai'i delegation arrived early that morning").verified,
        true
    );
});

test('decomposed and composed accents compare equal', () => {
    const composed = 'Jose\u0301 Marti\u0301nez signed the agreement';
    const nfd = 'Jos\u00e9 Mart\u00ednez signed the agreement';
    assert.equal(verifyQuote(composed, nfd).verified, true);
});

test('a trailing full stop the model added does not sink the match', () => {
    const out = verifyQuote(SOURCE, 'The bridge was finally opened to traffic in August 2002.');
    assert.equal(out.verified, true);
});

test('a trailing-punctuation match displays the trimmed form, not the model text', () => {
    // The promise is that every character shown is in the source, so the
    // added full stop must not survive into verifiedText.
    const out = verifyQuote('the bridge opened to traffic in August 2002 after delays',
                            'the bridge opened to traffic in August 2002 after delays.');
    assert.equal(out.verified, true);
    assert.ok(!out.verifiedText.endsWith('.'), `verifiedText kept the added stop: ${out.verifiedText}`);
});

// --- deliberately still rejected ----------------------------------------
//
// Each of these would need space-insensitive or content-removing matching,
// which would let unrelated passages match. Rejecting a real quote is the
// cheaper error.

test('letter-spaced source text does not match its normal spelling', () => {
    assert.equal(
        verifyQuote('A N N U A L  R E P O R T of the commission for the year',
                    'ANNUAL REPORT of the commission for the year').verified,
        false
    );
});

test('a word split by an inline tag does not match — fix belongs in the extractor', () => {
    assert.equal(
        verifyQuote('Harmon Kille brew hit the longest home run',
                    'Harmon Killebrew hit the longest home run').verified,
        false
    );
});

test('a bracketed insertion mid-quote does not match', () => {
    assert.equal(
        verifyQuote('the committee published its findings in 1932 to acclaim',
                    'the committee published its findings in 1932 [sic] to acclaim').verified,
        false
    );
});
