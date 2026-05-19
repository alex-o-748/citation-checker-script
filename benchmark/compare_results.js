import { canonicalizeVerdict, toShortCode } from '../core/verdicts.js';

/**
 * Normalize a verdict string to its canonical short form.
 * Returns one of: 'support' | 'partial' | 'not' | 'unavailable' | <other-lowercased>.
 * Handles null/undefined and case/whitespace variations.
 */
export function normalizeVerdict(v) {
    const canonical = canonicalizeVerdict(v);
    if (canonical) return toShortCode(canonical);
    return String(v ?? '').toLowerCase().trim();
}

export function verdictsEqualExact(a, b) {
    return normalizeVerdict(a) === normalizeVerdict(b);
}

function isSupportClass(v) {
    const n = normalizeVerdict(v);
    return n === 'support' || n === 'partial';
}

export function verdictsEqualBinary(a, b) {
    return isSupportClass(a) === isSupportClass(b);
}

/**
 * Lenient match: exact, plus Supported ↔ Partially supported as mutual near-misses.
 * Useful when the GT distinction between Supported and Partially supported is itself
 * fuzzy and a control→treatment shift between them shouldn't count as an error.
 */
export function verdictsEqualLenient(a, b) {
    const na = normalizeVerdict(a);
    const nb = normalizeVerdict(b);
    if (na === nb) return true;
    if ((na === 'support' && nb === 'partial') || (na === 'partial' && nb === 'support')) return true;
    return false;
}

/**
 * Index result rows by `${entry_id}:${provider}` key.
 * Drops rows where `error` is truthy or `predicted_verdict === 'ERROR'`
 * (treating either signal as "no successful prediction").
 *
 * @param {Array<Object>} rows
 * @returns {Map<string, Object>}
 */
export function indexCellsByPair(rows) {
    const out = new Map();
    for (const row of rows) {
        if (row.error) continue;
        if (row.predicted_verdict === 'ERROR') continue;
        const key = `${row.entry_id}:${row.provider}`;
        out.set(key, row);
    }
    return out;
}

/**
 * Classify a single (control, treatment, ground_truth) cell into one of:
 *   'improvement'         — control wrong, treatment correct
 *   'regression'          — control correct, treatment wrong
 *   'unchanged-correct'   — both correct
 *   'unchanged-wrong-same'— both wrong with the same (normalized) verdict
 *   'lateral'             — both wrong with different verdicts
 *
 * @param {{ controlVerdict: string, treatmentVerdict: string, groundTruth: string }} cell
 * @returns {'improvement'|'regression'|'unchanged-correct'|'unchanged-wrong-same'|'lateral'}
 */
export function classifyDirection({ controlVerdict, treatmentVerdict, groundTruth }) {
    const cCorrect = verdictsEqualExact(controlVerdict, groundTruth);
    const tCorrect = verdictsEqualExact(treatmentVerdict, groundTruth);
    if (!cCorrect && tCorrect) return 'improvement';
    if (cCorrect && !tCorrect) return 'regression';
    if (cCorrect && tCorrect) return 'unchanged-correct';
    if (normalizeVerdict(controlVerdict) === normalizeVerdict(treatmentVerdict)) {
        return 'unchanged-wrong-same';
    }
    return 'lateral';
}

function pct(num, denom) {
    return denom > 0 ? (num / denom) * 100 : 0;
}

/**
 * Aggregate stats for a list of cells belonging to one provider.
 * Returns exact + lenient + binary accuracy for control and treatment, deltas,
 * and flip counts. Lenient treats Partially supported ↔ Supported as a near-miss.
 *
 * @param {Array<{direction: string, controlVerdict: string, treatmentVerdict: string, groundTruth: string}>} cells
 */
export function computeProviderStats(cells) {
    const n = cells.length;
    let cExact = 0, tExact = 0, cLenient = 0, tLenient = 0, cBinary = 0, tBinary = 0;
    const flips = {
        improvement: 0,
        regression: 0,
        lateral: 0,
        'unchanged-correct': 0,
        'unchanged-wrong-same': 0,
    };
    for (const cell of cells) {
        if (verdictsEqualExact(cell.controlVerdict, cell.groundTruth)) cExact++;
        if (verdictsEqualExact(cell.treatmentVerdict, cell.groundTruth)) tExact++;
        if (verdictsEqualLenient(cell.controlVerdict, cell.groundTruth)) cLenient++;
        if (verdictsEqualLenient(cell.treatmentVerdict, cell.groundTruth)) tLenient++;
        if (verdictsEqualBinary(cell.controlVerdict, cell.groundTruth)) cBinary++;
        if (verdictsEqualBinary(cell.treatmentVerdict, cell.groundTruth)) tBinary++;
        flips[cell.direction]++;
    }
    return {
        n,
        exact: {
            control: cExact,
            treatment: tExact,
            controlPct: pct(cExact, n),
            treatmentPct: pct(tExact, n),
            delta: pct(tExact, n) - pct(cExact, n),
        },
        lenient: {
            control: cLenient,
            treatment: tLenient,
            controlPct: pct(cLenient, n),
            treatmentPct: pct(tLenient, n),
            delta: pct(tLenient, n) - pct(cLenient, n),
        },
        binary: {
            control: cBinary,
            treatment: tBinary,
            controlPct: pct(cBinary, n),
            treatmentPct: pct(tBinary, n),
            delta: pct(tBinary, n) - pct(cBinary, n),
        },
        flips,
    };
}

