#!/usr/bin/env node
/**
 * Results Analysis Script
 *
 * Analyzes benchmark results and generates detailed metrics for each LLM provider.
 *
 * Usage: node analyze_results.js [--output report.md] [--version v1|v2|all]
 *                                [--projection unanimous|mixed|all]
 *                                [--results <path>] [--dataset <path>] [--analysis <path>]
 *
 * Output:
 *   - Console summary
 *   - Markdown report (optional, via --output)
 *   - analysis.json: Detailed metrics in JSON format (path overridable via --analysis)
 *
 * Reproducing the original v1 analysis from the frozen snapshots:
 *   node analyze_results.js \
 *     --results results_v1.json --dataset dataset_v1.json \
 *     --analysis analysis_v1_recomputed.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadRows } from './io.js';
import { canonicalizeVerdict, toTitleCase, VERDICT_LIST } from '../core/verdicts.js';
import { quoteExpectedFor } from '../core/quote.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
function flagValue(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}

const REPORT_PATH = flagValue('--output');
// VERSION_FILTER: 'all' | 'v1' | 'v2' | ... — limit results to entries whose
// dataset_version matches, so the original 76-row v1 metrics can be re-derived.
const VERSION_FILTER = flagValue('--version') || 'all';
// PROJECTION_FILTER: 'all' | 'unanimous' | 'mixed' — WiCE datasets only.
// Selects rows by how the claim-level label was derived from subclaim
// annotations; see docs/wice-benchmark.md.
const PROJECTION_FILTER = flagValue('--projection') || 'all';

// Configuration (paths are overridable so v1 snapshots can be re-analyzed in place)
const RESULTS_PATH = path.resolve(__dirname, flagValue('--results') || 'results.json');
const DATASET_PATH = path.resolve(__dirname, flagValue('--dataset') || 'dataset.json');
const ANALYSIS_PATH = path.resolve(__dirname, flagValue('--analysis') || 'analysis.json');

// Confusion-matrix categories — title-cased mirror of core's VERDICT_LIST.
const VERDICT_CATEGORIES = VERDICT_LIST.map(toTitleCase);

// Map any verdict-shaped value to the title-case category used in the
// confusion matrix and accuracy metrics. Inputs the shared canonicalizer
// rejects fall through to 'Error' (for the 'PARSE_ERROR' / 'ERROR'
// sentinels emitted by core/parsing.js and benchmark/run_benchmark.js's
// API-failure path) or 'Unknown' (for empty / unrecognized values).
function normalizeVerdict(verdict) {
    const canonical = canonicalizeVerdict(verdict);
    if (canonical) return toTitleCase(canonical);
    if (verdict == null || !String(verdict).trim()) return 'Unknown';
    if (String(verdict).toLowerCase().includes('error')) return 'Error';
    return 'Unknown';
}

/**
 * Calculate accuracy metrics for a set of results
 */
