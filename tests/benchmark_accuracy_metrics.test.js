import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../benchmark/analyze_results.js';

// Minimal result rows: calculateMetrics only reads the fields used here plus
// whatever quote_metrics.test.js exercises separately.
function row(predicted_verdict, ground_truth, overrides = {}) {
    return {
        predicted_verdict,
        ground_truth,
        support_score: 90,
        latency_ms: 100,
        error: null,
        ...overrides,
    };
}

// One row of each verdict pair, chosen so exact/lenient/binary/supportedVsRest
// disagree with each other on at least one row — a metric that quietly copied
// another's logic would fail one of these counts.
const ROWS = [
    row('Supported', 'Supported'),                          // agrees on all four
    row('Supported', 'Partially supported'),                 // lenient-only near-miss
    row('Not supported', 'Partially supported'),              // supportedVsRest-only near-miss
    row('Not supported', 'Not supported'),                    // agrees on all four
    row('Source unavailable', 'Source unavailable'),          // agrees on all four
];

test('exactAccuracy is unforgiving four-way match', () => {
    const m = calculateMetrics(ROWS);
    // Only rows 1, 4, 5 match exactly.
    assert.equal(m.exactMatches, 3);
    assert.equal(m.exactAccuracy, 3 / 5);
});

test('lenientAccuracy forgives Supported <-> Partially supported only', () => {
    const m = calculateMetrics(ROWS);
    // Exact matches (3) plus the Supported/Partially row (1) = 4.
    // The Not-supported/Partially-supported row is NOT forgiven here.
    assert.equal(m.partialMatches, 1);
    assert.equal(m.lenientAccuracy, 4 / 5);
});

test('binaryAccuracy pools {Supported, Partially} vs {Not supported, Unavailable}', () => {
    const m = calculateMetrics(ROWS);
    // Row 2 (Supported/Partially): both positive -> binary-correct.
    // Row 3 (Not/Partially): positive vs negative -> binary-wrong.
    // Rows 1, 4, 5: same class -> binary-correct.
    assert.equal(m.binaryAccuracy, 4 / 5);
});

test('supportedVsRestAccuracy forgives Partially supported <-> Not supported only', () => {
    const m = calculateMetrics(ROWS);
    // Exact matches (3) plus the Not/Partially row (1) = 4.
    // The Supported/Partially row is NOT forgiven here — opposite of lenientAccuracy.
    assert.equal(m.supportedVsRestCorrect, 4);
    assert.equal(m.supportedVsRestAccuracy, 4 / 5);
});

test('lenientAccuracy and supportedVsRestAccuracy diverge on the two near-miss rows', () => {
    // This is the discrepancy that motivated adding the second metric:
    // docs/llm-benchmarking-overview.md describes supportedVsRest's grouping
    // under the name "Lenient Accuracy", but the code's lenientAccuracy field
    // has always implemented the other one. The two metrics must disagree on
    // exactly the two near-miss rows above, or the distinction is pointless.
    const onlyNearMisses = [
        row('Supported', 'Partially supported'),
        row('Not supported', 'Partially supported'),
    ];
    const m = calculateMetrics(onlyNearMisses);
    // Same overall score either way — but arrived at via different rows,
    // pinned by partialMatches/supportedVsRestCorrect each singling out the
    // opposite row of the pair.
    assert.equal(m.lenientAccuracy, 0.5);
    assert.equal(m.supportedVsRestAccuracy, 0.5);
    assert.equal(m.partialMatches, 1);          // forgives row 1 (Supported/Partially) only
    assert.equal(m.supportedVsRestCorrect, 1);  // forgives row 2 (Not/Partially) only
});

test('supportedVsRestAccuracy requires Source unavailable to match exactly', () => {
    const m = calculateMetrics([
        row('Source unavailable', 'Not supported'),
        row('Not supported', 'Source unavailable'),
    ]);
    assert.equal(m.supportedVsRestCorrect, 0);
    assert.equal(m.supportedVsRestAccuracy, 0);
});
