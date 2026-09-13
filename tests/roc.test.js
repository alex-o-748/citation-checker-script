import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    failureScore,
    needsTreatment,
    computeRocCurve,
    computeRocCurvesByProvider,
    computeVerdictOperatingPoint,
} from '../benchmark/roc.js';
import { selectScoredRows } from '../benchmark/roc_curve.js';
import { rowSupportScore } from '../benchmark/io.js';

// --- THE POSITIVE CLASS ------------------------------------------------------
// Positive = the citation needs treatment: ground truth is anything but
// SUPPORTED. TPR is recall on failing citations; FPR is good citations flagged
// anyway. This has been read backwards twice, so these four tests exist to fail
// loudly rather than quietly re-inverting the meaning of every published curve.

test('the positive class is the failing citation — anything but SUPPORTED', () => {
    assert.equal(needsTreatment('Partially supported'), true);
    assert.equal(needsTreatment('Not supported'), true);
    assert.equal(needsTreatment('Source unavailable'), true);
    assert.equal(needsTreatment('Supported'), false, 'SUPPORTED is the negative class');
    assert.equal(needsTreatment('SUPPORTED'), false);
    assert.equal(needsTreatment(null), false);
});

test('a tool that flags every failing citation and passes every good one sits at the ideal corner', () => {
    const rows = [
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', support_score: 90 },
        { ground_truth: 'Partially supported', predicted_verdict: 'Partially supported', support_score: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 90 },
    ];
    // TPR 1: both failing citations caught. FPR 0: the good one was not flagged.
    assert.deepEqual(computeVerdictOperatingPoint(rows), { fpr: 0, tpr: 1 });
});

test('FPR counts good citations the tool flagged anyway', () => {
    const rows = [
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', support_score: 90 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', support_score: 90 },
    ];
    const { fpr } = computeVerdictOperatingPoint(rows);
    assert.equal(fpr, 1 / 3, 'one of three genuinely supported citations was flagged');
});

test('failureScore pushes NOT SUPPORTED/SOURCE UNAVAILABLE above 50 and SUPPORTED below it', () => {
    assert.equal(failureScore('Not supported', 100), 100);
    assert.equal(failureScore('Not supported', 0), 50);
    assert.equal(failureScore('Source unavailable', 80), 90);
    assert.equal(failureScore('Supported', 100), 0);
    assert.equal(failureScore('Supported', 0), 50);
});

test('failureScore sits PARTIALLY SUPPORTED and unrecognized verdicts at the midpoint regardless of confidence', () => {
    assert.equal(failureScore('Partially supported', 95), 50);
    assert.equal(failureScore('Partially supported', 0), 50);
    assert.equal(failureScore('gibberish', 90), 50);
    assert.equal(failureScore(null, 90), 50);
});

test('failureScore clamps out-of-range confidence', () => {
    assert.equal(failureScore('Not supported', 150), 100);
    assert.equal(failureScore('Not supported', -10), 50);
});

// The property that keeps the diamond on its own curve: at cutoff 50 the swept
// score flags exactly what the bare verdict flags, because every non-SUPPORTED
// prediction sits at or above the midpoint.
test('sweeping to threshold 50 reproduces the raw-verdict operating point', () => {
    const rows = [
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', support_score: 90 },
        { ground_truth: 'Partially supported', predicted_verdict: 'Partially supported', support_score: 80 },
        { ground_truth: 'Supported', predicted_verdict: 'Supported', support_score: 90 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', support_score: 70 },
    ];
    const { points, verdictOperatingPoint } = computeRocCurve(rows);
    const at50 = points.find(pt => pt.threshold === 50);
    assert.ok(at50, 'expected a swept threshold at the midpoint');
    assert.equal(at50.tpr, verdictOperatingPoint.tpr);
    assert.equal(at50.fpr, verdictOperatingPoint.fpr);
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
    // Both rows are genuinely SUPPORTED, so there is nothing to detect.
    assert.equal(positives, 0);
    assert.equal(negatives, 2);
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
        // Low-confidence SUPPORTED still counts as a predicted negative here —
        // the bare verdict is read as-is, whatever confidence rides along.
        { ground_truth: 'Supported', predicted_verdict: 'Supported', confidence: 5 },
        { ground_truth: 'Not supported', predicted_verdict: 'Supported', confidence: 5 },
        { ground_truth: 'Supported', predicted_verdict: 'Not supported', confidence: 99 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 99 },
    ];
    const point = computeVerdictOperatingPoint(rows);
    // 1 failing citation caught of 2; 1 good citation flagged of 2.
    assert.deepEqual(point, { fpr: 0.5, tpr: 0.5 });
});

test('computeVerdictOperatingPoint treats PARTIALLY SUPPORTED as a predicted positive', () => {
    const rows = [
        // Partially supported is a citation the editor still has to look at, so
        // predicting it counts as flagging — here, wrongly, on a good citation.
        { ground_truth: 'Supported', predicted_verdict: 'Partially supported', confidence: 60 },
        { ground_truth: 'Not supported', predicted_verdict: 'Not supported', confidence: 60 },
    ];
    const point = computeVerdictOperatingPoint(rows);
    assert.deepEqual(point, { fpr: 1, tpr: 1 });
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
    // Both failing citations caught; one of the two good ones flagged anyway.
    assert.deepEqual(verdictOperatingPoint, { fpr: 0.5, tpr: 1 });
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
    const scores = new Set(rows.map(r => failureScore(r.predicted_verdict, rowSupportScore(r))));
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
