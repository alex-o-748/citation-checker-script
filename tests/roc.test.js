import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    supportedScore,
    isPositiveGroundTruth,
    computeRocCurve,
    computeRocCurvesByProvider,
} from '../benchmark/roc.js';

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
