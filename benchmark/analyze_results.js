#!/usr/bin/env node
/**
 * Results Analysis Script
 *
 * Analyzes benchmark results and generates detailed metrics for each LLM provider.
 *
 * Usage: node analyze_results.js [--output report.md]
 *
 * Output:
 *   - Console summary
 *   - Markdown report (optional)
 *   - analysis.json: Detailed metrics in JSON format
 */

const fs = require('fs');
const path = require('path');

// Configuration
const RESULTS_PATH = path.join(__dirname, 'results.json');
const DATASET_PATH = path.join(__dirname, 'dataset.json');
const ANALYSIS_PATH = path.join(__dirname, 'analysis.json');

// Parse command line arguments
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const REPORT_PATH = outputIndex !== -1 ? args[outputIndex + 1] : null;

// Verdict categories for confusion matrix
const VERDICT_CATEGORIES = ['Supported', 'Partially supported', 'Not supported', 'Source unavailable'];

/**
 * Normalize verdict to standard categories
 */
function normalizeVerdict(verdict) {
    if (!verdict) return 'Unknown';
    const v = verdict.toLowerCase().trim();
    if (v.includes('not supported') || v.includes('not_supported')) return 'Not supported';
    if (v.includes('partially')) return 'Partially supported';
    if (v.includes('unavailable')) return 'Source unavailable';
    if (v.includes('supported')) return 'Supported';
    if (v.includes('error')) return 'Error';
    return 'Unknown';
}

/**
 * Calculate accuracy metrics for a set of results
 */
