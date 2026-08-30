#!/usr/bin/env node
// Inspect individual result rows by outcome — the per-row detail behind the
// counts run_benchmark.js's printSummary (or analyze_results.js) prints.
// Joins results.json rows back to dataset.json by entry_id so you can see the
// claim, ground truth, and what the model actually said, side by side.
//
// Usage:
//   node inspect_results.js [--provider=<key>] [--status=wrong|partial|exact|error|all] [--limit=N] [--full]
//
// Examples:
//   node inspect_results.js --provider=hf-qwen3-32b
//   node inspect_results.js --provider=hf-qwen3-32b --status=partial --full
//   node inspect_results.js --status=error --limit=50

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadRows } from './io.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
function argVal(name, def) {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
}
const PROVIDER = argVal('provider', null);
const STATUS = argVal('status', 'wrong'); // exact | partial | wrong | error | all
const LIMIT = parseInt(argVal('limit', '20'), 10);
const FULL = args.includes('--full');

const DATASET_PATH = path.resolve(__dirname, argVal('dataset', 'dataset.json'));
const RESULTS_PATH = path.resolve(__dirname, argVal('results', 'results.json'));

const dataset = loadRows(DATASET_PATH);
const datasetById = new Map(dataset.map(e => [e.id, e]));
const results = loadRows(RESULTS_PATH);

let rows = results;
if (PROVIDER) rows = rows.filter(r => r.provider === PROVIDER);
if (STATUS === 'error') {
    rows = rows.filter(r => r.error);
} else if (STATUS !== 'all') {
    rows = rows.filter(r => r.correct === STATUS);
}

const truncate = (s, n = 220) => (!s ? s : (s.length > n ? s.slice(0, n) + '…' : s));

console.log(`${rows.length} row(s) matching provider=${PROVIDER ?? 'any'} status=${STATUS}\n`);

for (const r of rows.slice(0, LIMIT)) {
    const entry = datasetById.get(r.entry_id);
    const claim = entry?.claim_text ?? '(claim not found — dataset/results.json may be out of sync; see CLAUDE.md "row_id fragility")';

    console.log('─'.repeat(72));
    console.log(`${r.entry_id}  ·  ${r.provider}`);
    console.log(`  ground truth : ${r.ground_truth}`);
    console.log(`  predicted    : ${r.predicted_verdict}  (support score ${r.support_score ?? 'n/a'})`);
    if (r.error) console.log(`  error        : ${r.error}`);
    console.log(`  claim        : ${FULL ? claim : truncate(claim)}`);
    if (r.comments) console.log(`  model says   : ${FULL ? r.comments : truncate(r.comments)}`);
    if (r.source_quote) console.log(`  quote (${r.quote_status ?? '?'})  : ${FULL ? r.source_quote : truncate(r.source_quote)}`);
    if (entry?.source_url) console.log(`  source       : ${entry.source_url}`);
}
console.log('─'.repeat(72));
if (rows.length > LIMIT) {
    console.log(`\n(${rows.length - LIMIT} more not shown — raise --limit or narrow with --provider)`);
}