export function calculateMetrics(results) {
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

    // Quote fidelity: of the entries where a supporting/contradicting passage
    // should exist, how often did the model supply one, and how often was that
    // quote actually found in the source (run_benchmark.js records the check).
    // Providers that quote reliably are the ones whose rationales can be
    // trusted at a glance — and whose rows are worth keeping in the dataset.
    const quoteEligible = validResults.filter(r => quoteExpectedFor(
        canonicalizeVerdict(r.predicted_verdict),
        r.reason_type ?? null,
    ));
    const quoteOffered = quoteEligible.filter(r => r.source_quote);
    const quoteVerified = quoteOffered.filter(r => r.quote_verified);

    // Accuracy split by whether the model's quote checked out. This is the
    // evidence for a product question the UI currently answers "no": should an
    // unverifiable quote warn the editor that the verdict is less reliable?
    // A warning that says "trust this less" needs a measured gap behind it —
    // a model that paraphrases instead of copying may be judging perfectly
    // well, and scaring an editor off a correct verdict has a real cost. If
    // these two accuracies come out level, the warning stays out.
    const accuracyOf = rows => (rows.length > 0
        ? rows.filter(r => normalizeVerdict(r.predicted_verdict) === normalizeVerdict(r.ground_truth)).length / rows.length
        : 0);
    const quoteVerifiedRows = quoteOffered.filter(r => r.quote_verified);
    const quoteUnverifiedRows = quoteOffered.filter(r => !r.quote_verified);

    return {
        total,
        valid: validTotal,
        errors: total - validTotal,
        quotes: {
            eligible: quoteEligible.length,
            offered: quoteOffered.length,
            verified: quoteVerified.length,
            // Share of eligible entries that came with a quote at all.
            offerRate: quoteEligible.length > 0 ? quoteOffered.length / quoteEligible.length : 0,
            // Share of offered quotes that were found in the source verbatim.
            // A low rate here means the model is paraphrasing or inventing.
            fidelity: quoteOffered.length > 0 ? quoteVerified.length / quoteOffered.length : 0,
            // Does an unverifiable quote predict a worse verdict? Compare
            // these two. `gap` > 0 means quotes that checked out came with
            // more accurate verdicts.
            accuracyWhenQuoteVerified: accuracyOf(quoteVerifiedRows),
            accuracyWhenQuoteUnverified: accuracyOf(quoteUnverifiedRows),
            verifiedRows: quoteVerifiedRows.length,
            unverifiedRows: quoteUnverifiedRows.length,
            gap: accuracyOf(quoteVerifiedRows) - accuracyOf(quoteUnverifiedRows),
        },
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
        if (m.quotes && m.quotes.eligible > 0) {
            md += `- Quote supplied: ${m.quotes.offered}/${m.quotes.eligible} (${(m.quotes.offerRate * 100).toFixed(1)}% of verdicts that should have one)\n`;
            md += `- Quote found in source: ${m.quotes.verified}/${m.quotes.offered} (${(m.quotes.fidelity * 100).toFixed(1)}%)\n`;
            if (m.quotes.verifiedRows > 0 && m.quotes.unverifiedRows > 0) {
                md += `- Verdict accuracy when the quote checked out: ${(m.quotes.accuracyWhenQuoteVerified * 100).toFixed(1)}% (n=${m.quotes.verifiedRows})\n`;
                md += `- Verdict accuracy when it did not: ${(m.quotes.accuracyWhenQuoteUnverified * 100).toFixed(1)}% (n=${m.quotes.unverifiedRows})\n`;
                md += `  - Gap: ${(m.quotes.gap * 100).toFixed(1)} points. A gap near zero means an unverifiable quote says nothing about the verdict, and the UI is right not to warn about one.\n`;
            }
        }
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

    // Load data (loadRows handles both legacy [...rows] and new {metadata, rows} shapes)
    let results = loadRows(RESULTS_PATH);
    console.log(`Loaded ${results.length} results from ${path.basename(RESULTS_PATH)}`);

    if (VERSION_FILTER !== 'all') {
        if (!fs.existsSync(DATASET_PATH)) {
            console.error(`--version filter requires dataset at ${DATASET_PATH}; not found.`);
            process.exit(1);
        }
        const dataset = loadRows(DATASET_PATH);
        const versionById = new Map(dataset.map(e => [e.id, e.dataset_version || 'v1']));
        const before = results.length;
        results = results.filter(r => (versionById.get(r.entry_id) || 'v1') === VERSION_FILTER);
        console.log(`Filtered to dataset version "${VERSION_FILTER}": ${results.length}/${before} results`);
    }

    // WiCE-only: restrict to rows by how their claim-level label was derived.
    // WiCE annotators labeled subclaims; claim labels are projected from them,
    // and 'mixed' rows are PARTIALLY-SUPPORTED purely because the subclaims
    // disagreed — a rule that is not our rubric. Scoring the 'unanimous' subset
    // separates model error from rubric divergence. See docs/wice-benchmark.md.
    if (PROJECTION_FILTER !== 'all') {
        if (!fs.existsSync(DATASET_PATH)) {
            console.error(`--projection filter requires dataset at ${DATASET_PATH}; not found.`);
            process.exit(1);
        }
        const dataset = loadRows(DATASET_PATH);
        const projectionById = new Map(dataset.map(e => [e.id, e.wice_label_projection]));
        const before = results.length;
        results = results.filter(r => projectionById.get(r.entry_id) === PROJECTION_FILTER);
        console.log(`Filtered to label projection "${PROJECTION_FILTER}": ${results.length}/${before} results`);
        if (results.length === 0) {
            console.error('No results left. Is this a WiCE dataset? Only WiCE rows carry wice_label_projection.');
            process.exit(1);
        }
    }

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
            datasetVersion: VERSION_FILTER,
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

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] === __filename) {
    main();
}
