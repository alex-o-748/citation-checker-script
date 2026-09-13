import { VERDICTS, canonicalizeVerdict } from '../core/verdicts.js';
import { rowSupportScore } from './io.js';

/**
 * ROC-curve computation for benchmark verdicts.
 *
 * ── THE POSITIVE CLASS IS THE FAILING CITATION ──────────────────────────
 *
 * Positive = ground truth is anything but SUPPORTED (PARTIALLY SUPPORTED,
 * NOT SUPPORTED, SOURCE UNAVAILABLE). That is **the case requiring
 * treatment**: the citation an editor has to do something about. The tool
 * exists to find those, so that is what it is scored on detecting.
 *
 * This is written down here, in `docs/roc-curves.md`, and in CLAUDE.md
 * because it has been read backwards twice. Two consequences follow, and
 * both are the opposite of what "false positive" suggests to someone
 * thinking of SUPPORTED as the positive class:
 *
 *   TPR = of citations that genuinely fail, the share the tool flags.
 *         Recall on problems. Higher is better.
 *   FPR = of citations that are genuinely fine, the share the tool flags
 *         anyway. The false alarm an editor pays for. Lower is better.
 *
 * FPR here is therefore the same direction as the "falsely report that a
 * citation fails" measure in docs/benchmark-ground-truth-audit-2026-09-06.md
 * and the "False Positives (overcautious)" counts in
 * docs/llm-benchmarking-overview.md. One vocabulary across the repo.
 *
 * ── THE SCORE BEING SWEPT ───────────────────────────────────────────────
 *
 * A row isn't a single probability. It carries a categorical
 * `predicted_verdict` plus a `support_score` (0-100). `failureScore` folds
 * the two into a single 0-100 "how strongly does this read as a citation
 * that FAILS" scale: NOT SUPPORTED / SOURCE UNAVAILABLE push above the 50
 * midpoint, SUPPORTED pushes below it, and PARTIALLY SUPPORTED sits at the
 * midpoint.
 *
 * CAVEAT, measured 2026-09-13 and not yet acted on: this fold was written on
 * the premise that `support_score` is confidence in whichever verdict the
 * model picked (so a NOT SUPPORTED row might carry 95). That premise is
 * false. `core/prompts.js` asks for a directional "how well does the source
 * support the claim" score, and its few-shot examples set SUPPORTED 95,
 * PARTIALLY SUPPORTED 55-60, NOT SUPPORTED 15-20, SOURCE UNAVAILABLE 0.
 * The run bears that out — median support_score by predicted verdict is
 * 95 / 70 / 10 / 0.
 *
 * So the fold is mostly re-deriving a direction the field already had, and
 * it costs signal: every PARTIALLY SUPPORTED row is pinned to exactly 50,
 * discarding a score the model spreads over 55-90, and NOT SUPPORTED rows
 * compress into a narrow 50-60 band. Scoring `100 - support_score` directly
 * instead raises mean strict-set AUC from 0.788 to 0.809 (+0.082 for
 * claude-sonnet-5, +0.079 for liftwing-qwen3.6-27b, but -0.071 for
 * gemini-2.5-flash, whose verdict carries signal its score does not).
 *
 * Left as-is deliberately: switching the score changes every published AUC
 * and is a decision to take on its own, not a side effect of fixing the
 * positive class.
 *
 * At threshold 50 the sweep reproduces the raw verdict exactly — every
 * non-SUPPORTED prediction is at or above the midpoint — which is why
 * `computeVerdictOperatingPoint` lands on the curve rather than beside it.
 *
 * The per-row score comes from io.js's `rowSupportScore`, never from
 * `r.support_score` or `r.confidence` directly. This module used to read
 * `r.confidence` alone, which commit e0706fb had renamed; since 0 collapses
 * *every* branch below onto the 50 midpoint, that yielded one distinct
 * threshold and an AUC of exactly 0.500 for any current-schema run —
 * chance, and silent. The first liftwing-qwen3.6-27b run scored 0.500 that
 * way against a real 0.774.
 *
 * Note AUC is unchanged by this framing: flipping both the positive class
 * and the score direction leaves the ranking statistic identical. It is the
 * curve's axes and the operating point that read differently — and those
 * are what anyone actually interprets.
 */

export function failureScore(predictedVerdict, supportScore) {
    const v = canonicalizeVerdict(predictedVerdict);
    const c = Math.max(0, Math.min(100, supportScore ?? 0));
    if (v === VERDICTS.NOT_SUPPORTED || v === VERDICTS.SOURCE_UNAVAILABLE) return 50 + c / 2;
    if (v === VERDICTS.SUPPORTED) return 50 - c / 2;
    // PARTIALLY_SUPPORTED and unrecognized verdicts sit at the midpoint —
    // confidence there doesn't carry a fails/holds direction.
    return 50;
}

/**
 * True when the ground truth is a citation an editor has to treat — i.e.
 * anything but SUPPORTED. This is the positive class; see the header.
 */
export function needsTreatment(groundTruth) {
    const v = canonicalizeVerdict(groundTruth);
    return v !== null && v !== VERDICTS.SUPPORTED;
}

// Excludes error rows (no verdict produced) and rows whose ground truth
// doesn't canonicalize to one of the four known verdicts. Shared by
// computeRocCurve and computeVerdictOperatingPoint so both use the same
// row set and the same positive/negative denominators.
function scoreRows(rows) {
    return rows
        .filter(r => !r.error && canonicalizeVerdict(r.ground_truth) !== null && r.predicted_verdict)
        .map(r => ({
            score: failureScore(r.predicted_verdict, rowSupportScore(r)),
            // The model predicts "needs treatment" whenever it declines to say
            // SUPPORTED — the same rule the ground-truth side uses.
            predictedPositive: canonicalizeVerdict(r.predicted_verdict) !== VERDICTS.SUPPORTED,
            positive: needsTreatment(r.ground_truth),
        }));
}

/**
 * Compute ROC points + AUC for one set of rows (already filtered to a
 * single provider). Rows with `error` set are excluded - they never
 * produced a verdict to score.
 *
 * Returns { points, auc, positives, negatives }. `positives` counts
 * citations that genuinely fail; `negatives` counts citations that are
 * genuinely fine. `auc` is null when the rows are single-class (no
 * meaningful curve to draw).
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

    // Sweep every distinct score as a threshold (flag as failing when
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
 * confidence threshold, just "did the raw predicted_verdict decline to say
 * SUPPORTED." This is what the sidebar's verdict alone gets an editor, as
 * opposed to the curve's hypothetical "what if we thresholded on confidence
 * instead."
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
