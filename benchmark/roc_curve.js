#!/usr/bin/env node
/**
 * ROC Curve Script
 *
 * Computes ROC curve points + AUC per provider from a results file, using
 * the SUPPORTED-vs-rest framing in roc.js.
 *
 * Usage: node roc_curve.js [--results <path>] [--output <path>]
 *
 * Output:
 *   - Console summary (AUC per provider)
 *   - roc.json: { <provider>: { points, auc, positives, negatives } } (path overridable via --output)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadRows } from './io.js';
import { computeRocCurvesByProvider } from './roc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
function flagValue(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}

const RESULTS_PATH = path.resolve(__dirname, flagValue('--results') || 'results.json');
const OUTPUT_PATH = path.resolve(__dirname, flagValue('--output') || 'roc.json');

function main() {
    const results = loadRows(RESULTS_PATH);
    const curves = computeRocCurvesByProvider(results);

    console.log('\n=== ROC AUC (SUPPORTED vs. rest) ===\n');
    for (const [provider, curve] of Object.entries(curves)) {
        const aucStr = curve.auc === null ? 'n/a (single-class)' : curve.auc.toFixed(3);
        console.log(`${provider}: AUC ${aucStr}  (${curve.positives} positive / ${curve.negatives} negative)`);
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(curves, null, 2));
    console.log(`\nWrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] === __filename) {
    main();
}
