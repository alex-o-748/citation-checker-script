import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeVerdict,
    verdictsEqualExact,
    verdictsEqualBinary,
    verdictsEqualLenient,
} from '../benchmark/compare_results.js';

test('normalizeVerdict canonicalizes the four verdict classes', () => {
    assert.equal(normalizeVerdict('Supported'), 'support');
    assert.equal(normalizeVerdict('Partially supported'), 'partial');
    assert.equal(normalizeVerdict('Not supported'), 'not');
    assert.equal(normalizeVerdict('Source unavailable'), 'unavailable');
    assert.equal(normalizeVerdict(' SUPPORTED '), 'support');
    assert.equal(normalizeVerdict(null), '');
    assert.equal(normalizeVerdict(undefined), '');
    assert.equal(normalizeVerdict('something else'), 'something else');
});

test('verdictsEqualExact treats normalized verdicts as equivalent', () => {
    assert.equal(verdictsEqualExact('Supported', 'supported'), true);
    assert.equal(verdictsEqualExact('Supported', 'Partially supported'), false);
    assert.equal(verdictsEqualExact('Not supported', 'NOT_SUPPORTED'), true);
});

test('verdictsEqualBinary treats Supported and Partially supported as the same class', () => {
    assert.equal(verdictsEqualBinary('Supported', 'Partially supported'), true);
    assert.equal(verdictsEqualBinary('Supported', 'Not supported'), false);
    assert.equal(verdictsEqualBinary('Source unavailable', 'Not supported'), true);
    assert.equal(verdictsEqualBinary('Partially supported', 'Source unavailable'), false);
});

test('verdictsEqualLenient: Supported↔Partially supported is a near-miss; everything else like exact', () => {
    // Exact matches are also lenient.
    assert.equal(verdictsEqualLenient('Supported', 'Supported'), true);
    assert.equal(verdictsEqualLenient('Not supported', 'Not supported'), true);
    // Supported ↔ Partially supported is mutually lenient.
    assert.equal(verdictsEqualLenient('Supported', 'Partially supported'), true);
    assert.equal(verdictsEqualLenient('Partially supported', 'Supported'), true);
    // No other pair is lenient.
    assert.equal(verdictsEqualLenient('Supported', 'Not supported'), false);
    assert.equal(verdictsEqualLenient('Partially supported', 'Not supported'), false);
    assert.equal(verdictsEqualLenient('Source unavailable', 'Not supported'), false);
});

import { indexCellsByPair } from '../benchmark/compare_results.js';

test('indexCellsByPair builds entry_id:provider Map from rows', () => {
    const rows = [
        { entry_id: 'row_1', provider: 'claude', predicted_verdict: 'Supported', error: null },
        { entry_id: 'row_1', provider: 'gemini', predicted_verdict: 'Not supported', error: null },
        { entry_id: 'row_2', provider: 'claude', predicted_verdict: 'Partially supported', error: null },
    ];
    const idx = indexCellsByPair(rows);
    assert.equal(idx.size, 3);
    assert.equal(idx.get('row_1:claude').predicted_verdict, 'Supported');
    assert.equal(idx.get('row_2:claude').predicted_verdict, 'Partially supported');
});

test('indexCellsByPair drops rows with error or predicted_verdict ERROR', () => {
    const rows = [
        { entry_id: 'row_1', provider: 'claude', predicted_verdict: 'Supported', error: null },
        { entry_id: 'row_1', provider: 'gemini', predicted_verdict: 'ERROR', error: 'rate limit' },
        { entry_id: 'row_2', provider: 'claude', predicted_verdict: 'ERROR', error: null },
        { entry_id: 'row_2', provider: 'gemini', predicted_verdict: 'Supported', error: 'timeout' },
    ];
    const idx = indexCellsByPair(rows);
    assert.equal(idx.size, 1);
    assert.equal(idx.has('row_1:claude'), true);
    assert.equal(idx.has('row_1:gemini'), false);
    assert.equal(idx.has('row_2:claude'), false);
    assert.equal(idx.has('row_2:gemini'), false);
});

