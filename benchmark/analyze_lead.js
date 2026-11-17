#!/usr/bin/env node
/**
 * Scores run_lead_benchmark.js's results against dataset_lead.json's labels,
 * per provider. Only labeled sentences count. Positive class: anything but
 * `covered` (see lead_dataset.js).
 *
 * Usage: node analyze_lead.js [--dataset dataset_lead.json] [--results results_lead.json] [--analysis analysis_lead.json]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { scoreLeadRun } from './lead_dataset.js';
import { loadRows, writeWithMetadata, todayIso } from './io.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function analyzeLead(dataset, rows) {
    const providers = [...new Set(rows.map(r => r.provider))];
    return Object.fromEntries(providers.map(p => [p, scoreLeadRun(dataset, rows.filter(r => r.provider === p))]));
}

function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            dataset: { type: 'string', default: path.join(__dirname, 'dataset_lead.json') },
            results: { type: 'string', default: path.join(__dirname, 'results_lead.json') },
            analysis: { type: 'string', default: path.join(__dirname, 'analysis_lead.json') },
        },
    });
    const analysis = analyzeLead(loadRows(values.dataset), loadRows(values.results));
    const pct = x => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
    for (const [provider, a] of Object.entries(analysis)) {
        console.log(`${provider}: ${a.scored}/${a.labeled} labeled sentences scored (${a.unchecked} unchecked)`);
        console.log(`  exact ${pct(a.exact_accuracy)} · binary ${pct(a.binary_accuracy)} · TPR ${pct(a.tpr)} · FPR ${pct(a.fpr)} · precision ${pct(a.precision)}`);
    }
    writeWithMetadata(values.analysis, { analyzed: todayIso(), positive_class: 'not covered by the body (any label but covered)' }, analysis);
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
