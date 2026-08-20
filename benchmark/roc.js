import { VERDICTS, canonicalizeVerdict } from '../core/verdicts.js';

/**
 * ROC-curve computation for benchmark verdicts.
 *
 * Verdicts aren't a single probability — a row carries a categorical
 * `predicted_verdict` (SUPPORTED / PARTIALLY SUPPORTED / NOT SUPPORTED /
 * SOURCE UNAVAILABLE) plus a `confidence` (0-100) that's scoped to whichever
 * verdict the model chose (a NOT SUPPORTED row can carry confidence 95 -
 * that's confidence in "not supported", not in "supported"). An ROC curve
 * needs one directional score per row, so `supportedScore` folds verdict
 * polarity and confidence into a single 0-100 "how strongly does this read
 * as SUPPORTED" scale: SUPPORTED pushes above the 50 midpoint (higher
 * confidence -> further above), NOT SUPPORTED / SOURCE UNAVAILABLE push
 * below it, and PARTIALLY SUPPORTED sits at the midpoint (confidence there
 * doesn't carry a supported/not-supported direction to lean on).
 *
 * Positive class is ground_truth === SUPPORTED - i.e. "is this citation
 * actually fine", which is the operational question the sidebar's verdict
 * exists to answer for an editor deciding whether to flag it.
 */

export function supportedScore(predictedVerdict, confidence) {
    const v = canonicalizeVerdict(predictedVerdict);
    const c = Math.max(0, Math.min(100, confidence ?? 0));
    if (v === VERDICTS.NOT_SUPPORTED || v === VERDICTS.SOURCE_UNAVAILABLE) return 50 - c / 2;
    if (v === VERDICTS.SUPPORTED) return 50 + c / 2;
    // PARTIALLY_SUPPORTED and unrecognized verdicts sit at the midpoint —
    // confidence there doesn't carry a supported/not-supported direction.
    return 50;
}

export function isPositiveGroundTruth(groundTruth) {
    return canonicalizeVerdict(groundTruth) === VERDICTS.SUPPORTED;
}

// Excludes error rows (no verdict produced) and rows whose ground truth
// doesn't canonicalize to one of the four known verdicts. Shared by
// computeRocCurve and computeVerdictOperatingPoint so both use the same
// row set and the same positive/negative denominators.
function scoreRows(rows) {
    return rows
        .filter(r => !r.error && canonicalizeVerdict(r.ground_truth) !== null && r.predicted_verdict)
        .map(r => ({
            score: supportedScore(r.predicted_verdict, r.confidence),
            predictedPositive: canonicalizeVerdict(r.predicted_verdict) === VERDICTS.SUPPORTED,
            positive: isPositiveGroundTruth(r.ground_truth),
        }));
}

/**
 * Compute ROC points + AUC for one set of rows (already filtered to a
 * single provider). Rows with `error` set are excluded - they never
 * produced a verdict to score.
 *
 * Returns { points, auc, positives, negatives }. `auc` is null when the
 * rows are single-class (no meaningful curve to draw).
 */
export function computeRocCurve(rows) {
    const scored = scoreRows(rows);

    const positives = scored.filter(r => r.positive).length;
    const negatives = scored.length - positives;
    if (positives === 0 || negatives === 0) {
        return {
            points: [{ fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }],
            auc: null,
            positives,
            negatives,
            verdictOperatingPoint: null,
        };
    }

    // Sweep every distinct score as a threshold (predict positive when
    // score >= threshold), high to low, tracing the curve from (0,0) to (1,1).
    const thresholds = [...new Set(scored.map(r => r.score))].sort((a, b) => b - a);
    const points = [{ fpr: 0, tpr: 0 }];
    for (const threshold of thresholds) {
        let tp = 0, fp = 0;
        for (const r of scored) {
            if (r.score >= threshold) {
                if (r.positive) tp++; else fp++;
            }
        }
        points.push({ fpr: fp / negatives, tpr: tp / positives, threshold });
    }
    points.push({ fpr: 1, tpr: 1 });

    const auc = trapezoidalAuc(points);
    const verdictOperatingPoint = computeVerdictOperatingPoint(rows);
    return { points, auc, positives, negatives, verdictOperatingPoint };
}

/**
 * The single (fpr, tpr) point the provider actually operates at today: no
 * confidence threshold, just "did the raw predicted_verdict say SUPPORTED."
 * This is what the sidebar's verdict alone gets an editor, as opposed to the
 * curve's hypothetical "what if we thresholded on confidence instead."
 *
 * Returns null when the rows are single-class (fpr/tpr undefined).
 */
export function computeVerdictOperatingPoint(rows) {
    const scored = scoreRows(rows);
    const positives = scored.filter(r => r.positive).length;
    const negatives = scored.length - positives;
    if (positives === 0 || negatives === 0) return null;

    let tp = 0, fp = 0;
    for (const r of scored) {
        if (!r.predictedPositive) continue;
        if (r.positive) tp++; else fp++;
    }
    return { fpr: fp / negatives, tpr: tp / positives };
}

function trapezoidalAuc(points) {
    const sorted = [...points].sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
    let auc = 0;
    for (let i = 1; i < sorted.length; i++) {
        const dx = sorted[i].fpr - sorted[i - 1].fpr;
        const avgY = (sorted[i].tpr + sorted[i - 1].tpr) / 2;
        auc += dx * avgY;
    }
    return auc;
}

/** One curve per distinct `provider` value found in `results`. */
export function computeRocCurvesByProvider(results) {
    const providers = [...new Set(results.map(r => r.provider))];
    const out = {};
    for (const provider of providers) {
        out[provider] = computeRocCurve(results.filter(r => r.provider === provider));
    }
    return out;
}
