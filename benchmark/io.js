// Shared I/O helpers for benchmark artifacts.
//
// `dataset.json` and `results.json` (and their frozen vN snapshots) are stored
// as either:
//   - Legacy:  a bare JSON array of row objects.
//   - Current: { metadata: {...}, rows: [...] }
//
// The metadata block lets each artifact carry its own date provenance so a
// run's results stay attributable to a prompt-and-dataset version. See
// benchmark/README.md "Reproducibility metadata" for the schema.
//
// loadRows + loadMetadata transparently handle both shapes; writeWithMetadata
// always emits the current shape.
//
// Result *rows* have a second, orthogonal schema variant: the model-reported
// 0-100 score is spelled `support_score` today and was spelled `confidence`
// before commit e0706fb ("Rename confidence to support_score throughout the
// LLM contract"). Read it through rowSupportScore rather than reaching for
// either field directly — see that function's comment for what reading the
// wrong one silently costs.

import fs from 'fs';

export function loadRows(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : (parsed.rows || []);
}

export function loadMetadata(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? {} : (parsed.metadata || {});
}

export function writeWithMetadata(filePath, metadata, rows) {
    fs.writeFileSync(
        filePath,
        JSON.stringify({ metadata, rows }, null, 2)
    );
}

/**
 * The 0-100 model-reported score for a result row, under either the current
 * `support_score` spelling or the pre-rename `confidence` one. Returns 0 when
 * the row carries neither.
 *
 * Reading only one spelling fails silently rather than loudly, in both
 * directions, which is why this is centralized:
 *
 *   - benchmark/roc.js read only `confidence`. Since it feeds
 *     `supportedScore(verdict, score)`, and a score of 0 collapses SUPPORTED,
 *     NOT SUPPORTED and SOURCE UNAVAILABLE alike onto the 50 midpoint, a
 *     current-schema run scored one distinct threshold and an AUC of exactly
 *     0.500 — chance, indistinguishable from a genuinely useless model.
 *   - benchmark/analyze_results.js read only `support_score`, so pre-rename
 *     rows reported an average support score of 0 and no calibration gap at
 *     all.
 *
 * Both were live at once against the same results.json, so every provider was
 * broken in exactly one of the two metrics and none in both.
 */
export function rowSupportScore(row) {
    return row?.support_score ?? row?.confidence ?? 0;
}

export function todayIso() {
    return new Date().toISOString().slice(0, 10);
}
