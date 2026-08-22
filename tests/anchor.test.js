import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeClaim,
    normalizeSourceUrl,
    claimHash,
    sourceUrlHash,
    groupSourceUrlHash,
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

test('groupSourceUrlHash is a 32-byte Buffer and deterministic', () => {
    const h = groupSourceUrlHash(['https://a.com', 'https://b.com']);
    assert.ok(Buffer.isBuffer(h));
    assert.equal(h.length, 32);
    assert.deepEqual(h, groupSourceUrlHash(['https://a.com', 'https://b.com']));
});

test('groupSourceUrlHash is independent of member order', () => {
    assert.deepEqual(
        groupSourceUrlHash(['https://a.com', 'https://b.com', 'https://c.com']),
        groupSourceUrlHash(['https://c.com', 'https://a.com', 'https://b.com'])
    );
});

test('groupSourceUrlHash differs for different member sets', () => {
    assert.notDeepEqual(
        groupSourceUrlHash(['https://a.com', 'https://b.com']),
        groupSourceUrlHash(['https://a.com', 'https://c.com'])
    );
    assert.notDeepEqual(
        groupSourceUrlHash(['https://a.com']),
        groupSourceUrlHash(['https://a.com', 'https://b.com'])
    );
});

test('groupSourceUrlHash NUL-joins so concatenation can\'t collide across a boundary', () => {
    assert.notDeepEqual(
        groupSourceUrlHash(['ab', 'c']),
        groupSourceUrlHash(['a', 'bc'])
    );
});

test('groupSourceUrlHash is domain-separated from sourceUrlHash, even for one member', () => {
    // A single-source group must not resolve to the same identity as that
    // source's own per-source row.
    assert.notDeepEqual(
        groupSourceUrlHash(['https://a.com']),
        sourceUrlHash('https://a.com')
    );
});

test('groupSourceUrlHash treats a missing/empty urls list like an empty set, not a throw', () => {
    assert.deepEqual(groupSourceUrlHash([]), groupSourceUrlHash(undefined));
    assert.deepEqual(groupSourceUrlHash(undefined), groupSourceUrlHash(null));
});