function calculateMetrics(results) {
    const total = results.length;
    if (total === 0) return null;

    // Filter out errors
    const validResults = results.filter(r => !r.error && r.predicted_verdict !== 'ERROR');
    const validTotal = validResults.length;

    // Exact matches
    const exactMatches = validResults.filter(r => {
        const pred = normalizeVerdict(r.predicted_verdict);
        const truth = normalizeVerdict(r.ground_truth);
        return pred === truth;
    }).length;

    // Partial matches (Supported <-> Partially supported)
    const partialMatches = validResults.filter(r => {
        const pred = normalizeVerdict(r.predicted_verdict);
        const truth = normalizeVerdict(r.ground_truth);
        if (pred === truth) return false;
        return (
            (pred === 'Supported' && truth === 'Partially supported') ||
            (pred === 'Partially supported' && truth === 'Supported')
        );
    }).length;

    // Binary accuracy (Supported/Partial vs Not supported)
    const binaryCorrect = validResults.filter(r => {
        const pred = normalizeVerdict(r.predicted_verdict);
        const truth = normalizeVerdict(r.ground_truth);
        const predPositive = pred === 'Supported' || pred === 'Partially supported';
        const truthPositive = truth === 'Supported' || truth === 'Partially supported';
        return predPositive === truthPositive;
    }).length;

    // Confusion matrix
    const confusionMatrix = {};
    VERDICT_CATEGORIES.forEach(truth => {
        confusionMatrix[truth] = {};
        VERDICT_CATEGORIES.forEach(pred => {
            confusionMatrix[truth][pred] = 0;
        });
    });

    validResults.forEach(r => {
        const pred = normalizeVerdict(r.predicted_verdict);
        const truth = normalizeVerdict(r.ground_truth);
        if (confusionMatrix[truth] && confusionMatrix[truth][pred] !== undefined) {
            confusionMatrix[truth][pred]++;
        }
    });

    // Latency stats
    const latencies = results.map(r => r.latency_ms).filter(l => l > 0);
    const avgLatency = latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;
    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

    // Confidence stats
    const confidences = validResults.map(r => r.confidence).filter(c => c > 0);
    const avgConfidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0;

    // Confidence by correctness
    const correctConfidences = validResults
        .filter(r => normalizeVerdict(r.predicted_verdict) === normalizeVerdict(r.ground_truth))
        .map(r => r.confidence);
    const wrongConfidences = validResults
        .filter(r => normalizeVerdict(r.predicted_verdict) !== normalizeVerdict(r.ground_truth))
        .map(r => r.confidence);

    const avgConfidenceCorrect = correctConfidences.length > 0
        ? correctConfidences.reduce((a, b) => a + b, 0) / correctConfidences.length
        : 0;
    const avgConfidenceWrong = wrongConfidences.length > 0
        ? wrongConfidences.reduce((a, b) => a + b, 0) / wrongConfidences.length
        : 0;

    return {
        total,
        valid: validTotal,
        errors: total - validTotal,
        exactMatches,
        partialMatches,
        exactAccuracy: validTotal > 0 ? exactMatches / validTotal : 0,
        lenientAccuracy: validTotal > 0 ? (exactMatches + partialMatches) / validTotal : 0,
        binaryAccuracy: validTotal > 0 ? binaryCorrect / validTotal : 0,
        confusionMatrix,
        latency: {
            avg: avgLatency,
            min: minLatency,
            max: maxLatency
        },
        confidence: {
            avg: avgConfidence,
            avgWhenCorrect: avgConfidenceCorrect,
            avgWhenWrong: avgConfidenceWrong,
            calibration: avgConfidenceCorrect - avgConfidenceWrong // Higher = better calibrated
        }
    };
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(analysis) {
    let md = '# Citation Verification Benchmark Results\n\n';
    md += `Generated: ${new Date().toISOString()}\n\n`;

    // Overview
    md += '## Overview\n\n';
    md += `- Total entries: ${analysis.overview.totalEntries}\n`;
    md += `- Providers tested: ${analysis.overview.providers.join(', ')}\n`;
    md += `- Total API calls: ${analysis.overview.totalCalls}\n\n`;

    // Comparison table
    md += '## Provider Comparison\n\n';
    md += '| Provider | Model | Exact Accuracy | Lenient Accuracy | Binary Accuracy | Avg Latency |\n';
    md += '|----------|-------|----------------|------------------|-----------------|-------------|\n';

    const providers = Object.keys(analysis.providers).sort((a, b) =>
        analysis.providers[b].metrics.exactAccuracy - analysis.providers[a].metrics.exactAccuracy
    );

    for (const provider of providers) {
        const data = analysis.providers[provider];
        const m = data.metrics;
        md += `| ${data.name} | ${data.model} | ${(m.exactAccuracy * 100).toFixed(1)}% | `;
        md += `${(m.lenientAccuracy * 100).toFixed(1)}% | ${(m.binaryAccuracy * 100).toFixed(1)}% | `;
        md += `${m.latency.avg.toFixed(0)}ms |\n`;
    }
    md += '\n';

    // Detailed metrics per provider
    md += '## Detailed Results\n\n';

    for (const provider of providers) {
        const data = analysis.providers[provider];
        const m = data.metrics;

        md += `### ${data.name} (${data.model})\n\n`;

        md += '**Accuracy Metrics:**\n';
        md += `- Exact match: ${m.exactMatches}/${m.valid} (${(m.exactAccuracy * 100).toFixed(1)}%)\n`;
        md += `- Lenient (includes partial): ${m.exactMatches + m.partialMatches}/${m.valid} (${(m.lenientAccuracy * 100).toFixed(1)}%)\n`;
        md += `- Binary (support vs not): ${(m.binaryAccuracy * 100).toFixed(1)}%\n`;
        md += `- Errors: ${m.errors}\n\n`;

        md += '**Latency:**\n';
        md += `- Average: ${m.latency.avg.toFixed(0)}ms\n`;
        md += `- Range: ${m.latency.min.toFixed(0)}ms - ${m.latency.max.toFixed(0)}ms\n\n`;

        md += '**Confidence Calibration:**\n';
        md += `- Average confidence: ${m.confidence.avg.toFixed(1)}\n`;
        md += `- When correct: ${m.confidence.avgWhenCorrect.toFixed(1)}\n`;
        md += `- When wrong: ${m.confidence.avgWhenWrong.toFixed(1)}\n`;
        md += `- Calibration gap: ${m.confidence.calibration.toFixed(1)} (higher = better)\n\n`;

        md += '**Confusion Matrix:**\n\n';
        md += '| Ground Truth \\ Predicted | Supported | Partial | Not Supported | Unavailable |\n';
        md += '|--------------------------|-----------|---------|---------------|-------------|\n';

        const shortNames = {
            'Supported': 'Supported',
            'Partially supported': 'Partial',
            'Not supported': 'Not Supported',
            'Source unavailable': 'Unavailable'
        };

        for (const truth of VERDICT_CATEGORIES) {
            const row = m.confusionMatrix[truth];
            md += `| ${shortNames[truth]} | ${row['Supported']} | ${row['Partially supported']} | `;
            md += `${row['Not supported']} | ${row['Source unavailable']} |\n`;
        }
        md += '\n';
    }

    // Recommendations
    md += '## Recommendations\n\n';

    const best = providers[0];
    const bestData = analysis.providers[best];

    md += `Based on the benchmark results:\n\n`;
    md += `1. **Best overall accuracy**: ${bestData.name} with ${(bestData.metrics.exactAccuracy * 100).toFixed(1)}% exact match\n`;

    const fastestProvider = providers.reduce((a, b) =>
        analysis.providers[a].metrics.latency.avg < analysis.providers[b].metrics.latency.avg ? a : b
    );
    md += `2. **Fastest response**: ${analysis.providers[fastestProvider].name} with ${analysis.providers[fastestProvider].metrics.latency.avg.toFixed(0)}ms average\n`;

    const bestCalibrated = providers.reduce((a, b) =>
        analysis.providers[a].metrics.confidence.calibration > analysis.providers[b].metrics.confidence.calibration ? a : b
    );
    md += `3. **Best calibrated**: ${analysis.providers[bestCalibrated].name} (confidence scores correlate with correctness)\n`;

    return md;
}

/**
 * Main analysis function
 */
function main() {
    console.log('=== Benchmark Results Analysis ===\n');

    // Check results exist
    if (!fs.existsSync(RESULTS_PATH)) {
        console.error(`Results not found: ${RESULTS_PATH}`);
        console.error('Run run_benchmark.js first to generate results.');
        process.exit(1);
    }

    // Load data
    const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    console.log(`Loaded ${results.length} results`);

    // Group by provider
    const byProvider = {};
    results.forEach(r => {
        if (!byProvider[r.provider]) {
            byProvider[r.provider] = [];
        }
        byProvider[r.provider].push(r);
    });

    const providers = Object.keys(byProvider);
    console.log(`Providers: ${providers.join(', ')}\n`);

    // Calculate metrics per provider
    const analysis = {
        generated: new Date().toISOString(),
        overview: {
            totalEntries: new Set(results.map(r => r.entry_id)).size,
            totalCalls: results.length,
            providers: providers
        },
        providers: {}
    };

    for (const provider of providers) {
        const providerResults = byProvider[provider];
        const metrics = calculateMetrics(providerResults);

        // Get provider info from first result
        const firstResult = providerResults[0];

        analysis.providers[provider] = {
            name: provider.charAt(0).toUpperCase() + provider.slice(1),
            model: firstResult.model,
            sampleCount: providerResults.length,
            metrics
        };

        // Print summary
        console.log(`${provider.toUpperCase()} (${firstResult.model}):`);
        console.log(`  Exact accuracy: ${(metrics.exactAccuracy * 100).toFixed(1)}%`);
        console.log(`  Lenient accuracy: ${(metrics.lenientAccuracy * 100).toFixed(1)}%`);
        console.log(`  Binary accuracy: ${(metrics.binaryAccuracy * 100).toFixed(1)}%`);
        console.log(`  Avg latency: ${metrics.latency.avg.toFixed(0)}ms`);
        console.log(`  Errors: ${metrics.errors}/${metrics.total}`);
        console.log('');
    }

    // Save analysis JSON
    fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(analysis, null, 2));
    console.log(`Analysis saved to: ${ANALYSIS_PATH}`);

    // Generate markdown report if requested
    if (REPORT_PATH) {
        const report = generateMarkdownReport(analysis);
        fs.writeFileSync(REPORT_PATH, report);
        console.log(`Report saved to: ${REPORT_PATH}`);
    }

    // Print ranking
    console.log('\n=== Ranking (by exact accuracy) ===\n');

    const ranked = providers.sort((a, b) =>
        analysis.providers[b].metrics.exactAccuracy - analysis.providers[a].metrics.exactAccuracy
    );

    ranked.forEach((provider, index) => {
        const data = analysis.providers[provider];
        console.log(`${index + 1}. ${data.name}: ${(data.metrics.exactAccuracy * 100).toFixed(1)}%`);
    });
}

// Run
main();