import { classifyDirection } from '../benchmark/compare_results.js';

test('classifyDirection: improvement when control wrong, treatment correct', () => {
    assert.equal(
        classifyDirection({
            controlVerdict: 'Not supported',
            treatmentVerdict: 'Supported',
            groundTruth: 'Supported',
        }),
        'improvement',
    );
});

test('classifyDirection: regression when control correct, treatment wrong', () => {
    assert.equal(
        classifyDirection({
            controlVerdict: 'Supported',
            treatmentVerdict: 'Not supported',
            groundTruth: 'Supported',
        }),
        'regression',
    );
});

test('classifyDirection: unchanged-correct when both match GT', () => {
    assert.equal(
        classifyDirection({
            controlVerdict: 'Supported',
            treatmentVerdict: 'Supported',
            groundTruth: 'Supported',
        }),
        'unchanged-correct',
    );
});

test('classifyDirection: unchanged-wrong-same when both wrong with same verdict', () => {
    assert.equal(
        classifyDirection({
            controlVerdict: 'Not supported',
            treatmentVerdict: 'Not supported',
            groundTruth: 'Supported',
        }),
        'unchanged-wrong-same',
    );
});

test('classifyDirection: lateral when both wrong but with different verdicts', () => {
    assert.equal(
        classifyDirection({
            controlVerdict: 'Not supported',
            treatmentVerdict: 'Source unavailable',
            groundTruth: 'Supported',
        }),
        'lateral',
    );
});

import { computeProviderStats } from '../benchmark/compare_results.js';

test('computeProviderStats aggregates exact + lenient + binary accuracy and flip counts', () => {
    const cells = [
        // 2 unchanged-correct, 1 improvement, 1 regression, 1 lateral, plus
        // a 6th cell exercising lenient: control Supported, treatment Partially supported, GT Supported.
        // Exact: control correct, treatment wrong (Partial != Support exactly).
        // Lenient: both correct (Partial↔Support is lenient).
        // Binary: both correct.
        // Direction: regression (control correct exact, treatment wrong exact).
        { direction: 'unchanged-correct', controlVerdict: 'Supported', treatmentVerdict: 'Supported', groundTruth: 'Supported' },
        { direction: 'unchanged-correct', controlVerdict: 'Not supported', treatmentVerdict: 'Not supported', groundTruth: 'Not supported' },
        { direction: 'improvement', controlVerdict: 'Not supported', treatmentVerdict: 'Supported', groundTruth: 'Supported' },
        { direction: 'regression', controlVerdict: 'Supported', treatmentVerdict: 'Not supported', groundTruth: 'Supported' },
        { direction: 'lateral', controlVerdict: 'Not supported', treatmentVerdict: 'Source unavailable', groundTruth: 'Supported' },
        { direction: 'regression', controlVerdict: 'Supported', treatmentVerdict: 'Partially supported', groundTruth: 'Supported' },
    ];
    const stats = computeProviderStats(cells);
    assert.equal(stats.n, 6);
    // Exact: control rows 1, 2, 4, 6 = 4; treatment rows 1, 2, 3 = 3.
    assert.equal(stats.exact.control, 4);
    assert.equal(stats.exact.treatment, 3);
    // Lenient: control rows 1, 2, 4, 6 = 4; treatment rows 1, 2, 3, 6 = 4 (row 6 is Partial vs Support GT, lenient counts it).
    assert.equal(stats.lenient.control, 4);
    assert.equal(stats.lenient.treatment, 4);
    assert.equal(stats.lenient.delta, 0);
    // Binary: row 1, 2, 4, 6 control correct (4); treatment 1, 2, 3, 6 correct (4).
    assert.equal(stats.binary.control, 4);
    assert.equal(stats.binary.treatment, 4);
    // Flip counts.
    assert.equal(stats.flips.improvement, 1);
    assert.equal(stats.flips.regression, 2);
    assert.equal(stats.flips.lateral, 1);
    assert.equal(stats.flips['unchanged-correct'], 2);
    assert.equal(stats.flips['unchanged-wrong-same'], 0);
});

