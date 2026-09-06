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

// Ordered by the support score guide in core/prompts.js. Confusion-matrix
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

// Supported-vs-rest equivalence: SUPPORTED must match exactly; every other
// verdict — PARTIALLY_SUPPORTED, NOT_SUPPORTED and SOURCE_UNAVAILABLE — is
// "rest", and any two of them count as equal, since all three mean the same
// thing operationally: "an editor has to go look further." This is the
// grouping docs/llm-benchmarking-overview.md's "Lenient Accuracy" section
// describes, and the one WiCE's own claim-level binary task uses (see
// docs/wice-benchmark.md) — SUPPORTED vs. everything else.
//
// SOURCE_UNAVAILABLE used to be excluded from that "rest" bucket and required
// to match exactly, which made this metric mean something other than its name
// and its own doc comment claimed. No dataset ground truth carries
// SOURCE_UNAVAILABLE — `Benchmarking_data_Citations.csv` labels only the other
// three — so "must match exactly" meant a SOURCE_UNAVAILABLE prediction could
// never be scored right *in any row*, and the metric silently became "did the
// model avoid saying 'source unavailable', and also get the supported/problem
// split right." That penalized exactly the models that correctly detect an
// unusable source, which matters here because a substantial share of
// dataset.json's rows are truncated at the fetch cap or contain nothing but
// Internet Archive page chrome. Measured on the 2026-09 run, folding
// SOURCE_UNAVAILABLE into "rest" moved liftwing-qwen3.6-27b from 60.4% to
// 78.6% and claude-sonnet-4-5 from 54.8% to 74.2%, while every provider that
// rarely emits the verdict moved under a point — i.e. the old number was
// mostly measuring willingness to commit to a verdict, not accuracy.
//
// Note this is deliberately *not* symmetric with the confusion matrix or with
// exactAccuracy, both of which still treat SOURCE_UNAVAILABLE as its own
// fourth class. Distinguishing "unreadable source" from "source contradicts
// the claim" is real signal worth keeping — it just isn't the distinction
// *this* metric exists to draw.
//
// Defined here, exported, rather than inline in analyze_results.js (its only
// current caller): this exact grouping was hand-computed into that doc on
// 2026-01-23 and never implemented in the benchmark scripts, so for months
// the doc and the code disagreed under the same metric name ("Lenient
// Accuracy") without anyone noticing — see analyze_results.js's
// `lenientAccuracy` field, which forgives the *opposite* pair (SUPPORTED <->
// PARTIALLY). Keeping the definition here, rather than as a private helper in
// the script that happens to use it first, means a second caller (e.g.
// compare_results.js, if it ever wants this grouping) imports the same
// predicate instead of writing a fresh version that could quietly diverge
// from either the doc or this one.
export function equalSupportedVsRest(a, b) {
    const ca = canonicalizeVerdict(a);
    const cb = canonicalizeVerdict(b);
    if (ca === null || cb === null) return false;
    if (ca === cb) return true;
    const isProblem = v => v === VERDICTS.PARTIALLY_SUPPORTED
        || v === VERDICTS.NOT_SUPPORTED
        || v === VERDICTS.SOURCE_UNAVAILABLE;
    return isProblem(ca) && isProblem(cb);
}
