import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    supportedScore,
    isPositiveGroundTruth,
    computeRocCurve,
    computeRocCurvesByProvider,
    computeVerdictOperatingPoint,
} from '../benchmark/roc.js';
import { selectScoredRows } from '../benchmark/roc_curve.js';
import { rowSupportScore } from '../benchmark/io.js';

test('supportedScore pushes SUPPORTED above 50 and NOT SUPPORTED/SOURCE UNAVAILABLE below it', () => {
    assert.equal(supportedScore('Supported', 100), 100);
    assert.equal(supportedScore('Supported', 0), 50);
    assert.equal(supportedScore('Not supported', 100), 0);
    assert.equal(supportedScore('Not supported', 0), 50);
    assert.equal(supportedScore('Source unavailable', 80), 10);
});

test('supportedScore sits PARTIALLY SUPPORTED and unrecognized verdicts at the midpoint regardless of confidence', () => {
    assert.equal(supportedScore('Partially supported', 95), 50);
    assert.equal(supportedScore('Partially supported', 0), 50);
    assert.equal(supportedScore('gibberish', 90), 50);
    assert.equal(supportedScore(null, 90), 50);
});

test('supportedScore clamps out-of-range confidence', () => {
    assert.equal(supportedScore('Supported', 150), 100);
    assert.equal(supportedScore('Supported', -10), 50);
});

test('isPositiveGroundTruth is true only for SUPPORTED, case/format insensitive', () => {
    assert.equal(isPositiveGroundTruth('Supported'), true);
    assert.equal(isPositiveGroundTruth('SUPPORTED'), true);
    assert.equal(isPositiveGroundTruth('Partially supported'), false);
    assert.equal(isPositiveGroundTruth('Not supported'), false);
    assert.equal(isPositiveGroundTruth('Source unavailable'), false);
    assert.equal(isPositiveGroundTruth(null), false);
});

test('computeRocCurve traces (0,0) to (1,1) and scores perfect separation as AUC 1', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 80 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 90 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 80 },
    ];
    const { points, auc, positives, negatives } = computeRocCurve(rows);
    assert.equal(positives, 2);
    assert.equal(negatives, 2);
    assert.equal(auc, 1);
    assert.deepEqual(points[0], { fpr: 0, tpr: 0 });
    assert.deepEqual(points[points.length - 1], { fpr: 1, tpr: 1 });
});

test('computeRocCurve scores a coin-flip predictor around AUC 0.5', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', confidence: 60 },
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 60 },
        { ground_truth: 'Not supported', predicted_verdict: 'Supported', confidence: 60 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 60 },
    ];
    const { auc } = computeRocCurve(rows);
    assert.equal(auc, 0.5);
});

test('computeRocCurve returns null AUC for single-class rows (nothing to trade off)', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', confidence: 40 },
    ];
    const { auc, positives, negatives } = computeRocCurve(rows);
    assert.equal(auc, null);
    assert.equal(positives, 2);
    assert.equal(negatives, 0);
});

test('computeRocCurve excludes error rows and rows with unrecognized ground truth', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 90 },
        { ground_truth: 'Not supported', predicted_verdict: 'Supported', confidence: 90, error: 'timeout' },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 90 },
        { ground_truth: 'garbled label', predicted_verdict: 'Supported', confidence: 90 },
    ];
    const { positives, negatives } = computeRocCurve(rows);
    assert.equal(positives, 1);
    assert.equal(negatives, 1);
});

test('computeVerdictOperatingPoint ignores confidence and scores the raw predicted_verdict', () => {
    const rows = [
        // Low-confidence SUPPORTED still counts as a predicted positive here,
        // unlike the threshold-swept curve where it might not clear a high cutoff.
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 5 },
        { ground_truth: 'Not supported', predicted_verdict: 'Supported', confidence: 5 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', confidence: 99 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 99 },
    ];
    const point = computeVerdictOperatingPoint(rows);
    // 1 true positive / 2 actual positives; 1 false positive / 2 actual negatives.
    assert.deepEqual(point, { fpr: 0.5, tpr: 0.5 });
});

test('computeVerdictOperatingPoint treats PARTIALLY SUPPORTED as a predicted negative', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Partially supported', confidence: 60 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 60 },
    ];
    const point = computeVerdictOperatingPoint(rows);
    assert.deepEqual(point, { fpr: 0, tpr: 0 });
});

test('computeVerdictOperatingPoint returns null for single-class rows', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 90 },
    ];
    assert.equal(computeVerdictOperatingPoint(rows), null);
});

test('computeRocCurve includes the matching verdictOperatingPoint', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', confidence: 40 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 90 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 80 },
    ];
    const { verdictOperatingPoint } = computeRocCurve(rows);
    assert.deepEqual(verdictOperatingPoint, { fpr: 0, tpr: 0.5 });
});

// --- support_score / confidence field tolerance ---
// Every test above builds rows spelled `confidence`, which is why the field
// rename in e0706fb slipped through: roc.js read `r.confidence`, the suite
// only ever handed it `r.confidence`, and the mismatch only showed up against
// real results.json rows. These tests use the current `support_score`
// spelling, so the suite now exercises the shape run_benchmark.js writes.

