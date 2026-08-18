#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const analysisPath = path.resolve(__dirname, 'analysis.json');

if (!fs.existsSync(analysisPath)) {
    console.error('analysis.json not found. Run `npm run analyze` first.');
    process.exit(1);
}

const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));

// Print confusion matrix for each provider
for (const [providerKey, providerData] of Object.entries(analysis.providers)) {
    console.log(`\n=== Confusion Matrix for ${providerData.name} ===\n`);
    
    const matrix = providerData.metrics.confusionMatrix;
    
    // Header
    const categories = Object.keys(matrix);
    let header = 'Ground Truth \\ Predicted |';
    categories.forEach(cat => {
        header += ` ${cat.padEnd(15)} |`;
    });
    console.log(header);
    
    // Separator
    let separator = '--------------------------|';
    categories.forEach(() => {
        separator += '-----------------|';
    });
    console.log(separator);
    
    // Rows
    categories.forEach(truth => {
        let row = `${truth.padEnd(25)} |`;
        categories.forEach(pred => {
            const count = matrix[truth][pred] || 0;
            row += ` ${count.toString().padEnd(15)} |`;
        });
        console.log(row);
    });
    
    console.log('');
}