#!/usr/bin/env node
/**
 * ROC Curve Script
 *
 * Computes ROC curve points + AUC per provider from a results file, using
 * the SUPPORTED-vs-rest framing in roc.js.
 *
 * Usage: node roc_curve.js [--results <path>] [--dataset <path>] [--output <path>]
 *                         [--truncation all|full|truncated] [--include-excluded]
 *
 * The row-set flags mean exactly what they mean in analyze_results.js, and
 * for the same reason: a row whose stored source_text stops at a fetch cap was
 * labelled by a human who read the whole page, so a wrong verdict there may be
 * the tool failing to see the evidence rather than the model failing to judge
 * it. `--truncation full` is the strict set — the rows where the model and the
 * labeller saw the same document. See docs/benchmark-revision-2026-09-07.md.
 *
 * Output:
 *   - Console summary (AUC per provider)
 *   - roc.json: { metadata, curves: { <provider>: { points, auc, positives,
 *     negatives, verdictOperatingPoint } } } (path overridable via --output)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadRows, todayIso } from './io.js';
import { computeRocCurvesByProvider } from './roc.js';
import { excludedRowIds, partitionByTruncation } from './analyze_results.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
function flagValue(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}

const RESULTS_PATH = path.resolve(__dirname, flagValue('--results') || 'results.json');
const DATASET_PATH = path.resolve(__dirname, flagValue('--dataset') || 'dataset.json');
const OUTPUT_PATH = path.resolve(__dirname, flagValue('--output') || 'roc.json');
const TRUNCATION_FILTER = flagValue('--truncation') || 'all';
const INCLUDE_EXCLUDED = args.includes('--include-excluded');

/**
 * Narrow a result set to the rows a curve should be drawn over.
 *
 * Pure, and separated from the CLI so the filtering is testable without
 * touching the filesystem. Both halves reuse analyze_results.js's helpers
 * rather than re-deriving the rules, so the ROC row set and the accuracy row
 * set cannot drift apart — a curve drawn over a different set of rows than the
 * accuracy table beside it is the kind of mismatch nobody notices until the
 * two disagree.
 *
 * Throws when `truncation` is asked for against a dataset carrying no
 * `source_truncated` flag anywhere (the frozen v1/v3 snapshots). Absent is not
 * `false`: reading it that way would report every row as whole and be
 * confidently wrong.
 */
export function selectScoredRows(results, dataset, { truncation = 'all', includeExcluded = false } = {}) {
    if (!['all', 'full', 'truncated'].includes(truncation)) {
        throw new Error(`--truncation must be one of: all, full, truncated (got "${truncation}")`);
    }

    let rows = results;
    let excludedRows = 0;
    if (!includeExcluded) {
        const excludedIds = excludedRowIds(dataset);
        const before = rows.length;
        rows = rows.filter(r => !excludedIds.has(r.entry_id));
        excludedRows = before - rows.length;
    }

    let truncatedRows = 0;
    if (truncation !== 'all') {
        const split = partitionByTruncation(rows, dataset);
        if (!split) {
            throw new Error(
                '--truncation requires a dataset carrying source_truncated; this one has none.\n' +
                'Re-extract with extract_dataset.js, or drop the flag.'
            );
        }
        const before = rows.length;
        rows = split[truncation];
        truncatedRows = before - rows.length;
    }

    return { rows, excludedRows, droppedByTruncation: truncatedRows };
}

function main() {
    const results = loadRows(RESULTS_PATH);

    if (!fs.existsSync(DATASET_PATH)) {
        console.error(`Dataset not found: ${DATASET_PATH}`);
        console.error('The row-set filters need it; pass --dataset <path>.');
        process.exit(1);
    }
    const dataset = loadRows(DATASET_PATH);

    let selection;
    try {
        selection = selectScoredRows(results, dataset, {
            truncation: TRUNCATION_FILTER,
            includeExcluded: INCLUDE_EXCLUDED,
        });
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    const { rows, excludedRows, droppedByTruncation } = selection;
    if (rows.length === 0) {
        console.error('No results left after filtering.');
        process.exit(1);
    }

    const label = TRUNCATION_FILTER === 'full'
        ? 'whole sources only — the strict set'
        : TRUNCATION_FILTER === 'truncated'
            ? 'capped sources only'
            : 'all rows';

    console.log(`\nLoaded ${results.length} results from ${path.basename(RESULTS_PATH)}`);
    if (INCLUDE_EXCLUDED) {
        console.log('Including rows marked unscoreable (--include-excluded)');
    } else {
        console.log(`Excluded ${excludedRows} results on unscoreable rows; --include-excluded to keep them`);
    }
    if (TRUNCATION_FILTER !== 'all') {
        console.log(`Filtered to "${TRUNCATION_FILTER}" sources: dropped ${droppedByTruncation} results`);
    }
    console.log(`Scoring ${rows.length} results (${label})`);

    const curves = computeRocCurvesByProvider(rows);

    console.log('\n=== ROC AUC (SUPPORTED vs. rest) ===\n');
    for (const [provider, curve] of Object.entries(curves)) {
        const aucStr = curve.auc === null ? 'n/a (single-class)' : curve.auc.toFixed(3);
        const vop = curve.verdictOperatingPoint;
        const vopStr = vop ? `  |  raw verdict: FPR ${vop.fpr.toFixed(3)}, TPR ${vop.tpr.toFixed(3)}` : '';
        console.log(`${provider}: AUC ${aucStr}  (${curve.positives} positive / ${curve.negatives} negative)${vopStr}`);
    }

    // The metadata block is the point of the wrapper: roc.json and
    // roc_strict.json are the same shape over different row sets, and a file
    // that doesn't say which one it covers invites reading a strict AUC as an
    // all-rows one.
    const metadata = {
        computed_at: todayIso(),
        results_file: path.basename(RESULTS_PATH),
        dataset_file: path.basename(DATASET_PATH),
        truncation: TRUNCATION_FILTER,
        include_excluded: INCLUDE_EXCLUDED,
        results_scored: rows.length,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ metadata, curves }, null, 2));
    console.log(`\nWrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] === __filename) {
    main();
}
