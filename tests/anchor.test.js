import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeClaim,
    normalizeSourceUrl,
    claimHash,
    sourceUrlHash,
    groupSourceUrl,
} from '../core/anchor.js';

test('normalizeClaim trims and collapses internal whitespace', () => {
    assert.equal(normalizeClaim('  The bridge   opened  in 1998.  '), 'The bridge opened in 1998.');
    assert.equal(normalizeClaim('a\nb\tc'), 'a b c');
});

test('normalizeClaim handles empty and nullish input', () => {
    assert.equal(normalizeClaim(''), '');
    assert.equal(normalizeClaim(null), '');
    assert.equal(normalizeClaim(undefined), '');
});

test('normalizeClaim NFC-normalizes so visually identical text hashes the same', () => {
    // "é" as a single precomposed codepoint (U+00E9) vs "e" + combining acute
    // (U+0065 U+0301) — indistinguishable to a reader, different bytes.
    const precomposed = 'café';
    const decomposed = 'café';
    assert.notEqual(precomposed, decomposed, 'sanity: the raw strings really do differ');
    assert.equal(normalizeClaim(precomposed), normalizeClaim(decomposed));
});

test('claimHash is a 32-byte Buffer, matching BINARY(32)', () => {
    const h = claimHash('The bridge opened in 1998.');
    assert.ok(Buffer.isBuffer(h));
    assert.equal(h.length, 32);
});

test('claimHash is stable across whitespace variation that normalizeClaim absorbs', () => {
    assert.deepEqual(
        claimHash('The bridge   opened in 1998.'),
        claimHash('The bridge opened in 1998.')
    );
});

test('claimHash changes when the claim text actually changes', () => {
    // The whole point: an edited claim must invalidate its old finding.
    assert.notDeepEqual(
        claimHash('The bridge opened in 1998.'),
        claimHash('The bridge opened in 1999.')
    );
});

test('claimHash is deterministic across separate calls', () => {
    const text = 'The treaty was signed in Paris in 1990.';
    assert.deepEqual(claimHash(text), claimHash(text));
});

test('normalizeSourceUrl only trims — no scheme, slash, or query normalization', () => {
    assert.equal(normalizeSourceUrl('  https://example.com/a  '), 'https://example.com/a');
    // Deliberately NOT collapsed to the same value — see the brittleness note
    // in core/anchor.js. A trailing slash or query string can point at a
    // genuinely different resource; conflating them is the wrong trade.
    assert.notEqual(
        normalizeSourceUrl('https://example.com/a'),
        normalizeSourceUrl('https://example.com/a/')
    );
    assert.notEqual(
        normalizeSourceUrl('http://example.com/a'),
        normalizeSourceUrl('https://example.com/a')
    );
});

test('sourceUrlHash is a 32-byte Buffer and deterministic', () => {
    const h = sourceUrlHash('https://example.com/a');
    assert.ok(Buffer.isBuffer(h));
    assert.equal(h.length, 32);
    assert.deepEqual(h, sourceUrlHash('https://example.com/a'));
});

test('sourceUrlHash differs for different URLs', () => {
    assert.notDeepEqual(
        sourceUrlHash('https://example.com/a'),
        sourceUrlHash('https://example.com/b')
    );
});

test('claimHash and sourceUrlHash apply genuinely different normalization', () => {
    // A plain URL with no whitespace normalizes identically under both
    // functions, so claimHash(url) legitimately equals sourceUrlHash(url) —
    // that's not a collision risk (the two live in separate DB columns,
    // never compared to each other), just not a useful thing to assert.
    // The real guard against a copy-paste bug (one function silently
    // delegating to the other) is input where the two normalizations
    // diverge: claimHash collapses internal whitespace, sourceUrlHash does
    // not.
    const text = 'multiple   internal   spaces';
    assert.notDeepEqual(claimHash(text), sourceUrlHash(text));
    assert.deepEqual(claimHash(text), claimHash('multiple internal spaces'));
    assert.notDeepEqual(sourceUrlHash(text), sourceUrlHash('multiple internal spaces'));
});

test('empty and missing URLs hash consistently rather than throwing', () => {
    assert.deepEqual(sourceUrlHash(''), sourceUrlHash(null));
    assert.deepEqual(sourceUrlHash(null), sourceUrlHash(undefined));
});

test('groupSourceUrl sorts and newline-joins distinct member URLs', () => {
    assert.equal(
        groupSourceUrl(['https://b.example', 'https://a.example']),
        'https://a.example\nhttps://b.example'
    );
});

test('groupSourceUrl dedupes repeated URLs (a named ref cited twice in the group)', () => {
    assert.equal(
        groupSourceUrl(['https://a.example', 'https://a.example', 'https://b.example']),
        'https://a.example\nhttps://b.example'
    );
});

test('groupSourceUrl drops null/empty entries (a no-URL member of the group)', () => {
    assert.equal(
        groupSourceUrl(['https://a.example', null, '', 'https://b.example']),
        'https://a.example\nhttps://b.example'
    );
});

test('groupSourceUrl returns null when no member has a URL', () => {
    // Not the case this function exists to fix (service/finding-builder.js's
    // assembleGroupFinding() is only ever called for a group that passed
    // shouldSkipCollective(), which requires >=2 members with fetched
    // content — and claim-extractor.js's resolveSource() never produces
    // content without a URL, so a real all-no-URL group never reaches here).
    // Documented anyway as the honest answer for a direct call: null, not ''
    // — a caller that skips the collision this module exists to prevent by
    // hashing this result unconditionally would be making its own mistake,
    // not inheriting one from here.
    assert.equal(groupSourceUrl([]), null);
    assert.equal(groupSourceUrl([null, undefined, '']), null);
});

test('groupSourceUrl is deterministic regardless of input order', () => {
    assert.equal(
        groupSourceUrl(['https://z.example', 'https://a.example', 'https://m.example']),
        groupSourceUrl(['https://a.example', 'https://m.example', 'https://z.example'])
    );
});