/**
 * Compare two result sets. Returns a ComparisonResult with per-cell direction
 * classification, per-provider aggregates, a flips list, and coverage metadata.
 *
 * Cells are computed on the intersection of (entry_id, provider) keys present
 * in both runs — entries dropped by either side fall out. Dataset rows that
 * are not `extraction_status === 'complete' && !needs_manual_review` also drop
 * out (matching the runner's filter).
 *
 * @param {Object} args
 * @param {{rows: Array, metadata?: Object} | Array} args.control
 * @param {{rows: Array, metadata?: Object} | Array} args.treatment
 * @param {Array} args.dataset
 * @param {Object} [args.options]
 * @param {string[]} [args.options.changeAxes] — what differs between control and treatment
 * @param {string} [args.options.groundTruthVersion] — GT label, recorded in metadata
 */
export function compareResults({ control, treatment, dataset, options = {} }) {
    const datasetById = new Map(dataset.map(row => [row.id, row]));
    const validIds = new Set(
        dataset
            .filter(r => r.extraction_status === 'complete' && !r.needs_manual_review)
            .map(r => r.id)
    );

    const controlRows = Array.isArray(control) ? control : control.rows ?? [];
    const treatmentRows = Array.isArray(treatment) ? treatment : treatment.rows ?? [];

    const controlByPair = indexCellsByPair(controlRows);
    const treatmentByPair = indexCellsByPair(treatmentRows);

    const intersectionKeys = [...controlByPair.keys()].filter(k => treatmentByPair.has(k));
    const cells = [];
    for (const key of intersectionKeys) {
        const [entryId, provider] = key.split(':');
        if (!validIds.has(entryId)) continue;
        const datasetEntry = datasetById.get(entryId);
        if (!datasetEntry) continue;

        const controlRow = controlByPair.get(key);
        const treatmentRow = treatmentByPair.get(key);
        const direction = classifyDirection({
            controlVerdict: controlRow.predicted_verdict,
            treatmentVerdict: treatmentRow.predicted_verdict,
            groundTruth: datasetEntry.ground_truth,
        });

        cells.push({
            entryId,
            provider,
            controlVerdict: controlRow.predicted_verdict,
            treatmentVerdict: treatmentRow.predicted_verdict,
            groundTruth: datasetEntry.ground_truth,
            direction,
            claimText: datasetEntry.claim_text,
            sourceUrl: datasetEntry.source_url,
            datasetEntry,
        });
    }

    const cellsByProvider = new Map();
    for (const cell of cells) {
        if (!cellsByProvider.has(cell.provider)) cellsByProvider.set(cell.provider, []);
        cellsByProvider.get(cell.provider).push(cell);
    }
    const perProvider = new Map();
    for (const [provider, providerCells] of cellsByProvider) {
        perProvider.set(provider, computeProviderStats(providerCells));
    }

    const flips = cells.filter(c =>
        c.direction === 'improvement' || c.direction === 'regression' || c.direction === 'lateral'
    );

    const controlMeta = Array.isArray(control) ? {} : (control.metadata ?? {});
    const treatmentMeta = Array.isArray(treatment) ? {} : (treatment.metadata ?? {});

    return {
        metadata: {
            controlRunAt: controlMeta.run_at ?? null,
            treatmentRunAt: treatmentMeta.run_at ?? null,
            changeAxes: options.changeAxes ?? [],
            groundTruthVersion: options.groundTruthVersion ?? null,
            generatedAt: new Date().toISOString(),
        },
        coverage: {
            datasetTotal: dataset.length,
            datasetValid: validIds.size,
            controlOnlyCells: [...controlByPair.keys()].filter(k => !treatmentByPair.has(k)).length,
            treatmentOnlyCells: [...treatmentByPair.keys()].filter(k => !controlByPair.has(k)).length,
            intersectionCells: intersectionKeys.length,
            comparedCells: cells.length,
        },
        cells,
        perProvider,
        flips,
    };
}

/**
 * Filter a ComparisonResult post-hoc, returning a new result restricted to
 * cells matching the predicate. Per-provider stats are re-aggregated over
 * the filtered cell set; providers with zero matching cells drop out.
 *
 * The original result is not mutated.
 *
 * @param {ReturnType<typeof compareResults>} result
 * @param {(cell: { entryId: string, provider: string, datasetEntry: Object, direction: string, controlVerdict: string, treatmentVerdict: string, groundTruth: string }) => boolean} predicate
 */
export function filterComparison(result, predicate) {
    const cells = result.cells.filter(predicate);
    const cellsByProvider = new Map();
    for (const cell of cells) {
        if (!cellsByProvider.has(cell.provider)) cellsByProvider.set(cell.provider, []);
        cellsByProvider.get(cell.provider).push(cell);
    }
    const perProvider = new Map();
    for (const [provider, providerCells] of cellsByProvider) {
        perProvider.set(provider, computeProviderStats(providerCells));
    }
    const flips = cells.filter(c =>
        c.direction === 'improvement' || c.direction === 'regression' || c.direction === 'lateral'
    );
    return {
        metadata: { ...result.metadata, filtered: true },
        coverage: { ...result.coverage, comparedCells: cells.length },
        cells,
        perProvider,
        flips,
    };
}
