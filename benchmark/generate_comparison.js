#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf-8'));

// Group by entry_id
const byEntry = {};
results.forEach(r => {
    if (!byEntry[r.entry_id]) {
        byEntry[r.entry_id] = { ground_truth: r.ground_truth };
    }
    byEntry[r.entry_id][r.provider] = r.predicted_verdict;
});

// Create CSV
const headers = ['entry_id', 'ground_truth', 'apertus-70b', 'qwen-sealion', 'olmo-32b'];
const rows = [headers.join(',')];

Object.keys(byEntry).sort().forEach(id => {
    const entry = byEntry[id];
    const row = [
        id,
        entry.ground_truth,
        entry['apertus-70b'] || '',
        entry['qwen-sealion'] || '',
        entry['olmo-32b'] || ''
    ];
    rows.push(row.map(v => '"' + v + '"').join(','));
});

const outputPath = path.join(__dirname, 'results_comparison.csv');
fs.writeFileSync(outputPath, rows.join('\n'));
console.log(`Saved to ${outputPath}`);
