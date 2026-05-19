import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    VERDICTS,
    VERDICT_LIST,
    canonicalizeVerdict,
    toTitleCase,
    toShortCode,
} from '../core/verdicts.js';

test('VERDICTS exposes the four canonical UPPERCASE strings', () => {
    assert.equal(VERDICTS.SUPPORTED,           'SUPPORTED');
    assert.equal(VERDICTS.PARTIALLY_SUPPORTED, 'PARTIALLY SUPPORTED');
    assert.equal(VERDICTS.NOT_SUPPORTED,       'NOT SUPPORTED');
    assert.equal(VERDICTS.SOURCE_UNAVAILABLE,  'SOURCE UNAVAILABLE');
});

test('VERDICT_LIST iterates in confidence-guide order', () => {
    assert.deepEqual(VERDICT_LIST, [
        'SUPPORTED',
        'PARTIALLY SUPPORTED',
        'NOT SUPPORTED',
        'SOURCE UNAVAILABLE',
    ]);
});

test('canonicalizeVerdict accepts the canonical UPPERCASE form', () => {
    assert.equal(canonicalizeVerdict('SUPPORTED'),           VERDICTS.SUPPORTED);
    assert.equal(canonicalizeVerdict('PARTIALLY SUPPORTED'), VERDICTS.PARTIALLY_SUPPORTED);
    assert.equal(canonicalizeVerdict('NOT SUPPORTED'),       VERDICTS.NOT_SUPPORTED);
    assert.equal(canonicalizeVerdict('SOURCE UNAVAILABLE'),  VERDICTS.SOURCE_UNAVAILABLE);
});

test('canonicalizeVerdict accepts title case', () => {
    assert.equal(canonicalizeVerdict('Supported'),           VERDICTS.SUPPORTED);
    assert.equal(canonicalizeVerdict('Partially supported'), VERDICTS.PARTIALLY_SUPPORTED);
    assert.equal(canonicalizeVerdict('Not supported'),       VERDICTS.NOT_SUPPORTED);
    assert.equal(canonicalizeVerdict('Source unavailable'),  VERDICTS.SOURCE_UNAVAILABLE);
});

test('canonicalizeVerdict accepts underscores and mixed whitespace', () => {
    assert.equal(canonicalizeVerdict('not_supported'),  VERDICTS.NOT_SUPPORTED);
    assert.equal(canonicalizeVerdict('NOT_SUPPORTED'),  VERDICTS.NOT_SUPPORTED);
    assert.equal(canonicalizeVerdict('  partially  '), VERDICTS.PARTIALLY_SUPPORTED);
    assert.equal(canonicalizeVerdict('not\tsupported'), VERDICTS.NOT_SUPPORTED);
});

test('canonicalizeVerdict accepts short codes (compare_results conventions)', () => {
    assert.equal(canonicalizeVerdict('support'),     VERDICTS.SUPPORTED);
    assert.equal(canonicalizeVerdict('partial'),     VERDICTS.PARTIALLY_SUPPORTED);
    assert.equal(canonicalizeVerdict('not'),         VERDICTS.NOT_SUPPORTED);
    assert.equal(canonicalizeVerdict('unavailable'), VERDICTS.SOURCE_UNAVAILABLE);
});

test('canonicalizeVerdict returns null for unrecognized / empty / null input', () => {
    assert.equal(canonicalizeVerdict(null),          null);
    assert.equal(canonicalizeVerdict(undefined),     null);
    assert.equal(canonicalizeVerdict(''),            null);
    assert.equal(canonicalizeVerdict('   '),         null);
    assert.equal(canonicalizeVerdict('PARSE_ERROR'), null);
    assert.equal(canonicalizeVerdict('ERROR'),       null);
    assert.equal(canonicalizeVerdict('options'),     null);   // regression: 1a12753
    assert.equal(canonicalizeVerdict('to choose'),   null);
});

test('canonicalizeVerdict tolerates non-string input via String() coercion', () => {
    assert.equal(canonicalizeVerdict(42), null);
    // Number coerces cleanly; verifies we don't throw on .toUpperCase()
});

test('toTitleCase maps canonical to results.json schema strings', () => {
    assert.equal(toTitleCase(VERDICTS.SUPPORTED),           'Supported');
    assert.equal(toTitleCase(VERDICTS.PARTIALLY_SUPPORTED), 'Partially supported');
    assert.equal(toTitleCase(VERDICTS.NOT_SUPPORTED),       'Not supported');
    assert.equal(toTitleCase(VERDICTS.SOURCE_UNAVAILABLE),  'Source unavailable');
});

test('toTitleCase passes unknown input through (callers may pass sentinels)', () => {
    assert.equal(toTitleCase('PARSE_ERROR'), 'PARSE_ERROR');
    assert.equal(toTitleCase('Anything'),    'Anything');
});

test('toShortCode maps canonical to compare_results short codes', () => {
    assert.equal(toShortCode(VERDICTS.SUPPORTED),           'support');
    assert.equal(toShortCode(VERDICTS.PARTIALLY_SUPPORTED), 'partial');
    assert.equal(toShortCode(VERDICTS.NOT_SUPPORTED),       'not');
    assert.equal(toShortCode(VERDICTS.SOURCE_UNAVAILABLE),  'unavailable');
});
