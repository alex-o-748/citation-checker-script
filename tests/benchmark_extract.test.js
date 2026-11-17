import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractClaimsForCitation, parseCSVLine } from '../benchmark/extract_dataset.js';

function mkDoc(html) {
    return new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

test('extractClaimsForCitation: returns one entry per occurrence of [N]', () => {
    const doc = mkDoc(`
        <p>First sentence.<sup class="reference"><a href="#x">[5]</a></sup>
        Second sentence.<sup class="reference"><a href="#y">[5]</a></sup></p>
    `);
    const claims = extractClaimsForCitation(doc, 5);
    assert.equal(claims.length, 2);
    assert.equal(claims[0].occurrence, 1);
    assert.equal(claims[1].occurrence, 2);
});

test('extractClaimsForCitation: returns empty array when citation number is absent', () => {
    const doc = mkDoc(`
        <p>Only one cite.<sup class="reference"><a href="#x">[1]</a></sup></p>
    `);
    const claims = extractClaimsForCitation(doc, 99);
    assert.deepEqual(claims, []);
});

test('extractClaimsForCitation: strips Wikipedia maintenance markers from claim text', () => {
    // This is the test that proves PR #117's behavior is now applied to the
    // benchmark via the core/claim.js dedup. Without this, marker stripping
    // would only be exercised by chance on a real-world dataset extraction.
    const doc = mkDoc(`
        <p>Water freezes at 0 degrees Celsius [failed verification] at sea level.<sup class="reference"><a href="#x">[1]</a></sup></p>
    `);
    const claims = extractClaimsForCitation(doc, 1);
    assert.equal(claims.length, 1);
    assert.doesNotMatch(claims[0].text, /failed verification/i,
        'expected MAINTENANCE_MARKER_RE to strip [failed verification] from claim text');
    assert.match(claims[0].text, /Water freezes at 0/);
});

test('extractClaimsForCitation: does NOT match [10] when asked for [1]', () => {
    const doc = mkDoc(`
        <p>Ten.<sup class="reference"><a href="#x">[10]</a></sup></p>
    `);
    const claims = extractClaimsForCitation(doc, 1);
    assert.deepEqual(claims, []);
});

test('parseCSVLine: a doubled quote inside a quoted field is a literal quote', () => {
    // The claim text column carries quotations from the source; they must
    // survive parsing, not toggle the quote state and vanish.
    const line = '61,1,https://x,Supported,v4,"Brown said it has ""sharp-witted dialogue"", in short.",https://y,,';
    const cols = parseCSVLine(line);
    assert.equal(cols.length, 9);
    assert.equal(cols[5], 'Brown said it has "sharp-witted dialogue", in short.');
    assert.equal(cols[6], 'https://y');
});

test('parseCSVLine: unquoted fields and empty trailing fields', () => {
    assert.deepEqual(parseCSVLine('a,b,,'), ['a', 'b', '', '']);
    assert.deepEqual(parseCSVLine('"a,b",c'), ['a,b', 'c']);
    assert.deepEqual(parseCSVLine('""""'), ['"']);
});