import { compareResults } from '../benchmark/compare_results.js';

const FIXTURE_DATASET = [
    { id: 'row_1', ground_truth: 'Supported', claim_text: 'C1', source_url: 'http://x/1', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v1' },
    { id: 'row_2', ground_truth: 'Partially supported', claim_text: 'C2', source_url: 'http://x/2', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v1' },
    { id: 'row_3', ground_truth: 'Not supported', claim_text: 'C3', source_url: 'http://x/3', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v2' },
    { id: 'row_4', ground_truth: 'Supported', claim_text: 'C4', source_url: 'http://x/4', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v2' },
    { id: 'row_5', ground_truth: 'Not supported', claim_text: 'C5', source_url: 'http://x/5', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v2' },
    { id: 'row_skip', ground_truth: 'Supported', claim_text: 'skip', source_url: 'http://x/s', extraction_status: 'complete', needs_manual_review: true, dataset_version: 'v1' },
];

const FIXTURE_CONTROL = {
    metadata: { run_at: '2026-05-01T10:00:00Z' },
    rows: [
        // mistral cells
        { entry_id: 'row_1', provider: 'mistral', predicted_verdict: 'Supported', error: null },
        { entry_id: 'row_2', provider: 'mistral', predicted_verdict: 'Supported', error: null },
        { entry_id: 'row_3', provider: 'mistral', predicted_verdict: 'Not supported', error: null },
        { entry_id: 'row_4', provider: 'mistral', predicted_verdict: 'Supported', error: null },
        { entry_id: 'row_5', provider: 'mistral', predicted_verdict: 'Supported', error: null },
        // granite cells
        { entry_id: 'row_1', provider: 'granite', predicted_verdict: 'Not supported', error: null },
        { entry_id: 'row_2', provider: 'granite', predicted_verdict: 'Not supported', error: null },
        { entry_id: 'row_3', provider: 'granite', predicted_verdict: 'Not supported', error: null },
        { entry_id: 'row_4', provider: 'granite', predicted_verdict: 'Partially supported', error: null },
        { entry_id: 'row_5', provider: 'granite', predicted_verdict: 'Partially supported', error: null },
        // a vote-3 panel cell (validates that synthesized panel rows compare like any other provider)
        { entry_id: 'row_1', provider: 'openrouter-vote-3', predicted_verdict: 'Supported', error: null },
        // an errored cell that must be filtered
        { entry_id: 'row_skip', provider: 'mistral', predicted_verdict: 'ERROR', error: 'rate limit' },
    ],
};

const FIXTURE_TREATMENT = {
    metadata: { run_at: '2026-05-02T10:00:00Z' },
    rows: [
        // mistral cells
        { entry_id: 'row_1', provider: 'mistral', predicted_verdict: 'Supported', error: null },           // unchanged-correct (GT Supported)
        { entry_id: 'row_2', provider: 'mistral', predicted_verdict: 'Partially supported', error: null }, // improvement (was Supported, now Partially supported, GT Partially supported)
        { entry_id: 'row_3', provider: 'mistral', predicted_verdict: 'Not supported', error: null },       // unchanged-correct (GT Not supported)
        { entry_id: 'row_4', provider: 'mistral', predicted_verdict: 'Supported', error: null },           // unchanged-correct (GT Supported)
        { entry_id: 'row_5', provider: 'mistral', predicted_verdict: 'Not supported', error: null },       // improvement (was Supported, now Not supported, GT Not supported)
        // granite cells
        { entry_id: 'row_1', provider: 'granite', predicted_verdict: 'Supported', error: null },           // improvement (was Not supported, GT Supported)
        { entry_id: 'row_2', provider: 'granite', predicted_verdict: 'Partially supported', error: null }, // improvement (was Not supported, GT Partially supported)
        { entry_id: 'row_3', provider: 'granite', predicted_verdict: 'Supported', error: null },           // regression (was Not supported, GT Not supported)
        { entry_id: 'row_4', provider: 'granite', predicted_verdict: 'Partially supported', error: null }, // unchanged-wrong-same (both Partially, GT Supported)
        { entry_id: 'row_5', provider: 'granite', predicted_verdict: 'Supported', error: null },           // lateral (control Partially, treatment Supported, GT Not supported)
        // panel cell
        { entry_id: 'row_1', provider: 'openrouter-vote-3', predicted_verdict: 'Supported', error: null }, // unchanged-correct
    ],
};

test('compareResults builds intersection cells, classifies, aggregates per provider', () => {
    const result = compareResults({
        control: FIXTURE_CONTROL,
        treatment: FIXTURE_TREATMENT,
        dataset: FIXTURE_DATASET,
        options: { changeAxes: ['prompt'], groundTruthVersion: 'fixture-v1' },
    });

    // Coverage: 5 valid dataset rows × 2 providers + 1 vote-3 row = 11 cells.
    // row_skip (needs_manual_review) drops out; errored cell drops out.
    assert.equal(result.coverage.datasetTotal, 6);
    assert.equal(result.coverage.datasetValid, 5);
    assert.equal(result.coverage.comparedCells, 11);

    // Metadata is recorded.
    assert.deepEqual(result.metadata.changeAxes, ['prompt']);
    assert.equal(result.metadata.groundTruthVersion, 'fixture-v1');
    assert.equal(result.metadata.controlRunAt, '2026-05-01T10:00:00Z');
    assert.equal(result.metadata.treatmentRunAt, '2026-05-02T10:00:00Z');

    // Per-provider aggregation: mistral has 5 cells, granite has 5, vote-3 has 1.
    assert.equal(result.perProvider.get('mistral').n, 5);
    assert.equal(result.perProvider.get('granite').n, 5);
    assert.equal(result.perProvider.get('openrouter-vote-3').n, 1);

    // mistral row_5: control Supported, treatment Not supported, GT Not supported → improvement
    const mistralRow5 = result.cells.find(c => c.entryId === 'row_5' && c.provider === 'mistral');
    assert.equal(mistralRow5.direction, 'improvement');

    // granite row_5: control Partially, treatment Supported, GT Not supported → both wrong, different → lateral
    const graniteRow5 = result.cells.find(c => c.entryId === 'row_5' && c.provider === 'granite');
    assert.equal(graniteRow5.direction, 'lateral');

    // Flips array contains only improvement/regression/lateral entries.
    for (const flip of result.flips) {
        assert.ok(['improvement', 'regression', 'lateral'].includes(flip.direction));
    }
});

import { filterComparison } from '../benchmark/compare_results.js';

test('filterComparison restricts cells to a predicate match and re-aggregates', () => {
    const result = compareResults({
        control: FIXTURE_CONTROL,
        treatment: FIXTURE_TREATMENT,
        dataset: FIXTURE_DATASET,
    });

    // Filter to v2 rows only.
    const v2Only = filterComparison(result, ({ datasetEntry }) =>
        datasetEntry.dataset_version === 'v2');

    // 3 v2 rows × 2 providers = 6 cells (no vote-3 cell on v2 rows in fixture).
    assert.equal(v2Only.coverage.comparedCells, 6);
    assert.equal(v2Only.metadata.filtered, true);

    // Per-provider should re-aggregate over only the v2 cells.
    assert.equal(v2Only.perProvider.get('mistral').n, 3);
    assert.equal(v2Only.perProvider.get('granite').n, 3);
    // vote-3 had no v2 cells; provider drops out entirely.
    assert.equal(v2Only.perProvider.has('openrouter-vote-3'), false);
});

test('filterComparison by provider name restricts to single-provider view', () => {
    const result = compareResults({
        control: FIXTURE_CONTROL,
        treatment: FIXTURE_TREATMENT,
        dataset: FIXTURE_DATASET,
    });
    const mistralOnly = filterComparison(result, ({ provider }) => provider === 'mistral');
    assert.equal(mistralOnly.perProvider.size, 1);
    assert.equal(mistralOnly.perProvider.get('mistral').n, 5);
});