test('scores rows written with the current support_score field', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 90 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', support_score: 90 },
    ];
    assert.equal(computeRocCurve(rows).auc, 1);
});

// The regression itself: reading only `confidence` made support_score rows
// fall back to 0, which collapses SUPPORTED, NOT SUPPORTED and SOURCE
// UNAVAILABLE alike onto the 50 midpoint — one distinct threshold, AUC
// exactly 0.5, indistinguishable from a useless model. Fails against the
// pre-fix roc.js.
test('support_score rows do not collapse to a single midpoint threshold', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 95 },
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 70 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', support_score: 80 },
        { ground_truth: 'Not supported', predicted_verdict: 'Source unavailable', support_score: 60 },
    ];
    const scores = new Set(rows.map(r => supportedScore(r.predicted_verdict, rowSupportScore(r))));
    assert.ok(scores.size > 1, 'every row collapsed onto one score');
    assert.notEqual(computeRocCurve(rows).auc, 0.5);
});

test('support_score and confidence spellings score identically', () => {
    const asNew = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 90 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', support_score: 70 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', support_score: 55 },
    ];
    const asOld = asNew.map(({ support_score, ...rest }) => ({ ...rest, confidence: support_score }));
    assert.equal(computeRocCurve(asNew).auc, computeRocCurve(asOld).auc);
});

test('rowSupportScore prefers support_score, falls back to confidence, else 0', () => {
    assert.equal(rowSupportScore({ support_score: 80 }), 80);
    assert.equal(rowSupportScore({ confidence: 60 }), 60);
    assert.equal(rowSupportScore({ support_score: 80, confidence: 60 }), 80);
    assert.equal(rowSupportScore({}), 0);
    assert.equal(rowSupportScore(undefined), 0);
});

test('rowSupportScore preserves an explicit zero rather than treating it as missing', () => {
    assert.equal(rowSupportScore({ support_score: 0, confidence: 90 }), 0);
});

test('computeRocCurvesByProvider splits rows by provider', () => {
    const results = [
        { provider: 'a', ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 90 },
        { provider: 'a', ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 90 },
        { provider: 'b', ground_truth: 'Supported', predicted_verdict: 'Not supported', confidence: 90 },
        { provider: 'b', ground_truth: 'Not supported', predicted_verdict: 'Supported', confidence: 90 },
    ];
    const curves = computeRocCurvesByProvider(results);
    assert.deepEqual(Object.keys(curves).sort(), ['a', 'b']);
    assert.equal(curves.a.auc, 1);
    assert.equal(curves.b.auc, 0);
});

// --- Row-set selection (the strict set) -------------------------------------
//
// The curve has to be drawn over the same rows the accuracy table is scored
// on, or the two answer different questions while looking like they answer the
// same one. These pin the ROC CLI's filtering to analyze_results.js's rules.

const FILTER_DATASET = [
    { id: 'row_1', source_truncated: false },
    { id: 'row_2', source_truncated: true },
    { id: 'row_3', source_truncated: false, excluded_reason: 'claim and cited URL are unrelated' },
    { id: 'row_4', source_truncated: true },
];
const FILTER_RESULTS = FILTER_DATASET.map(e => ({ entry_id: e.id, provider: 'a' }));

test('selectScoredRows drops unscoreable rows by default and keeps them on request', () => {
    const dropped = selectScoredRows(FILTER_RESULTS, FILTER_DATASET);
    assert.deepEqual(dropped.rows.map(r => r.entry_id), ['row_1', 'row_2', 'row_4']);
    assert.equal(dropped.excludedRows, 1);

    const kept = selectScoredRows(FILTER_RESULTS, FILTER_DATASET, { includeExcluded: true });
    assert.equal(kept.rows.length, 4);
    assert.equal(kept.excludedRows, 0);
});

test('selectScoredRows --truncation full is the strict set: whole sources, unscoreable rows already gone', () => {
    const strict = selectScoredRows(FILTER_RESULTS, FILTER_DATASET, { truncation: 'full' });
    assert.deepEqual(strict.rows.map(r => r.entry_id), ['row_1']);
    assert.equal(strict.excludedRows, 1);
    assert.equal(strict.droppedByTruncation, 2);

    const capped = selectScoredRows(FILTER_RESULTS, FILTER_DATASET, { truncation: 'truncated' });
    assert.deepEqual(capped.rows.map(r => r.entry_id), ['row_2', 'row_4']);
});

// Absent is not false: a dataset predating the flag would otherwise report
// every row as whole and produce a confidently wrong "strict" curve.
test('selectScoredRows refuses --truncation against a dataset with no source_truncated flag', () => {
    const legacy = [{ id: 'row_1' }, { id: 'row_2' }];
    const rows = legacy.map(e => ({ entry_id: e.id, provider: 'a' }));
    assert.throws(() => selectScoredRows(rows, legacy, { truncation: 'full' }), /source_truncated/);
    // Without the flag it is still usable for the unfiltered curve.
    assert.equal(selectScoredRows(rows, legacy).rows.length, 2);
});

test('selectScoredRows rejects an unknown truncation value rather than silently scoring everything', () => {
    assert.throws(
        () => selectScoredRows(FILTER_RESULTS, FILTER_DATASET, { truncation: 'whole' }),
        /all, full, truncated/
    );
});
