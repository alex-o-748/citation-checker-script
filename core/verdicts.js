// Single source of truth for the four canonical verdict categories and
// the case/short-form conversions that the userscript, CLI, and benchmark
// pipeline each consume. Pre-consolidation, normalizeVerdict was
// reimplemented separately in run_benchmark.js, analyze_results.js,
// compare_results.js, and extract_dataset.js — each with a different
// return-value shape and a different fallback for unrecognized input.
// This module centralizes the recognition logic; callers compose it with
// the presenter that matches their downstream schema.

// Canonical UPPERCASE form. Matches the prompt's verdict spec and the
// userscript's existing inline comparisons.
export const VERDICTS = Object.freeze({
    SUPPORTED:           'SUPPORTED',
    PARTIALLY_SUPPORTED: 'PARTIALLY SUPPORTED',
    NOT_SUPPORTED:       'NOT SUPPORTED',
    SOURCE_UNAVAILABLE:  'SOURCE UNAVAILABLE',
});

// Ordered by the confidence guide in core/prompts.js. Confusion-matrix
// rows/columns in analyze_results.js iterate this list.
export const VERDICT_LIST = Object.freeze([
    VERDICTS.SUPPORTED,
    VERDICTS.PARTIALLY_SUPPORTED,
    VERDICTS.NOT_SUPPORTED,
    VERDICTS.SOURCE_UNAVAILABLE,
]);

// Map any reasonable variant ('not_supported', 'Not Supported', 'PARTIALLY',
// 'unavailable', 'partial', ...) to one of the four canonical UPPERCASE
// values. Returns null for unrecognized input — callers decide whether to
// substitute a sentinel, pass through, or treat as 'Unknown'.
export function canonicalizeVerdict(raw) {
    if (raw == null) return null;
    const v = String(raw).toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!v) return null;
    // NOT-prefix matches both 'NOT' (compare_results short code) and
    // 'NOT SUPPORTED'. Order doesn't matter for correctness here because
    // the canonical forms start with distinct letters; the ordering below
    // mirrors the historical order in run_benchmark.js for readability.
    if (v.startsWith('NOT'))     return VERDICTS.NOT_SUPPORTED;
    if (v.startsWith('PARTIAL')) return VERDICTS.PARTIALLY_SUPPORTED;
    if (v.startsWith('UNAVAIL')) return VERDICTS.SOURCE_UNAVAILABLE;
    if (v.startsWith('SOURCE'))  return VERDICTS.SOURCE_UNAVAILABLE;
    if (v.startsWith('SUPPORT')) return VERDICTS.SUPPORTED;
    return null;
}

// Presenter: canonical UPPERCASE -> title case ('Supported', 'Not supported', ...).
// Used by benchmark results.json schema and analyze_results.js's confusion matrix.
const TITLE_CASE = Object.freeze({
    [VERDICTS.SUPPORTED]:           'Supported',
    [VERDICTS.PARTIALLY_SUPPORTED]: 'Partially supported',
    [VERDICTS.NOT_SUPPORTED]:       'Not supported',
    [VERDICTS.SOURCE_UNAVAILABLE]:  'Source unavailable',
});
export function toTitleCase(canonical) {
    return TITLE_CASE[canonical] ?? canonical;
}

// Presenter: canonical UPPERCASE -> short lowercase code ('support', 'not', ...).
// Used by compare_results.js for run-vs-run comparison.
const SHORT_CODE = Object.freeze({
    [VERDICTS.SUPPORTED]:           'support',
    [VERDICTS.PARTIALLY_SUPPORTED]: 'partial',
    [VERDICTS.NOT_SUPPORTED]:       'not',
    [VERDICTS.SOURCE_UNAVAILABLE]:  'unavailable',
});
export function toShortCode(canonical) {
    return SHORT_CODE[canonical] ?? canonical;
}
